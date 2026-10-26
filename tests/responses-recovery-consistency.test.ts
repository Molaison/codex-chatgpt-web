import { expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { scrubBridgeArtifactsForNative } from "../src/native-passthrough";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { responseRequest, routeChatGptWebRequest } from "../src/server";
import type { AdapterEvent } from "../src/types";

const replayIdentity = "a".repeat(32);

test("a non-streaming response collects a large synchronous generation without a consumer backlog", async () => {
  const response = await responseRequest(new Request("http://localhost/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "chatgpt-web/high", input: "Long answer", stream: false }),
  }), defaultConfig("browser-only"), () => ({ name: "large-response-fixture", async runTurn(_parsed, _request, emit) {
    for (let index = 0; index < 20_000; index++) emit({ type: "text_delta", text: "x" });
    emit({ type: "done", endTurn: true });
  } }), { rememberState: false });
  const result = await response.json();
  expect(result.status).toBe("completed");
  expect(result.output[0].content[0].text).toBe("x".repeat(20_000));
});

test("streaming a large durable replay preserves text, item boundaries and a single terminal", async () => {
  const response = await responseRequest(new Request("http://localhost/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "chatgpt-web/high", input: "Replay", stream: true }),
  }), defaultConfig("browser-only"), () => ({ name: "large-replay-fixture", async runTurn(_parsed, _request, emit) {
    for (const phase of ["commentary", "final_answer"] as const) {
      emit({ type: "assistant_boundary" });
      for (let index = 0; index < 20_000; index++) emit({ type: "text_delta", text: phase === "commentary" ? "c" : "f", phase });
    }
    emit({ type: "done", endTurn: true });
  } }), { rememberState: false });
  const wire = await response.text();
  const frames = wire.split("\n\n").filter(frame => frame.startsWith("event: response.completed\n"));
  expect(frames).toHaveLength(1);
  const result = JSON.parse(frames[0]!.split("\ndata: ")[1]!).response;
  expect(result.output.map((item: { phase: string; content: Array<{ text: string }> }) => [item.phase, item.content[0]!.text]))
    .toEqual([["commentary", "c".repeat(20_000)], ["final_answer", "f".repeat(20_000)]]);
  expect(wire).not.toContain("adapter_eof");
});

test("an unmergeable stream backlog ends in a controlled failure without a secondary rejection", async () => {
  const response = await responseRequest(new Request("http://localhost/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "chatgpt-web/high", input: "Replay", stream: true }),
  }), defaultConfig("browser-only"), () => ({ name: "bounded-backlog-fixture", async runTurn(_parsed, _request, emit) {
    for (let index = 0; index < 10_002; index++) emit({ type: "assistant_boundary" });
    emit({ type: "done", endTurn: true });
  } }), { rememberState: false });
  const wire = await response.text();
  expect(wire.match(/event: response.failed\n/g)).toHaveLength(1);
  expect(wire).toContain("Adapter event backlog exceeded");
  expect(wire).not.toContain("event: response.completed");
  expect(wire).not.toContain("adapter_eof");
});

test("late capacity callbacks cannot change the HTTP status of the first terminal response", async () => {
  for (const terminal of ["done", "incomplete", "error"] as const) {
    const observed: AdapterEvent[] = [];
    const response = await responseRequest(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "chatgpt-web/high", input: "Answer", stream: false }),
    }), defaultConfig("browser-only"), () => ({ name: "terminal-fixture", async runTurn(_parsed, _request, emit) {
      emit({ type: "text_delta", text: "Original answer" });
      emit(terminal === "done" ? { type: terminal, endTurn: true }
        : terminal === "incomplete" ? { type: terminal, reason: "original_incomplete" }
          : { type: terminal, message: "original failure", code: "original_failure" });
      emit({ type: "error", message: "late capacity callback", code: "concurrency_limit_exceeded" });
    } }), { rememberState: false, onAdapterEvent: event => observed.push(event) });
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe(terminal === "done" ? "completed" : terminal === "error" ? "failed" : "incomplete");
    expect(observed).toHaveLength(2);
  }
});

test("pool session mode is resolved before saved-chat alias and adapter admission", () => {
  for (const mode of ["temporary", "persistent"] as const) {
    const parsed = parseRequest({ model: "chatgpt-web/high", input: "Question",
      client_metadata: { _chatgpt_session_mode: mode } });
    routeChatGptWebRequest(parsed, defaultConfig("browser-only"));
    expect(parsed._chatgptSessionMode).toBe(mode);
  }
});

