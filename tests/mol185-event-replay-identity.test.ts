import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptRequestContract, chatGptTurnExecutionKey, chatGptTurnRoundKey } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";
import type { CodexProviderConfig } from "../src/types";

// Offline only: all physical browser work is replaced before adapter construction.
// These requests exercise parsing, registry attachment, journal replay, and Responses SSE.
function body(id = randomUUID()) {
  return {
    model: "chatgpt-web/high", stream: true, store: false,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread_${id}`, turn_id: `turn_${id}` }),
    },
    input: [{
      type: "message", role: "user", id: "msg_stable",
      content: [{ type: "input_text", text: "Inspect the project" }],
      internal_chat_message_metadata_passthrough: { turn_id: `turn_${id}` },
    }],
  };
}

function reorderedMessage(request: ReturnType<typeof body>) {
  const copy = structuredClone(request);
  const message = copy.input[0]!;
  copy.input[0] = {
    content: message.content, id: message.id, role: message.role, type: message.type,
    internal_chat_message_metadata_passthrough: message.internal_chat_message_metadata_passthrough,
  };
  return copy;
}

const request = (payload: unknown) => new Request("http://127.0.0.1/v1/responses", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
});

for (const mutation of ["identical", "message-property-order"] as const) {
  for (const settlement of ["in-flight", "offline-completed"] as const) {
    test(`MOL-185 ${mutation} SSE reconnect recovers the complete ${settlement} response`, async () => {
      const id = randomUUID();
      const provider: CodexProviderConfig = {
        adapter: "chatgpt-web", baseUrl: `browser://mol185-round-replay-${id}`,
        chatgptWeb: {
          localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
          threadEnvironmentStatePath: join(tmpdir(), `mol185-round-${id}`, "environment.json"),
          conversationStoreDirectory: join(tmpdir(), `mol185-round-${id}`, "conversations"),
        },
      };
      const worker = ChatGptBrowserWorker.forProvider(provider);
      const originalRun = worker.run;
      let starts = 0;
      let sends = 0;
      let finish: (() => void) | undefined;
      let finished = false;
      const signals: AbortSignal[] = [];
      worker.run = turn => {
        starts += 1;
        sends += 1;
        if (turn.abortSignal) signals.push(turn.abortSignal);
        turn.onSendActivated?.();
        turn.onSubmitted?.();
        turn.onTextDelta("Retained prefix. ");
        return new Promise(resolve => {
          finish = () => {
            if (finished) return;
            finished = true;
            turn.onTextDelta("Recovered suffix.");
            resolve("Retained prefix. Recovered suffix.");
          };
        });
      };
      const firstBody = body(id);
      const secondBody = mutation === "identical" ? structuredClone(firstBody) : reorderedMessage(firstBody);
      const adapter = createChatGptWebAdapter(provider);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        expect(chatGptTurnExecutionKey(parseRequest(firstBody))).toBe(chatGptTurnExecutionKey(parseRequest(secondBody)));
        const first = await responseRequest(request(firstBody), defaultConfig("browser-only"), () => adapter);
        expect(first.status).toBe(200);
        reader = first.body!.getReader();
        const decoder = new TextDecoder();
        let prefix = "";
        while (!prefix.includes('"delta":"Retained prefix. "')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("The first SSE response ended before its prefix");
          prefix += decoder.decode(chunk.value, { stream: true });
        }
        await reader.cancel("synthetic client disconnect");
        expect(signals.every(signal => !signal.aborted)).toBe(true);
        if (settlement === "offline-completed") {
          finish!();
          await Bun.sleep(0);
        }
        const reconnectStarted = performance.now();
        const reconnect = await responseRequest(request(secondBody), defaultConfig("browser-only"), () => adapter);
        const wire = reconnect.text();
        await Bun.sleep(0);
        finish!();
        const completedWire = await wire;
        const recoveryMs = performance.now() - reconnectStarted;
        const events = completedWire.split("\n")
          .filter(line => line.startsWith("data: {"))
          .map(line => JSON.parse(line.slice(6)));
        const text = events.filter(event => event.type === "response.output_text.delta")
          .map(event => event.delta).join("");
        // Time to the complete replacement SSE body containing its authoritative terminal.
        console.info("MOL185_ROUND_REPLAY", JSON.stringify({ mutation, settlement, starts, sends, text, recoveryMs }));
        expect(starts).toBe(1);
        expect(sends).toBe(1);
        expect(text).toBe("Retained prefix. Recovered suffix.");
        expect(events.filter(event => event.type === "response.completed")).toHaveLength(1);
        expect(events.some(event => event.type === "response.failed" || event.type === "response.incomplete")).toBe(false);
        expect(events.find(event => event.type === "response.completed").response.output
          .flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? [])
          .map((part: { text?: string }) => part.text ?? "").join(""))
          .toBe("Retained prefix. Recovered suffix.");
      } finally {
        await reader?.cancel();
        finish?.();
        worker.run = originalRun;
      }
    });
  }
}

