import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptConversationKey, retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const qa = { questionAnswer: true };
const message = (role: "user" | "assistant", text: string, id = randomUUID()) => ({
  type: "message", role, id, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});

function request(thread: string, turn: string, input: unknown[], effort = "low"): CodexParsedRequest {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID, stream: true, input, reasoning: { effort },
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) },
  });
}

function prompt(parsed: CodexParsedRequest | undefined): string | undefined {
  return parsed && compileChatGptWebPrompt(parsed, capabilities, undefined, { importCodexPrompt: false }).text;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(runBrowser: (turn: BrowserTurn) => Promise<string>, extra: CodexProviderConfig["chatgptWeb"] = {}) {
  const id = randomUUID();
  const socketPath = join(tmpdir(), `qa-session-${id}.sock`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: "browser://qa-session-tests",
    chatgptWeb: {
      ...capabilities, accountId: id, browserHost: "launcher",
      browserHostDescriptorPath: join(tmpdir(), `qa-session-${id}.json`),
      brokerSocketPath: socketPath, ...extra,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const run = spyOn(worker, "run").mockImplementation(async turn => {
    const answer = await runBrowser(turn);
    turn.onTextDelta(answer);
    return answer;
  });
  const adapter = createChatGptWebAdapter(provider);
  return {
    provider, worker, run, adapter,
    async close() { run.mockRestore(); await TurnBroker.forSocket(socketPath).close(); },
  };
}

function textOf(events: AdapterEvent[]): string {
  return events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("");
}

test("QA chat identity survives model, effort, family and context compaction changes", () => {
  const first = request("same-thread", "turn-1", [message("user", "Hello")]);
  const original = chatGptConversationKey(first, "account-one", qa);
  const variants: CodexParsedRequest[] = [
    { ...first, modelId: "a-different-model" },
    { ...first, options: { ...first.options, reasoning: "max" } },
    { ...first, _chatgptModelFamily: "6" },
    { ...first, _rawBody: { ...(first._rawBody as object), input: [{ type: "compaction", encrypted_content: "summary-2" }] } },
  ];
  for (const variant of variants) {
    expect(chatGptConversationKey(variant, "account-one", qa)).toBe(original);
    expect(chatGptConversationKey(variant, "account-one")).not.toBe(chatGptConversationKey(first, "account-one"));
  }
  expect(chatGptConversationKey(first, "account-two", qa)).not.toBe(original);
  expect(chatGptConversationKey(request("different-thread", "turn-1", [message("user", "Hello")]), "account-one", qa)).not.toBe(original);
  expect(chatGptConversationKey(first, "account-one")).not.toBe(original);
});

test("account IDs alone isolate execution namespaces", () => {
  const provider = (accountId: string): CodexProviderConfig => ({
    adapter: "chatgpt-web", baseUrl: "browser://chatgpt", chatgptWeb: { accountId },
  });
  expect(chatGptWebExecutionNamespace(provider("one"))).toBe(chatGptWebExecutionNamespace(provider("one")));
  expect(chatGptWebExecutionNamespace(provider("one"))).not.toBe(chatGptWebExecutionNamespace(provider("two")));
});

test("missing thread identity cannot share an anonymous retained chat", () => {
  const parsed = request("thread", "turn", [message("user", "Hello")]);
  parsed._rawBody = { input: [] };
  expect(chatGptConversationKey(parsed, "account", qa)).toBeUndefined();
});

test("QA incremental requests can continue without assistant history", () => {
  const parsed = request("thread", "turn", [message("user", "Only the new question")]);
  expect(prompt(retainedConversationResumeRequest(parsed, qa))).toBe("Only the new question");
  expect(retainedConversationResumeRequest(parsed)).toBeUndefined();
});

test("QA continuation ignores commentary and tool-only assistant messages as answer boundaries", () => {
  const parsed = request("thread", "turn-2", [
    message("user", "Old question"), message("assistant", "Old answer"),
    message("user", "New question"), { ...message("assistant", "Internal progress"), phase: "commentary" },
    { type: "function_call", call_id: "internal-tool", name: "exec_command", arguments: "{}" },
  ]);
  expect(prompt(retainedConversationResumeRequest(parsed, qa))).toBe("New question");
});

test("queued canonical history omits the previous question even before its answer arrives", () => {
  const first = message("user", "First question");
  const before = request("thread", "turn-1", [first]);
  const after = request("thread", "turn-2", [first, message("user", "Second question")]);
  before.context.messages[0]!.timestamp = 1;
  after.context.messages[0]!.timestamp = 2;
  expect(prompt(retainedConversationResumeRequest(after, { ...qa, previousRequest: before }))).toBe("Second question");
  expect(after.context.messages).toHaveLength(2);
});

test("an intentional repeated question with a different message ID is still submitted", () => {
  const before = request("thread", "turn-1", [message("user", "Repeat this")]);
  const after = request("thread", "turn-2", [message("user", "Repeat this")]);
  expect(prompt(retainedConversationResumeRequest(after, { ...qa, previousRequest: before }))).toBe("Repeat this");
  expect(retainedConversationResumeRequest(before, { ...qa, previousRequest: before })).toBeUndefined();
});

test("three QA rounds reuse one chat across model effort changes and submit incremental prompts", async () => {
  const thread = randomUUID();
  const turns: BrowserTurn[] = [];
  const prompts: string[] = [];
  const h = harness(async turn => {
    const prepared = await (turns.length ? turn.prepareResume!() : turn.prepare());
    prompts.push(prepared.text); prepared.release(); turns.push(turn);
    turn.onSubmitted?.();
    return `Answer ${turns.length}`;
  });
  const first = message("user", "Remember my marker");
  const second = message("user", "Explain it briefly");
  try {
    await h.adapter.runTurn(request(thread, "one", [first]), { headers: new Headers() }, () => {});
    await h.adapter.runTurn(request(thread, "two", [first, message("assistant", "Answer 1"), second], "high"), { headers: new Headers() }, () => {});
    await h.adapter.runTurn(request(thread, "three", [message("user", "Now summarize")], "max"), { headers: new Headers() }, () => {});
    expect(turns).toHaveLength(3);
    expect(new Set(turns.map(turn => turn.conversationKey)).size).toBe(1);
    expect(turns.every(turn => turn.retainConversation)).toBe(true);
    expect(prompts).toEqual(["Remember my marker", "Explain it briefly", "Now summarize"]);
  } finally { await h.close(); }
});

test("concurrent requests in one QA thread queue without aborting the first answer", async () => {
  const thread = randomUUID();
  const first = message("user", "First question");
  const started = deferred<void>();
  const finish = deferred<string>();
  const turns: BrowserTurn[] = [];
  const prompts: string[] = [];
  const h = harness(async turn => {
    const reused = turns.length > 0;
    turns.push(turn);
    const compiled = await (reused ? turn.prepareResume!() : turn.prepare());
    prompts.push(compiled.text); compiled.release();
    if (reused) return "Second answer";
    started.resolve();
    return finish.promise;
  });
  const events1: AdapterEvent[] = [], events2: AdapterEvent[] = [];
  const one = h.adapter.runTurn(request(thread, "one", [first]), { headers: new Headers() }, e => events1.push(e));
  await started.promise;
  const two = h.adapter.runTurn(request(thread, "two", [first, message("user", "Second question")]), { headers: new Headers() }, e => events2.push(e));
  try {
    await Bun.sleep(0);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.abortSignal?.aborted).toBe(false);
    finish.resolve("First answer");
    await Promise.all([one, two]);
    expect(textOf(events1)).toBe("First answer");
    expect(textOf(events2)).toBe("Second answer");
    expect(prompts).toEqual(["First question", "Second question"]);
    expect(turns[1]!.conversationKey).toBe(turns[0]!.conversationKey);
  } finally { finish.resolve("First answer"); await Promise.allSettled([one, two]); await h.close(); }
});

test("same thread and turn IDs on different accounts never share browser execution or replies", async () => {
  const firstStarted = deferred<void>(), secondStarted = deferred<void>();
  const finish = deferred<void>();
  const keys: string[] = [];
  const account = (answer: string, started: ReturnType<typeof deferred<void>>) => harness(async turn => {
    keys.push(turn.conversationKey!); started.resolve(); await finish.promise; return answer;
  });
  const a = account("Account A", firstStarted), b = account("Account B", secondStarted);
  const parsed = request(randomUUID(), "same-turn", [message("user", "Same question")]);
  const eventsA: AdapterEvent[] = [], eventsB: AdapterEvent[] = [];
  const one = a.adapter.runTurn(parsed, { headers: new Headers() }, e => eventsA.push(e));
  const two = b.adapter.runTurn(parsed, { headers: new Headers() }, e => eventsB.push(e));
  try {
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
    finish.resolve(); await Promise.all([one, two]);
    expect(textOf(eventsA)).toBe("Account A"); expect(textOf(eventsB)).toBe("Account B");
  } finally { finish.resolve(); await Promise.allSettled([one, two]); await a.close(); await b.close(); }
});

test("an exact request retry replays the completed answer without another browser submission", async () => {
  const h = harness(async () => "Only one physical answer");
  const parsed = request(randomUUID(), "retry-turn", [message("user", "Question")]);
  const first: AdapterEvent[] = [], replay: AdapterEvent[] = [];
  try {
    await h.adapter.runTurn(parsed, { headers: new Headers() }, e => first.push(e));
    await h.adapter.runTurn(parsed, { headers: new Headers() }, e => replay.push(e));
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(textOf(first)).toBe("Only one physical answer"); expect(textOf(replay)).toBe(textOf(first));
  } finally { await h.close(); }
});

test("disconnecting an accepted QA response preserves it for reconnect", async () => {
  const started = deferred<void>(), finish = deferred<string>();
  let owned: BrowserTurn | undefined;
  const h = harness(async turn => { owned = turn; turn.onSubmitted?.(); started.resolve(); return finish.promise; });
  const parsed = request(randomUUID(), "reconnect", [message("user", "Question")]);
  const disconnect = new AbortController();
  const first = h.adapter.runTurn(parsed, { headers: new Headers(), abortSignal: disconnect.signal }, () => {}).catch(error => error);
  let reconnect: Promise<void> | undefined;
  try {
    await started.promise; disconnect.abort();
    expect((await first).name).toBe("AbortError");
    expect(owned!.abortSignal?.aborted).toBe(false);
    const events: AdapterEvent[] = [];
    reconnect = h.adapter.runTurn(parsed, { headers: new Headers() }, e => events.push(e));
    finish.resolve("Recovered answer"); await reconnect;
    expect(h.run).toHaveBeenCalledTimes(1); expect(textOf(events)).toBe("Recovered answer");
  } finally { finish.resolve("Recovered answer"); await first; await reconnect; await h.close(); }
});

test("cancelling a queued QA request never submits it or cancels the active answer", async () => {
  const started = deferred<void>(), finish = deferred<string>();
  let owned: BrowserTurn | undefined;
  const h = harness(async turn => { owned = turn; started.resolve(); return finish.promise; });
  const thread = randomUUID();
  const one = h.adapter.runTurn(request(thread, "one", [message("user", "First")]), { headers: new Headers() }, () => {});
  const cancel = new AbortController();
  let queued: Promise<unknown> | undefined;
  try {
    await started.promise;
    queued = h.adapter.runTurn(request(thread, "two", [message("user", "Queued")]), { headers: new Headers(), abortSignal: cancel.signal }, () => {}).catch(error => error);
    cancel.abort();
    expect((await queued as Error).name).toBe("AbortError");
    expect(owned!.abortSignal?.aborted).toBe(false);
    finish.resolve("First answer"); await one;
    expect(h.run).toHaveBeenCalledTimes(1);
  } finally { finish.resolve("First answer"); await Promise.allSettled([one, queued]); await h.close(); }
});

test("retryable pre-submission failure can retry the same QA execution", async () => {
  let attempts = 0;
  const h = harness(async () => {
    if (++attempts === 1) throw new ChatGptWebAdapterError("Temporarily full", {
      status: 429, errorType: "rate_limit_error", code: "test_capacity", retryable: true,
    });
    return "Recovered";
  });
  const parsed = request(randomUUID(), "retry", [message("user", "Question")]);
  const errors: AdapterEvent[] = [], recovered: AdapterEvent[] = [];
  try {
    await h.adapter.runTurn(parsed, { headers: new Headers() }, e => errors.push(e));
    await h.adapter.runTurn(parsed, { headers: new Headers() }, e => recovered.push(e));
    expect(errors.find(e => e.type === "error")).toMatchObject({ retryable: true, status: 429 });
    expect(h.run).toHaveBeenCalledTimes(2); expect(textOf(recovered)).toBe("Recovered");
  } finally { await h.close(); }
});

test("failure after accepted submission cannot duplicate the question on an exact retry", async () => {
  const h = harness(async turn => { turn.onSubmitted?.(); throw new Error("Lost browser observation"); });
  const parsed = request(randomUUID(), "accepted", [message("user", "Question")]);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const events: AdapterEvent[] = [];
      await h.adapter.runTurn(parsed, { headers: new Headers() }, e => events.push(e));
      expect(events.find(e => e.type === "error")).toMatchObject({ code: "chatgpt_submitted_turn_failed", retryable: false });
    }
    expect(h.run).toHaveBeenCalledTimes(1);
  } finally { await h.close(); }
});

test("explicit fresh-chat mode still disables retained QA conversations", async () => {
  const turns: BrowserTurn[] = [];
  const h = harness(async turn => { turns.push(turn); return "OK"; }, { experimentalFreshConversationPerTurn: true });
  try {
    await h.adapter.runTurn(request(randomUUID(), "one", [message("user", "Hello")]), { headers: new Headers() }, () => {});
    expect(turns[0]!.conversationKey).toBeUndefined(); expect(turns[0]!.retainConversation).toBeUndefined();
  } finally { await h.close(); }
});
