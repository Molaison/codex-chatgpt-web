import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "../src/responses/state";
import { rememberSavedChatResponseAlias, SavedChatResponseAliases, supportsSavedChatAliases } from "../src/responses/saved-chat-aliases";
import { chatGptConversationKey, chatGptQuestionAnswerNamespace } from "../src/adapters/chatgpt-web/conversation-key";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { responseRequest, routeChatGptWebRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;
const roots: string[] = [];
afterEach(() => {
  flushResponseState();
  if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qa-response-alias-")); roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const account = "account-" + randomUUID(), thread = randomUUID();
  const config = { ...defaultConfig(), accountId: account, browserHost: "launcher" as const,
    browserHostDescriptorPath: join(root, "unused-launcher.json"), conversationStoreDirectory: join(root, "conversations"),
    brokerSocketPath: join(root, "broker.sock"), useSavedChats: true };
  const body = (text = "Continue", previous?: string, threadId = thread, stream = false) => ({
    model: "chatgpt-web/gpt-5.6-sol-instant", stream,
    input: [{ type: "message", role: "user", id: randomUUID(), content: [{ type: "input_text", text }] }],
    ...(previous ? { previous_response_id: previous } : {}),
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: randomUUID() }) },
  });
  const key = chatGptConversationKey(parseRequest(body()), chatGptQuestionAnswerNamespace(account), { questionAnswer: true })!;
  const store = new ChatGptConversationStore(config.conversationStoreDirectory, account);
  store.bind(key, store.reserve(key), "https://chatgpt.com/c/" + randomUUID());
  const aliases = new SavedChatResponseAliases(config.conversationStoreDirectory);
  const seen: CodexParsedRequest[] = [];
  const handler = async (requestBody: unknown, overrides = {}, rememberState = true) => responseRequest(new Request("http://isolated.test/v1/responses", {
    method: "POST", body: JSON.stringify(requestBody),
  }), { ...config, ...overrides }, () => ({ name: "isolated-alias-fixture", async runTurn(parsed, _incoming, emit) {
    seen.push(parsed); emit({ type: "text_delta", text: "ANSWER_CANARY", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }), { rememberState });
  return { root, config, account, thread, body, key, store, aliases, seen, handler };
}
async function responseId(response: Response) {
  expect(response.status).toBe(200);
  const json = await response.json(); expect(json.status).toBe("completed"); return json.id as string;
}

test("a completed saved QA response resumes incrementally after its one-hour history cache expires", async () => {
  const f = fixture();
  const id = await responseId(await f.handler(f.body("PRIVATE_TRANSCRIPT_CANARY")));
  expect(f.aliases.lookup(id)?.conversation).toBe(f.key);
  const now = spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
  try {
    const next = f.body("Only this new question", id);
    expect(expandPreviousResponseInput(next)).toBe(next);
    const continued = await responseId(await f.handler(next));
    expect(f.aliases.lookup(continued)?.conversation).toBe(f.key);
    expect(f.seen.at(-1)!._chatgptSavedConversationContinuation).toBe(true);
    expect(f.seen.at(-1)!.context.messages).toHaveLength(1);
    expect(JSON.stringify(f.seen.at(-1)!._rawBody)).not.toContain("PRIVATE_TRANSCRIPT_CANARY");
    const database = readFileSync(f.aliases.path).toString("latin1");
    for (const sensitive of ["PRIVATE_TRANSCRIPT_CANARY", "ANSWER_CANARY", f.thread, f.account, id]) expect(database).not.toContain(sensitive);
  } finally { now.mockRestore(); }
});

test("durable alias survives a new process with the bounded response snapshot removed", async () => {
  const f = fixture(); const id = await responseId(await f.handler(f.body("Old baseline")));
  flushResponseState(); rmSync(join(f.root, "responses-state.json"), { force: true });
  const script = join(f.root, "resume.ts");
  writeFileSync(script, [
    "import { responseRequest } from " + JSON.stringify(new URL("../src/server.ts", import.meta.url).href) + ";",
    "import { expandPreviousResponseInput } from " + JSON.stringify(new URL("../src/responses/state.ts", import.meta.url).href) + ";",
    "const config = " + JSON.stringify(f.config) + ";",
    "const body = " + JSON.stringify(f.body("Restart delta", id)) + ";",
    "if (expandPreviousResponseInput(body) !== body) throw new Error('Unexpected history cache');",
    "const result = await responseRequest(new Request('http://isolated.test/v1/responses', {method:'POST',body:JSON.stringify(body)}), config, () => ({name:'restart-fixture', async runTurn(parsed, incoming, emit) {",
    " if (!parsed._chatgptSavedConversationContinuation || parsed.context.messages.length !== 1) throw new Error('Not a verified incremental continuation');",
    " emit({type:'text_delta',text:'restored',phase:'final_answer'}); emit({type:'done',stopReason:'stop',endTurn:true}); }}));",
    "const value = await result.json(); if (result.status !== 200 || value.status !== 'completed') throw new Error('Restart continuation rejected');",
    "console.log('RESTORED');",
  ].join("\n"));
  const child = Bun.spawn([process.execPath, script], { env: { ...process.env, CODEX_CHATGPT_WEB_HOME: f.root }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" }); expect(stdout.trim()).toBe("RESTORED");
});

test("a cached response cannot be rebound to another thread or account", async () => {
  const f = fixture(); const id = await responseId(await f.handler(f.body("Only owner may continue")));
  for (const [body, overrides] of [[f.body("Foreign thread", id, randomUUID()), {}], [f.body("Foreign account", id), { accountId: "another-account" }]] as const) {
    const response = await f.handler(body, overrides);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: "previous_response_identity_mismatch", retryable: false });
  }
  expect(f.seen).toHaveLength(1);
});

test("unknown IDs fail closed even if an unbound transient cache entry exists", async () => {
  const f = fixture(); const id = "resp_unknown_" + randomUUID();
  rememberResponseState(f.body("Cached but unproven"), { id, status: "completed", output: [] }, { force: true });
  const response = await f.handler(f.body("Do not guess ownership", id));
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("previous_response_unavailable");
  expect(f.seen).toHaveLength(0);
});

test("a saved response requires explicit same-thread identity and cannot trust a caller's private flag", async () => {
  const f = fixture(); const id = await responseId(await f.handler(f.body()));
  const { client_metadata: _identity, ...anonymous } = f.body("No identity", id);
  expect(parseRequest({ ...anonymous, _chatgptSavedConversationContinuation: true })._chatgptSavedConversationContinuation).toBeUndefined();
  const response = await f.handler(anonymous);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("saved_response_identity_missing");
  expect(f.seen).toHaveLength(1);
});

test("an alias cannot silently replace a missing or changed saved-chat mapping", async () => {
  const f = fixture(); const id = await responseId(await f.handler(f.body()));
  const path = join(f.store.directory, hash(f.key) + ".json");
  const entry = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...entry, url: "https://chatgpt.com/c/a-different-chat" }));
  const changed = await f.handler(f.body("Changed mapping", id));
  expect(changed.status).toBe(409); expect((await changed.json()).error.code).toBe("previous_response_saved_chat_unavailable");
  rmSync(path);
  const missing = await f.handler(f.body("Lost mapping", id));
  expect(missing.status).toBe(409); expect((await missing.json()).error.code).toBe("previous_response_saved_chat_unavailable");
  expect(f.seen).toHaveLength(1);
});

