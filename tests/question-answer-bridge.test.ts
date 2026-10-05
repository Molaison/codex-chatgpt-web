import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

test("ordinary questions send human text without the Codex runtime contract", () => {
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "medium" },
    context: {
      systemPrompt: ["INTERNAL_SYSTEM_PROMPT"],
      messages: [
        { role: "developer", content: "INTERNAL_DEVELOPER_PROMPT", timestamp: 1 },
        { role: "user", origin: "codex_skill", content: "INTERNAL_SKILL", timestamp: 2 },
        { role: "user", content: "<environment_context>\n<cwd>/private/workspace</cwd>\n</environment_context>", timestamp: 3 },
        { role: "user", content: "为什么天空是蓝色的？", timestamp: 4 },
      ],
    },
  };
  const result = compileChatGptWebPrompt(parsed, capabilities, undefined, { importCodexPrompt: false });
  expect(result.text).toBe("为什么天空是蓝色的？");
  expect(result.images).toEqual([]);
});

test("question history contains answers but no local tool calls or commentary", () => {
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "medium" },
    context: { messages: [
      { role: "user", content: "First question", timestamp: 1 },
      { role: "assistant", phase: "commentary", content: [{ type: "text", text: "INTERNAL_PROGRESS" }], timestamp: 2 },
      { role: "assistant", content: [
        { type: "toolCall", id: "call_private", name: "exec_command", arguments: { cmd: "INTERNAL_COMMAND" } },
        { type: "text", text: "First answer" },
      ], timestamp: 3 },
      { role: "toolResult", toolCallId: "call_private", toolName: "exec_command", content: "INTERNAL_TOOL_RESULT", isError: false, timestamp: 4 },
      { role: "user", content: "Explain the term Codex without running tools.", timestamp: 5 },
    ] },
  };
  const result = compileChatGptWebPrompt(parsed, capabilities, undefined, { importCodexPrompt: false });
  expect(result.text).toContain("First question");
  expect(result.text).toContain("First answer");
  expect(result.text).toContain("Explain the term Codex without running tools.");
  expect(result.text).not.toContain("INTERNAL_");
  expect(result.text).not.toContain("exec_command");
  expect(result.text).not.toContain("codex_context_json");
});

test("account identity isolates browser workers even before different paths are configured", () => {
  const provider = (accountId: string): CodexProviderConfig => ({
    adapter: "chatgpt-web", baseUrl: "browser://chatgpt", chatgptWeb: { accountId },
  });
  const first = ChatGptBrowserWorker.forProvider(provider("qa-account-a"));
  expect(ChatGptBrowserWorker.forProvider(provider("qa-account-a"))).toBe(first);
  expect(ChatGptBrowserWorker.forProvider(provider("qa-account-b"))).not.toBe(first);
});

test("browser-only follow-up reuses the account conversation and sends only the new question", async () => {
  const id = randomUUID();
  const socketPath = join(tmpdir(), "qa-" + id + ".sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: "browser://qa-" + id,
    chatgptWeb: {
      accountId: id, browserHost: "launcher", browserHostDescriptorPath: join(tmpdir(), "qa-" + id + ".json"),
      brokerSocketPath: socketPath, ...capabilities,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const turns: BrowserTurn[] = [];
  const prompts: string[] = [];
  const run = spyOn(worker, "run").mockImplementation(async turn => {
    const compiled = turns.length === 0 ? await turn.prepare() : await turn.prepareResume!();
    turns.push(turn); prompts.push(compiled.text); compiled.release();
    turn.onTextDelta("Answer " + turns.length);
    return "Answer " + turns.length;
  });
  const message = (role: string, text: string, messageId: string) => ({ type: "message", role, id: messageId, content: text });
  const question = message("user", "Remember QA_MARKER_123", "user_1");
  const parse = (turn: string, input: unknown[]) => parseRequest({
    model: CHATGPT_WEB_MODEL_ID, stream: true, input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: id, turn_id: turn }) },
  });
  const events: AdapterEvent[] = [];
  try {
    const adapter = createChatGptWebAdapter(provider);
    await adapter.runTurn!(parse("first", [question]), { headers: new Headers() }, e => events.push(e));
    await adapter.runTurn!(parse("second", [question, message("assistant", "Answer 1", "answer_1"), message("user", "What was the marker?", "user_2")]), { headers: new Headers() }, e => events.push(e));
    expect(events.filter(e => e.type === "error")).toEqual([]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.retainConversation).toBe(true);
    expect(turns[0]!.conversationKey).toBeTruthy();
    expect(turns[1]!.conversationKey).toBe(turns[0]!.conversationKey);
    expect(prompts[1]).toBe("What was the marker?");
    expect(events.some(e => e.type === "text_delta" && e.text.includes("Local tools unavailable"))).toBe(false);
  } finally {
    run.mockRestore();
    await TurnBroker.forSocket(socketPath).close();
  }
});

test("download targets retain spaces, query strings and sandbox paths", () => {
  expect(chatGptHtmlToMarkdown('<a href="sandbox:/mnt/data/annual report.csv">Download</a>'))
    .toBe("[Download](<sandbox:/mnt/data/annual report.csv>)");
  expect(chatGptHtmlToMarkdown('<a href="https://chatgpt.com/backend-api/estuary/content?id=file-123&amp;download=true">report.csv</a>'))
    .toContain("https://chatgpt.com/backend-api/estuary/content?id=file-123&download=true");
});

test.each(["max", "high"] as const)("model capacity %s returns 429 and recovers after completion", async reasoning => {
  const limit = reasoning === "max" ? 2 : 5;
  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web", baseUrl: "browser://limits",
    chatgptWeb: { accountId: randomUUID(), standardConcurrencyLimit: 5, proConcurrencyLimit: 2 },
  });
  const releases: Array<() => void> = [];
  const execute = spyOn(worker as any, "runExclusive").mockImplementation(() => new Promise<string>(resolve => {
    releases.push(() => resolve("OK"));
  }));
  const turn = (traceId: string): BrowserTurn => ({
    traceId, modelId: CHATGPT_WEB_MODEL_ID, reasoning, capabilities,
    prepare: async () => ({ text: "test", images: [], release() {} }), onTextDelta() {},
  });
  const pending: Promise<string>[] = [];
  try {
    for (let i = 0; i < limit; i++) pending.push(worker.run(turn("limit_" + i)));
    await Promise.resolve();
    await expect(worker.run(turn("overflow"))).rejects.toMatchObject({ status: 429, code: "concurrency_limit_exceeded" });
    expect(execute).toHaveBeenCalledTimes(limit);
    releases[0]!(); await pending[0]; await Promise.resolve();
    pending.push(worker.run(turn("after_completion")));
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(limit + 1);
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(pending);
    execute.mockRestore();
  }
});

test("a failed Pro turn releases its capacity", async () => {
  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web", baseUrl: "browser://failed-limit",
    chatgptWeb: { accountId: randomUUID(), proConcurrencyLimit: 1 },
  });
  const execute = spyOn(worker as any, "runExclusive")
    .mockRejectedValueOnce(new Error("browser failed")).mockResolvedValue("recovered");
  const turn = (traceId: string): BrowserTurn => ({
    traceId, modelId: CHATGPT_WEB_MODEL_ID, reasoning: "max", capabilities,
    prepare: async () => ({ text: "test", images: [], release() {} }), onTextDelta() {},
  });
  try {
    await expect(worker.run(turn("failed"))).rejects.toThrow("browser failed");
    await Promise.resolve();
    await expect(worker.run(turn("recovered"))).resolves.toBe("recovered");
  } finally { execute.mockRestore(); }
});
