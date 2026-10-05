import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, resolveBrowserConfig, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { chatGptConversationKey, chatGptQuestionAnswerNamespace } from "../src/adapters/chatgpt-web/conversation-key";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultConfig, loadConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const roots: string[] = [];
const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true, extraHighAvailable: true };
const message = (role: "user" | "assistant" | "developer" | "system", text: string) => ({
  type: "message", role, id: randomUUID(),
  content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
});
function request(thread: string | undefined, input: unknown[], parent?: string, fork = false): CodexParsedRequest {
  return parseRequest({ model: "gpt-5.6-sol", stream: true, input, reasoning: { effort: "low" },
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: thread, turn_id: randomUUID(), ...(parent ? (fork ? { forked_from_thread_id: parent, forked_from_ordinal_exclusive: 17 } : { parent_thread_id: parent }) : {}),
    }) },
  });
}
function root() {
  const path = mkdtempSync(join(tmpdir(), "qa-portable-")); roots.push(path); return path;
}
function provider(accountId: string, overrides: CodexProviderConfig["chatgptWeb"] = {}): CodexProviderConfig {
  const home = root();
  return { adapter: "chatgpt-web", baseUrl: "browser://portable-test", chatgptWeb: {
    ...capabilities, accountId, browserHost: "launcher", useSavedChats: true,
    browserHostDescriptorPath: join(home, "launcher.json"),
    brokerSocketPath: join(home, "broker.sock"), ...overrides,
  } };
}
async function withBrowserProviders(
  providers: CodexProviderConfig[],
  browser: (turn: BrowserTurn, index: number) => Promise<string>,
  run: (adapters: ReturnType<typeof createChatGptWebAdapter>[]) => Promise<void>,
) {
  const mocks = providers.map((config, index) => spyOn(ChatGptBrowserWorker.forProvider(config), "run")
    .mockImplementation(async turn => {
      const answer = await browser(turn, index); turn.onTextDelta(answer); return answer;
    }));
  try { await run(providers.map(config => createChatGptWebAdapter(config))); }
  finally {
    mocks.forEach(mock => mock.mockRestore());
    await Promise.all(providers.map(config => TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!).close()));
  }
}
const qaKey = (parsed: CodexParsedRequest, account = "default") =>
  chatGptConversationKey(parsed, chatGptQuestionAnswerNamespace(account), { questionAnswer: true });

test("portable QA keys use account and own thread; fork lineage is not identity", () => {
  const parent = request("parent", [message("user", "baseline")]);
  const child = request("child", [message("user", "branch")], "parent", true);
  const parentKey = qaKey(parent, "account-one");
  expect(parentKey).toMatch(/^[a-f0-9]{64}$/);
  expect(qaKey(child, "account-one")).not.toBe(parentKey);
  expect(qaKey(child, "account-one")).toBe(qaKey(request("child", []), "account-one"));
  expect(qaKey(parent, "account-two")).not.toBe(parentKey);
  expect(qaKey(request(undefined, [], "parent"))).toBeUndefined();
  expect(qaKey(request("  ", []))).toBeUndefined();
  expect(() => qaKey(request("parent", [], "parent"))).toThrow("distinct from its parent");
  expect(() => qaKey(request("parent", [], "parent", true))).toThrow("distinct from its parent");
});