test("temporary chats retain cache expansion and expiry rejection without aliases", async () => {
  const f = fixture(); const id = await responseId(await f.handler(f.body("Temporary baseline"), { useSavedChats: false }));
  expect(f.aliases.lookup(id)).toBeUndefined();
  await responseId(await f.handler(f.body("Second question", id), { useSavedChats: false }));
  expect(f.seen.at(-1)!._chatgptSavedConversationContinuation).toBeUndefined();
  expect(f.seen.at(-1)!.context.messages.length).toBeGreaterThan(1);
  const now = spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
  try { expect((await f.handler(f.body("Too late", id), { useSavedChats: false })).status).toBe(409); }
  finally { now.mockRestore(); }
});

test("compaction, manual/tools, fresh chats and Luna never opt into saved response aliases", () => {
  const f = fixture(), provider = providerConfig(f.config), parsed = parseRequest(f.body()); routeChatGptWebRequest(parsed, f.config);
  expect(supportsSavedChatAliases(provider, parsed)).toBe(true);
  for (const chatgptWeb of [
    { ...provider.chatgptWeb, localToolsEnabled: true }, { ...provider.chatgptWeb, useSavedChats: false },
    { ...provider.chatgptWeb, browserInteractionMode: "manual" as const },
    { ...provider.chatgptWeb, experimentalFreshConversationPerTurn: true },
  ]) expect(supportsSavedChatAliases({ ...provider, chatgptWeb }, parsed)).toBe(false);
  expect(supportsSavedChatAliases(provider, { ...parsed, _compactionRequest: true })).toBe(false);
  expect(supportsSavedChatAliases(provider, { ...parsed, modelId: "gpt-5.6-luna" })).toBe(false);
  for (const status of ["failed", "incomplete", "in_progress"]) {
    rememberSavedChatResponseAlias(provider, parsed, { id: "resp_" + status, output: [], status });
    expect(f.aliases.lookup("resp_" + status)).toBeUndefined();
  }
});

