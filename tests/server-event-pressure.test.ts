import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

function request(stream: boolean): Request {
  return new Request("http://127.0.0.1/v1/responses", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-luna", input: "controlled adapter output", stream }),
  });
}

test("non-streaming output is consumed while an asynchronous adapter is still producing", async () => {
  const response = await responseRequest(request(false), { ...defaultConfig("browser-only"), solAvailable: false }, () => ({
    name: "long-asynchronous-output", async runTurn(_parsed, _incoming, emit) {
      for (let n = 0; n < 10001; n++) {
        emit({ type: "text_delta", text: "x", phase: "final_answer" });
        await Promise.resolve();
      }
      emit({ type: "done", endTurn: true });
    },
  }));
  const body = await response.json() as any;
  expect(body).toMatchObject({ status: "completed" });
  expect(body.output[0].content[0].text).toBe("x".repeat(10001));
});

function frames(text: string): any[] {
  return text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
}

for (const stream of [false, true]) {
  test(`synchronous replay overflow has one explicit failure, stream=${stream}`, async () => {
    const response = await responseRequest(request(stream), { ...defaultConfig("browser-only"), solAvailable: false }, () => ({
      name: "bounded-synchronous-replay", async runTurn(_parsed, _incoming, emit) {
        for (let n = 0; n < 10001; n++) emit({ type: "text_delta", text: "x", phase: "final_answer" });
        emit({ type: "done", endTurn: true });
      },
    }));
    if (stream) {
      const text = await response.text();
      const terminals = frames(text).filter(event => ["response.completed", "response.failed", "response.incomplete"].includes(event.type));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ type: "response.failed", response: {
        status: "failed", error: { code: "adapter_event_backlog_exceeded" }, retryable: false,
      } });
      expect(text.split("data: [DONE]")).toHaveLength(2);
    } else {
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ status: "failed", error: {
        code: "adapter_event_backlog_exceeded",
      }, retryable: false });
    }
  });

  test(`an observer throwing on output and failure cannot reject the producer, stream=${stream}`, async () => {
    const observed: string[] = [];
    const response = await responseRequest(request(stream), { ...defaultConfig("browser-only"), solAvailable: false }, () => ({
      name: "throwing-observer", async runTurn(_parsed, _incoming, emit) {
        emit({ type: "text_delta", text: "not delivered" });
        emit({ type: "done", endTurn: true });
      },
    }), { onAdapterEvent(event) { observed.push(event.type); throw new Error("observer failed"); } });
    const text = await response.text();
    const result = stream ? frames(text).find(event => event.type === "response.failed")?.response : JSON.parse(text);
    expect(result).toMatchObject({ status: "failed", error: { message: "observer failed" } });
    expect(observed).toEqual(["text_delta", "error"]);
    if (stream) expect(frames(text).filter(event => event.type.startsWith("response.") && ["completed", "failed", "incomplete"].includes(event.response?.status))).toHaveLength(1);
  });
}

test("normal streamed output still completes once", async () => {
  const response = await responseRequest(request(true), { ...defaultConfig("browser-only"), solAvailable: false }, () => ({
    name: "normal-stream", async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "hello", phase: "final_answer" });
      emit({ type: "done", endTurn: true });
    },
  }));
  const records = frames(await response.text());
  const terminals = records.filter(event => ["response.completed", "response.failed", "response.incomplete"].includes(event.type));
  expect(terminals).toHaveLength(1);
  expect(terminals[0].response).toMatchObject({ status: "completed", output: [{ content: [{ text: "hello" }] }] });
});

test("a later adapter failure preserves already delivered text without completing it", async () => {
  let rejectProducer!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectProducer = reject; });
  const response = await responseRequest(request(true), { ...defaultConfig("browser-only"), solAvailable: false }, () => ({
    name: "partial-then-failure", async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "partial", phase: "final_answer" });
      await pending;
    },
  }));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes('"delta":"partial"')) {
      const next = await reader.read();
      if (next.done) throw new Error("stream ended before partial output");
      text += decoder.decode(next.value);
    }
    rejectProducer(new Error("adapter stopped after partial output"));
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value);
    }
    const terminals = frames(text).filter(event => ["response.completed", "response.failed", "response.incomplete"].includes(event.type));
    expect(terminals).toHaveLength(1);
    expect(terminals[0].response).toMatchObject({ status: "failed", output: [{ content: [{ text: "partial" }] }] });
  } finally { rejectProducer(new Error("test cleanup")); await reader.cancel(); reader.releaseLock(); }
});