test("the real QA adapter keeps its saved-chat key across deployment and model settings", async () => {
  const account = randomUUID(), thread = randomUUID();
  const original = provider(account);
  const moved = provider(account, {
    appName: "Codex Portable", storageStatePath: join(root(), "browser-state.json"),
    chromeExecutablePath: join(root(), "chrome-next-release"),
    browserHelperScriptPath: join(root(), "runtime-v99.cjs"),
    conversationStoreDirectory: join(root(), "restored-mappings"),
    standardConcurrencyLimit: 3, proConcurrencyLimit: 1,
    downloadBaseUrl: "https://download.example.invalid/new-address",
    downloadDirectory: join(root(), "downloads"), headed: false, turnTimeoutMs: 12345,
  });
  writeFileSync(moved.chatgptWeb!.browserHelperScriptPath!, "// Isolated release-path fixture; browser is mocked.\n");
  moved.baseUrl = "https://chatgpt.com"; moved.contextWindow = 128000;
  const turns: BrowserTurn[] = [];
  await withBrowserProviders([original, moved], async turn => { turns.push(turn); return "OK"; }, async adapters => {
    await adapters[0]!.runTurn(request(thread, [message("user", "first")]), { headers: new Headers() }, () => {});
    const second = request(thread, [message("user", "second")]); second.options.reasoning = "high"; second._chatgptModelFamily = "6";
    await adapters[1]!.runTurn(second, { headers: new Headers() }, () => {});
  });
  expect(turns).toHaveLength(2);
  expect(turns[0]!.conversationKey).toBe(qaKey(request(thread, []), account));
  expect(turns[1]!.conversationKey).toBe(turns[0]!.conversationKey);
  expect(chatGptWebExecutionNamespace(original)).not.toBe(chatGptWebExecutionNamespace(moved));
});

test("fork seeds supplied human history once and keeps parent and child prompts independent", async () => {
  const parent = randomUUID(), child = randomUUID(), account = randomUUID();
  const baseline = message("user", "Remember baseline marker ORCHID");
  const answer = message("assistant", "Remembered ORCHID");
  const branch = message("user", "Use that marker in this branch");
  const store = new ChatGptConversationStore(join(root(), "store"), account);
  let parentBeforeFork: ReturnType<ChatGptConversationStore["lookup"]>;
  const submitted: Array<{ key: string; prompt: string; resumed: boolean }> = [];
  await withBrowserProviders([provider(account)], async turn => {
    const key = turn.conversationKey!;
    const resumed = store.lookup(key) !== undefined;
    const prepared = await (resumed ? turn.prepareResume!() : turn.prepare());
    submitted.push({ key, prompt: prepared.text, resumed }); prepared.release();
    if (!resumed) store.bind(key, store.reserve(key), "https://chatgpt.com/c/" + key);
    return "Acknowledged";
  }, async ([adapter]) => {
    await adapter!.runTurn(request(parent, [baseline]), { headers: new Headers() }, () => {});
    parentBeforeFork = store.lookup(qaKey(request(parent, []), account)!);
    await adapter!.runTurn(request(child, [
      message("system", "CODEX_SYSTEM_CANARY"), message("developer", "CODEX_DEVELOPER_CANARY"),
      baseline, answer,
      { type: "function_call", call_id: "tool-id", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "tool-id", output: "CODEX_TOOL_CANARY" },
      { ...message("assistant", "CODEX_PROGRESS_CANARY"), phase: "commentary" }, branch,
    ], parent, true), { headers: new Headers() }, () => {});
    await adapter!.runTurn(request(child, [message("user", "Continue child only")], parent, true), { headers: new Headers() }, () => {});
    await adapter!.runTurn(request(parent, [message("user", "Continue parent only")]), { headers: new Headers() }, () => {});
  });
  expect(submitted.map(item => item.resumed)).toEqual([false, false, true, true]);
  expect(submitted[1]!.prompt).toBe("Conversation history; answer the latest user message:\n\nUser:\nRemember baseline marker ORCHID\n\nAssistant:\nRemembered ORCHID\n\nUser:\nUse that marker in this branch");
  expect(submitted[2]!.prompt).toBe("Continue child only");
  expect(submitted[3]!.prompt).toBe("Continue parent only");
  expect(submitted[0]!.key).toBe(submitted[3]!.key);
  expect(submitted[1]!.key).toBe(submitted[2]!.key);
  expect(submitted[1]!.key).not.toBe(submitted[0]!.key);
  expect(store.lookup(submitted[0]!.key)).toEqual(parentBeforeFork);
  expect(store.lookup(submitted[1]!.key)!.url).not.toBe(store.lookup(submitted[0]!.key)!.url);
});

