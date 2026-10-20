import { expect, spyOn, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptInstructionLineage, chatGptTurnExecutionKey, chatGptTurnRoundKey } from "../src/adapters/chatgpt-web/turn-execution";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function requestBody() {
  const id = crypto.randomUUID();
  return {
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    instructions: "Return the requested object.",
    prompt_cache_key: `thread_${id}`,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread_${id}`, turn_id: `turn_${id}` }),
    },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Return it." }],
      internal_chat_message_metadata_passthrough: { turn_id: `turn_${id}` },
    }],
    tools: [{ type: "function", name: "inspect", description: "Inspect a file", parameters: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"],
    } }],
    tool_choice: "auto",
    text: { format: {
      type: "json_schema", name: "payload", strict: true,
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    } },
  };
}

async function withAdapter(testCase: (
  run: (request: CodexParsedRequest) => Promise<AdapterEvent[]>,
  starts: () => number,
) => Promise<void>) {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://request-contract-${crypto.randomUUID()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const browser = spyOn(worker, "run").mockImplementation(async turn => {
    turn.onTextDelta('{"ok":true}');
    return '{"ok":true}';
  });
  const adapter = createChatGptWebAdapter(provider);
  try {
    await testCase(async request => {
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(request, { headers: new Headers() }, event => events.push(event));
      return events;
    }, () => browser.mock.calls.length);
  } finally {
    browser.mockRestore();
  }
}

test("logical execution and round identity ignore schema object property order", () => {
  const body = requestBody();
  const reordered = structuredClone(body);
  const schema = body.text.format.schema;
  reordered.text.format.schema = {
    additionalProperties: schema.additionalProperties,
    required: schema.required,
    properties: schema.properties,
    type: schema.type,
  };
  const first = parseRequest(body);
  const second = parseRequest(reordered);
  expect(chatGptTurnExecutionKey(first)).toBe(chatGptTurnExecutionKey(second));
  expect(chatGptTurnRoundKey(first)).toBe(chatGptTurnRoundKey(second));
});

test("equivalent canonical schema and tool objects replay one browser execution", async () => {
  const body = requestBody();
  const retry = structuredClone(body);
  retry.text.format.schema = {
    additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } }, type: "object",
  };
  retry.tools[0]!.parameters = {
    required: ["path"], properties: { path: { type: "string" } }, type: "object",
  };
  await withAdapter(async (run, starts) => {
    const first = await run(parseRequest(body));
    const replay = await run(parseRequest(retry));
    expect(first.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(replay).toEqual(first);
    expect(starts()).toBe(1);
  });
});

for (const field of ["output schema", "tool schema", "tool choice", "instructions", "reasoning", "model family"] as const) {
  test(`changed ${field} on an exact request fails before replay or another Send`, async () => {
    const body = requestBody();
    const retry: Record<string, unknown> = structuredClone(body);
    if (field === "output schema") retry.text = { format: { ...body.text.format, name: "changed_payload" } };
    if (field === "tool schema") retry.tools = [{ ...body.tools[0], parameters: { type: "object", properties: {} } }];
    if (field === "tool choice") retry.tool_choice = "none";
    if (field === "instructions") retry.instructions = "Use different instructions.";
    if (field === "reasoning") retry.reasoning = { effort: "high" };
    const changed = parseRequest(retry);
    if (field === "model family") changed._chatgptModelFamily = "6";
    await withAdapter(async (run, starts) => {
      expect((await run(parseRequest(body))).at(-1)).toMatchObject({ type: "done" });
      await expect(run(changed)).rejects.toMatchObject({
        status: 409, code: "request_contract_conflict", retryable: false,
      });
      expect(starts()).toBe(1);
    });
  });
}

test("a new input round may discover tools without starting another browser execution", async () => {
  const body = requestBody();
  const next = {
    ...body,
    input: [
      ...body.input,
      { type: "tool_search_call", call_id: "search_1", arguments: { query: "discovered" } },
      { type: "tool_search_output", call_id: "search_1", tools: [{
        type: "function", name: "discovered", parameters: { type: "object" },
      }] },
    ],
  };
  await withAdapter(async (run, starts) => {
    expect((await run(parseRequest(body))).at(-1)).toMatchObject({ type: "done" });
    expect((await run(parseRequest(next))).at(-1)).toMatchObject({ type: "done" });
    expect(starts()).toBe(1);
  });
});

test("changed Responses Lite tool declarations conflict within the same input round", async () => {
  const body = requestBody();
  const lite = { ...body, tools: undefined, input: [{ type: "additional_tools", tools: body.tools }, ...body.input] };
  const changed = {
    ...lite,
    input: [{ type: "additional_tools", tools: [{ ...body.tools[0], parameters: { type: "object", properties: {} } }] }, ...body.input],
  };
  await withAdapter(async (run, starts) => {
    expect((await run(parseRequest(lite))).at(-1)).toMatchObject({ type: "done" });
    await expect(run(parseRequest(changed))).rejects.toMatchObject({ code: "request_contract_conflict" });
    expect(starts()).toBe(1);
  });
});

test("changed developer instructions cannot replay an answer for the same user request", async () => {
  const body = requestBody();
  const first = { ...body, input: [
    { type: "message", role: "developer", content: "Inspect the repository without making edits." },
    ...body.input,
  ] };
  const changed = { ...body, input: [
    { type: "message", role: "developer", content: "Return only the requested audit findings." },
    ...body.input,
  ] };
  await withAdapter(async (run, starts) => {
    expect((await run(parseRequest(first))).at(-1)).toMatchObject({ type: "done" });
    await expect(run(parseRequest(changed))).rejects.toMatchObject({
      status: 409, code: "request_contract_conflict", retryable: false,
    });
    expect(starts()).toBe(1);
  });
});

test("unchanged developer instructions permit a tool-result follow-up", async () => {
  const body = requestBody();
  const first = { ...body, input: [
    { type: "message", role: "developer", content: "Inspect the repository without making edits." },
    ...body.input,
  ] };
  const continuation = { ...first, input: [
    ...first.input,
    { type: "function_call", call_id: "inspect_1", name: "inspect", arguments: '{"path":"readme"}' },
    { type: "function_call_output", call_id: "inspect_1", output: "file contents" },
  ] };
  await withAdapter(async (run, starts) => {
    expect((await run(parseRequest(first))).at(-1)).toMatchObject({ type: "done" });
    expect((await run(parseRequest(continuation))).at(-1)).toMatchObject({ type: "done" });
    expect(starts()).toBe(1);
  });
});

test("bound developer instructions permit a new user steering revision", async () => {
  const body = requestBody();
  const first = { ...body, input: [
    { type: "message", role: "developer", content: "Inspect the repository without making edits." },
    ...body.input,
  ] };
  const steered = { ...first, input: [
    ...first.input,
    { ...body.input[0], content: [{ type: "input_text", text: "Inspect only the tests instead." }] },
  ] };
  await withAdapter(async (run, starts) => {
    expect((await run(parseRequest(first))).at(-1)).toMatchObject({ type: "done" });
    expect((await run(parseRequest(steered))).at(-1)).toMatchObject({ type: "done" });
    expect(starts()).toBe(2);
  });
});

test("canonical input property order preserves execution identity and steering lineage", () => {
  const body = requestBody();
  const reordered = structuredClone(body);
  reordered.input[0]!.content = [{ text: "Return it.", type: "input_text" }];
  const original = parseRequest(body);
  const equivalent = parseRequest(reordered);
  expect(chatGptTurnExecutionKey(equivalent)).toBe(chatGptTurnExecutionKey(original));
  expect(chatGptTurnRoundKey(equivalent)).toBe(chatGptTurnRoundKey(original));
  const steered = parseRequest({
    ...reordered,
    input: [...reordered.input, { ...reordered.input[0], content: [{ type: "input_text", text: "Inspect another file." }] }],
  });
  expect(chatGptInstructionLineage(steered).predecessors.has(chatGptInstructionLineage(original).current)).toBeTrue();
});

for (const tool_choice of [
  "required",
  { type: "function", name: "inspect" },
  { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "inspect" }] },
  { type: "allowed_tools", mode: "required", tools: [] },
]) {
  test(`unsupported forced tool choice fails before browser execution: ${JSON.stringify(tool_choice)}`, async () => {
    await withAdapter(async (run, starts) => {
      await expect(run(parseRequest({ ...requestBody(), tool_choice }))).rejects.toMatchObject({
        status: 400, code: "unsupported_tool_choice", retryable: false,
      });
      expect(starts()).toBe(0);
    });
  });
}

test("a conflicting active retry does not detach its original observer", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://active-contract-${crypto.randomUUID()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  };
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const browser = spyOn(ChatGptBrowserWorker.forProvider(provider), "run").mockImplementation(async turn => {
    entered.resolve();
    const answer = await finish.promise;
    turn.onTextDelta(answer);
    return answer;
  });
  const adapter = createChatGptWebAdapter(provider);
  const body = requestBody();
  const firstEvents: AdapterEvent[] = [];
  const retryEvents: AdapterEvent[] = [];
  try {
    const first = adapter.runTurn!(parseRequest(body), { headers: new Headers() }, event => firstEvents.push(event));
    await entered.promise;
    const retry = adapter.runTurn!(parseRequest({ ...body, tool_choice: "none" }), { headers: new Headers() }, event => retryEvents.push(event));
    const rejection = expect(retry).rejects.toMatchObject({ code: "request_contract_conflict", retryable: false });
    finish.resolve('{"ok":true}');
    await Promise.all([first, rejection]);
    expect(firstEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(retryEvents.filter(event => event.type !== "heartbeat")).toEqual([]);
    expect(browser).toHaveBeenCalledTimes(1);
  } finally {
    finish.resolve('{"ok":true}');
    browser.mockRestore();
  }
});

test("tool schema examples and message metadata are not media content", () => {
  const schema = { type: "object", examples: [{ type: "input_audio" }, { type: "input_image", file_id: "example" }] };
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    input: [{ type: "additional_tools", tools: [{ type: "function", name: "inspect", parameters: schema }] }, {
      type: "message", role: "user", content: [{ type: "input_text", text: "Inspect it." }],
      internal_chat_message_metadata_passthrough: { example: { type: "input_audio" } },
    }],
  });
  expect(parsed.context.tools?.[0]?.parameters).toEqual(schema);
  expect(parsed.context.messages.at(-1)).toMatchObject({ content: "Inspect it." });
});

for (const content of [
  { type: "input_audio", input_audio: { data: "AA==", format: "wav" } },
  { type: "audio", data: "AA==", mimeType: "audio/wav" },
  { type: "output_audio", data: "AA==" },
  { type: "audio_url", url: "https://example.invalid/audio.wav" },
  { type: "input_image", file_id: "file_image" },
]) {
  test(`actual ${content.type} media fails closed in messages and tool results`, () => {
    for (const item of [
      { type: "message", role: "user", content: [content] },
      { type: "message", role: "assistant", content: [content] },
      { type: "function_call_output", call_id: "call_1", output: [content] },
    ]) {
      expect(() => parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: [item] })).toThrow("unsupported_media");
    }
  });
}