test("conflicting and invalid session modes cannot silently turn a temporary request into a saved chat", () => {
  const config = defaultConfig("full");
  const invalid = parseRequest({ model: "chatgpt-web/high", input: "Question",
    client_metadata: { _chatgpt_session_mode: "invalid" } });
  expect(() => routeChatGptWebRequest(invalid, defaultConfig("browser-only"))).toThrow("must be temporary or persistent");
  const full = parseRequest({ model: "chatgpt-web/gpt-6-chat-persist", input: "Question",
    reasoning: { effort: "high" }, client_metadata: { _chatgpt_session_mode: "temporary" } });
  routeChatGptWebRequest(full, config);
  expect(full._chatgptSessionMode).toBe("persistent");
  for (const [selector, suffix] of [["persist", "temporary"], ["temp", "persistent"]]) {
    const parsed = parseRequest({ model: `chatgpt-web/gpt-6-chat-${selector}`, input: "Question",
      reasoning: { effort: `high-${suffix}` } });
    expect(() => routeChatGptWebRequest(parsed, config)).toThrow("conflicts with");
  }
});

async function streamedResponse(events: AdapterEvent[], compaction = false): Promise<Record<string, any>> {
  async function* source() { yield* events; }
  const stream = bridgeToResponsesSSE(source(), "chatgpt-web/test", undefined, undefined, undefined,
    undefined, 2_000, { replayIdentity, compaction });
  const frames = (await new Response(stream).text()).split("\n\n");
  const terminal = frames.find(frame => /^event: response\.(completed|incomplete|failed)\n/.test(frame));
  expect(terminal).toBeDefined();
  return JSON.parse(terminal!.split("\ndata: ")[1]!).response;
}

test.each(["max_tokens", "content_filter"])("%s never becomes completed JSON or a replacement compaction", async stopReason => {
  const events: AdapterEvent[] = [
    { type: "text_delta", text: "partial checkpoint" },
    { type: "done", stopReason, endTurn: true },
  ];
  for (const compaction of [false, true]) {
    const json = buildResponseJSON(events, "chatgpt-web/test", { replayIdentity, compaction });
    const sse = await streamedResponse(events, compaction);
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual(sse.incomplete_details);
    if (compaction) {
      expect(json.output).toEqual([]);
      expect(sse.output).toEqual([]);
    }
  }
});

test("compaction ignores reasoning and preserves the same replay item identity on JSON and SSE", async () => {
  const events: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "private progress" },
    { type: "text_delta", text: "authoritative checkpoint" },
    { type: "done", endTurn: true },
  ];
  const json = buildResponseJSON(events, "chatgpt-web/test", { replayIdentity, compaction: true });
  const sse = await streamedResponse(events, true);
  expect(json.output).toEqual(sse.output);
  expect(json.output).toHaveLength(1);
});

test("JSON and SSE retain the same generated chart without turning notices into answer text", async () => {
  const widget = {
    version: 1 as const, kind: "pie_chart" as const, id: "chart-1", title: "Counts",
    labelField: "group", valueField: "count", slices: [{ label: "A", value: 2 }],
  };
  const events: AdapterEvent[] = [
    { type: "provider_notice", notice: {
      version: 1, id: "notice-1", execution_id: replayIdentity, seq: 1, kind: "resumed",
      observed_at: new Date(0).toISOString(), message: "Recovered the original result",
      source: "chatgpt-web", evidence: "observed",
    } },
    { type: "rich_widget", widget },
    { type: "text_delta", text: "Here is the chart." },
    { type: "done", endTurn: true },
  ];
  const json = buildResponseJSON(events, "chatgpt-web/test", { replayIdentity });
  const sse = await streamedResponse(events);
  expect(json.rich_widgets).toEqual(sse.rich_widgets);
  expect(json.rich_widgets).toEqual([widget]);
  expect(JSON.stringify(json.output)).not.toContain("Recovered");
});

test("JSON stops at the first terminal event just like the streaming bridge", async () => {
  const events: AdapterEvent[] = [
    { type: "text_delta", text: "Complete answer" },
    { type: "done", endTurn: true },
    { type: "text_delta", text: "late stale callback" },
    { type: "error", message: "late cleanup failure" },
  ];
  const json = buildResponseJSON(events, "chatgpt-web/test", { replayIdentity });
  const sse = await streamedResponse(events);
  expect(json.status).toBe(sse.status);
  expect(json.output).toEqual(sse.output);
});

test.each(["reasoning", "message"])("native continuation strips stable local %s IDs without dropping content", type => {
  const item = type === "reasoning"
    ? { type, id: `rs_${replayIdentity}_0`, summary: [{ type: "summary_text", text: "Checked" }] }
    : { type, id: `msg_${replayIdentity}_0`, role: "assistant", content: [{ type: "output_text", text: "Answer" }] };
  const request = { model: "native", previous_response_id: `resp_${replayIdentity}`, input: [item] };
  const scrubbed = scrubBridgeArtifactsForNative(request);
  expect(scrubbed.changed).toBe(true);
  expect(scrubbed.value).toEqual({ model: "native", input: [{ ...item, id: undefined }] });
  expect(request.input[0]).toHaveProperty("id");
});