test("a cold fork cannot silently replace missing inherited history with runtime wrappers", async () => {
  let submissions = 0;
  await withBrowserProviders([provider(randomUUID())], async turn => {
    const prepared = await turn.prepare(); prepared.release(); submissions++; return "unexpected";
  }, async ([adapter]) => {
    const wrappers = [message("system", "runtime"), message("developer", "runtime"),
      message("user", "<environment_context><cwd>/private/test</cwd></environment_context>"),
      { ...message("assistant", "internal progress"), phase: "commentary" },
      { type: "function_call", call_id: "fork-tool", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "fork-tool", output: "tool evidence" }];
    for (const input of [[message("user", "New branch question")], [...wrappers, message("user", "New branch question")]]) {
      const events: AdapterEvent[] = [];
      await adapter!.runTurn(request(randomUUID(), input, randomUUID(), true), { headers: new Headers() }, event => events.push(event));
      expect(events.filter(event => event.type === "error")).toHaveLength(1);
      expect(events.find(event => event.type === "error")).toMatchObject({ status: 400, code: "fork_history_missing", retryable: false });
      expect(events.some(event => event.type === "text_delta")).toBe(false);
    }
  });
  expect(submissions).toBe(0);
});

test("a saved fork can restore with an incremental request and repeated fork metadata", async () => {
  const prompts: string[] = [];
  await withBrowserProviders([provider(randomUUID())], async turn => {
    const prepared = await turn.prepareResume!(); prompts.push(prepared.text); prepared.release(); return "OK";
  }, async ([adapter]) => {
    await adapter!.runTurn(request(randomUUID(), [message("user", "Continue the saved child")], randomUUID(), true),
      { headers: new Headers() }, () => {});
  });
  expect(prompts).toEqual(["Continue the saved child"]);
});

test("an inherited assistant answer is valid fork context even when its earlier question is absent", async () => {
  let compiled = "";
  await withBrowserProviders([provider(randomUUID())], async turn => {
    const prepared = await turn.prepare(); compiled = prepared.text; prepared.release(); return "OK";
  }, async ([adapter]) => {
    await adapter!.runTurn(request(randomUUID(), [message("assistant", "Earlier answer with inherited marker"),
      message("user", "Continue from that answer")], randomUUID(), true), { headers: new Headers() }, () => {});
  });
  expect(compiled).toContain("Assistant:\nEarlier answer with inherited marker");
  expect(compiled).toContain("User:\nContinue from that answer");
});

test("same account/thread still queues across mutable configuration changes", async () => {
  const account = randomUUID(), thread = randomUUID();
  const first = provider(account), changed = provider(account, { standardConcurrencyLimit: 1 });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const began = new Promise<void>(done => { started = done; });
  const entered: number[] = [];
  await withBrowserProviders([first, changed], async (_turn, index) => {
    entered.push(index);
    if (index === 0) { started(); await gate; }
    return "OK";
  }, async adapters => {
    const pending = adapters[0]!.runTurn(request(thread, [message("user", "first")]), { headers: new Headers() }, () => {});
    await began;
    const queued = adapters[1]!.runTurn(request(thread, [message("user", "second")]), { headers: new Headers() }, () => {});
    try {
      await new Promise<void>(done => setImmediate(done));
      expect(entered).toEqual([0]);
    } finally { release(); await Promise.all([pending, queued]); }
    expect(entered).toEqual([0, 1]);
  });
});

test("QA config defaults to saved chats while explicit Temporary Chat opt-out survives reload", () => {
  process.env.CODEX_CHATGPT_WEB_HOME = root();
  const config: Record<string, unknown> = { ...defaultConfig() };
  expect(config.useSavedChats).toBe(true); delete config.useSavedChats;
  const persist = () => writeFileSync(join(process.env.CODEX_CHATGPT_WEB_HOME!, "config.json"), JSON.stringify(config));
  persist();
  expect(loadConfig()!.useSavedChats).toBe(true);
  expect(providerConfig(loadConfig()!).chatgptWeb!.useSavedChats).toBe(true);
  config.useSavedChats = false; persist();
  expect(loadConfig()!.useSavedChats).toBe(false);
  expect(providerConfig(loadConfig()!).chatgptWeb!.useSavedChats).toBe(false);
  config.useSavedChats = "false"; persist();
  expect(() => loadConfig()).toThrow("useSavedChats");
});