test("MOL-185 round identity treats JSON object properties as unordered without mutating input", () => {
  const first = body();
  const second = reorderedMessage(first);
  const before = JSON.stringify(second);
  expect(chatGptTurnRoundKey(parseRequest(first))).toBe(chatGptTurnRoundKey(parseRequest(second)));
  expect(JSON.stringify(second)).toBe(before);

  const withResult = { ...first, input: [...first.input, {
    type: "function_call_output", call_id: "call_1",
    output: [{ type: "input_text", text: "exact tool result", metadata: { alpha: 1, beta: 2 } }],
  }] };
  const reorderedResult = { ...second, input: [...second.input, {
    output: [{ metadata: { beta: 2, alpha: 1 }, text: "exact tool result", type: "input_text" }],
    call_id: "call_1", type: "function_call_output",
  }] };
  expect(chatGptTurnExecutionKey(parseRequest(withResult))).toBe(chatGptTurnExecutionKey(parseRequest(reorderedResult)));
  expect(chatGptTurnRoundKey(parseRequest(withResult))).toBe(chatGptTurnRoundKey(parseRequest(reorderedResult)));
});

test("MOL-185 round identity retains array order, exact strings, values, and native identity", () => {
  const original = body();
  const baseline = { ...original, input: [...original.input,
    { type: "function_call_output", call_id: "call_1", output: '{"a":1,"b":2}' },
    { type: "function_call_output", call_id: "call_2", output: "second result" },
  ] };
  const key = chatGptTurnRoundKey(parseRequest(baseline));
  const variants = [
    { ...baseline, input: [baseline.input[0], baseline.input[2], baseline.input[1]] },
    { ...baseline, input: [baseline.input[0], { ...baseline.input[1], output: '{"b":2,"a":1}' }, baseline.input[2]] },
    { ...baseline, input: [baseline.input[0], { ...baseline.input[1], output: "changed result" }, baseline.input[2]] },
    { ...baseline, input: [{ ...original.input[0], content: [{ type: "input_text", text: "Changed instruction" }] }, ...baseline.input.slice(1)] },
    { ...baseline, input: [{ ...original.input[0], id: "msg_changed" }, ...baseline.input.slice(1)] },
    { ...baseline, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_other", turn_id: "turn_other" }) } },
  ];
  for (const variant of variants) expect(chatGptTurnRoundKey(parseRequest(variant))).not.toBe(key);
});

test("MOL-201 model and reasoning changes preserve logical identity but conflict with the bound contract", () => {
  const original = body();
  const baseline = parseRequest(original);
  const contract = chatGptRequestContract(baseline);
  // Controls must not create a fresh execution/round that could bypass conflict checking.
  // The actual routed adapter rejection and active observer are covered in chatgpt-request-contract.
  for (const controls of [{ model: "different-model" }, { reasoning: { effort: "low" } }]) {
    const changed = parseRequest({ ...original, ...controls });
    const changedContract = chatGptRequestContract(changed);
    expect(chatGptTurnExecutionKey(changed)).toBe(chatGptTurnExecutionKey(baseline));
    expect(chatGptTurnRoundKey(changed)).toBe(contract.round);
    expect(changedContract.execution).not.toBe(contract.execution);
    expect(changedContract.request).not.toBe(contract.request);
  }
});