test("alias registry is immutable and private; an explicit limit never expires existing IDs", () => {
  const f = fixture(); const aliases = new SavedChatResponseAliases(f.config.conversationStoreDirectory, 2);
  const binding = { account: hash(f.account), thread: hash(f.thread), conversation: f.key, savedChat: hash(f.store.lookup(f.key)!.url!) };
  aliases.remember("resp_first", binding); aliases.remember("resp_first", binding);
  expect(() => aliases.remember("resp_first", { ...binding, thread: hash("foreign") })).toThrow("cannot be rebound");
  aliases.remember("resp_second", binding);
  expect(() => aliases.remember("resp_third", binding)).toThrow("registry is full");
  expect(aliases.lookup("resp_first")).toMatchObject(binding);
  const unlimited = new SavedChatResponseAliases(f.config.conversationStoreDirectory);
  unlimited.remember("resp_third", binding);
  expect(unlimited.lookup("resp_first")).toMatchObject(binding);
  expect(unlimited.lookup("resp_third")).toMatchObject(binding);
  if (process.platform !== "win32") expect(statSync(aliases.path).mode & 0o777).toBe(0o600);
});

test("SSE completion writes an alias before exposing response.completed", async () => {
  const f = fixture(); const response = await f.handler(f.body("Stream this", undefined, f.thread, true));
  const wire = await response.text();
  const line = wire.split("\n").find(value => value.startsWith('data: {"type":"response.completed"'));
  expect(line).toBeDefined();
  const id = JSON.parse(line!.slice(6)).response.id;
  expect(f.aliases.lookup(id)?.conversation).toBe(f.key);
});

for (const stream of [false, true]) {
  test("alias write failure never reports a successful completion (stream=" + stream + ")", async () => {
    const f = fixture();
    mkdirSync(f.aliases.path);
    const response = await f.handler(f.body("Fail closed if the metadata cannot be saved", undefined, f.thread, stream));
    if (stream) {
      const wire = await response.text();
      expect(wire).toContain("response.failed");
      expect(wire).not.toContain("response.completed");
    } else {
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatchObject({ code: "saved_response_alias_store_unavailable", retryable: false });
    }
  });
}

test("the real adapter refuses a fresh-chat fallback for a verified alias", async () => {
  const f = fixture(); const id = await responseId(await f.handler(f.body("Original saved turn")));
  const provider = providerConfig(f.config), worker = ChatGptBrowserWorker.forProvider(provider);
  let submissions = 0;
  const run = spyOn(worker, "run").mockImplementation(async turn => {
    await turn.prepare(); submissions++; return "Wrong new chat";
  });
  try {
    const response = await responseRequest(new Request("http://isolated.test/v1/responses", { method: "POST", body: JSON.stringify(f.body("Continuation", id)) }), f.config);
    const body = await response.json();
    expect(body.status).toBe("failed"); expect(body.error.code).toBe("saved_conversation_not_restored"); expect(submissions).toBe(0);
  } finally { run.mockRestore(); await TurnBroker.forSocket(f.config.brokerSocketPath).close(); }
});