test("manual configuration without a preference remains Temporary Chat", () => {
  process.env.CODEX_CHATGPT_WEB_HOME = root();
  const config: Record<string, unknown> = { ...defaultConfig("full"), browserHost: "launcher",
    browserInteractionMode: "manual", browserHostDescriptorPath: join(process.env.CODEX_CHATGPT_WEB_HOME, "launcher.json") };
  config.tunnel = { binaryPath: join(process.env.CODEX_CHATGPT_WEB_HOME, "tunnel"),
    tunnelId: "tunnel_" + "a".repeat(32), runtimeKeyFile: join(process.env.CODEX_CHATGPT_WEB_HOME, "key"),
    profileDir: join(process.env.CODEX_CHATGPT_WEB_HOME, "profile"), profileName: "test", alias: "test" };
  config.appName = config.manualAppName; delete config.useSavedChats;
  writeFileSync(join(process.env.CODEX_CHATGPT_WEB_HOME, "config.json"), JSON.stringify(config));
  expect(loadConfig()!.useSavedChats).toBe(false);
  expect(providerConfig(loadConfig()!).chatgptWeb!.useSavedChats).toBe(false);
});

test("portable mapping directory resolves at the account home after relocation", () => {
  const firstHome = root(), secondHome = root();
  process.env.CODEX_CHATGPT_WEB_HOME = firstHome;
  const config = defaultConfig();
  expect(config.conversationStoreDirectory).toBeUndefined();
  expect(providerConfig(config).chatgptWeb!.conversationStoreDirectory).toBe(join(firstHome, "runtime", "conversations"));
  config.conversationStoreDirectory = "portable/chat-mappings";
  expect(providerConfig(config).chatgptWeb!.conversationStoreDirectory).toBe(join(firstHome, "portable", "chat-mappings"));
  process.env.CODEX_CHATGPT_WEB_HOME = secondHome;
  expect(providerConfig(config).chatgptWeb!.conversationStoreDirectory).toBe(join(secondHome, "portable", "chat-mappings"));
  config.conversationStoreDirectory = join(firstHome, "explicit-store");
  expect(providerConfig(config).chatgptWeb!.conversationStoreDirectory).toBe(config.conversationStoreDirectory);
});

test("saved-chat directory validation rejects invalid types, blanks and NULs", () => {
  process.env.CODEX_CHATGPT_WEB_HOME = root();
  for (const value of [null, true, 123, {}, "", "  ", "bad\0path"]) {
    writeFileSync(join(process.env.CODEX_CHATGPT_WEB_HOME, "config.json"), JSON.stringify({ ...defaultConfig(), conversationStoreDirectory: value }));
    expect(() => loadConfig()).toThrow("conversationStoreDirectory");
  }
});

test("direct worker and provider agree on QA defaults, account-relative paths and explicit opt-out", () => {
  process.env.CODEX_CHATGPT_WEB_HOME = root();
  const config: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", chatgptWeb: {} };
  expect(resolveBrowserConfig(config)).toMatchObject({ accountId: "default", useSavedChats: true,
    conversationStoreDirectory: join(process.env.CODEX_CHATGPT_WEB_HOME, "runtime", "conversations") });
  config.chatgptWeb!.conversationStoreDirectory = "custom/mappings";
  expect(resolveBrowserConfig(config).conversationStoreDirectory).toBe(join(process.env.CODEX_CHATGPT_WEB_HOME, "custom", "mappings"));
  config.chatgptWeb!.useSavedChats = false;
  expect(resolveBrowserConfig(config).useSavedChats).toBe(false);
  delete config.chatgptWeb!.useSavedChats;
  config.chatgptWeb!.localToolsEnabled = true;
  expect(resolveBrowserConfig(config).useSavedChats).toBe(false);
});
