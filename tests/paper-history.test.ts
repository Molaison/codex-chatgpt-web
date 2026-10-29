import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaPool, type QaPoolConfig } from "../src/qa-pool";
import { PaperError, poolSessionHash } from "../src/paper-registry";
import { parsePaperHistory, readLauncherPaperHistory, type PaperHistoryReader, type PaperHistoryRead } from "../src/paper-history";
import { readLauncherPaperRecovery, type PaperRecoveryReader } from "../src/paper-recovery";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } from "../src/adapters/chatgpt-web/qa-conversation-key";

const projectId = "g-p-" + "a".repeat(32), accountId = "a", conversationId = "existing-conversation";
const paperId = "doi:10.1234/history", aliasId = "sha256:" + "b".repeat(64), threadId = "paper-existing";
const conversationUrl = `https://chatgpt.com/g/${projectId}/c/${conversationId}`;
const message = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({
  id, author: { role }, content: { content_type: "text", parts: [text] }, create_time: null, ...extra,
});
function conversation(): any {
  return { conversation_id: conversationId, gizmo_id: projectId, title: "Existing paper", is_temporary_chat: false,
    async_status: null, current_node: "msg-answer", context_truncation_continuation: null,
    page_info: { start_cursor: "msg-user", end_cursor: "msg-answer", has_previous_page: false, has_next_page: false },
    messages: [
      message("msg-user", "user", "Question", { create_time: 1700000000.125, metadata: { request_id: "current-request" } }),
      message("msg-answer", "assistant", "Answer", { create_time: 1700000001, channel: "final", status: "finished_successfully",
        end_turn: true, metadata: { request_id: "current-request" } }),
    ] };
}

test("history uses the current native reader and exports only visible body text in message order", () => {
  expect(readLauncherPaperHistory).toBe(readLauncherPaperRecovery);
  const value = conversation();
  value.messages = [
    message("system", "system", "SYSTEM SECRET"),
    message("user", "user", "  Literal accessToken=example blob:example data:example\n", { create_time: 20 }),
    message("developer", "developer", "DEVELOPER SECRET"),
    message("analysis", "assistant", "REASONING SECRET", { channel: "analysis" }),
    message("native-thoughts", "assistant", "", { channel: null, content: { content_type: "thoughts", thoughts: [{ summary: "HIDDEN SECRET" }], source_analysis_msg_id: "analysis" } }),
    message("native-recap", "assistant", "", { channel: null, content: { content_type: "reasoning_recap", content: "HIDDEN SECRET" } }),
    message("tool-call", "assistant", "TOOL CALL SECRET", { recipient: "python" }),
    message("tool", "tool", "TOOL SECRET"),
    message("hidden1", "assistant", "HIDDEN SECRET", { hidden: true }),
    message("hidden2", "user", "HIDDEN SECRET", { metadata: { hidden: true } }),
    message("hidden3", "assistant", "HIDDEN SECRET", { metadata: { is_hidden: true } }),
    message("hidden4", "assistant", "HIDDEN SECRET", { metadata: { is_visually_hidden_from_conversation: true } }),
    message("hidden5", "user", "HIDDEN SECRET", { metadata: { is_user_system_message: true } }),
    message("hidden6", "assistant", "HIDDEN SECRET", { metadata: { is_redacted: true } }),
    message("commentary", "assistant", "Visible commentary", { channel: "commentary", recipient: "all", create_time: 10 }),
    message("attachment", "user", "", { content: { content_type: "multimodal_text", parts: ["Text beside attachment",
      { content_type: "image_asset_pointer", asset_pointer: "ATTACHMENT SECRET" }] },
      metadata: { attachments: [{ id: "file-secret", accessToken: "TOKEN SECRET" }] } }),
    message("final", "assistant", "Answer\n\n  with whitespace  ", { channel: "final", recipient: "all" }),
  ];
  value.page_info.start_cursor = "system"; value.page_info.end_cursor = value.current_node = "final";
  const result = parsePaperHistory(value, conversationUrl);
  expect(result).toEqual({ title: "Existing paper", messages: [
    { id: "user", role: "user", text: "  Literal accessToken=example blob:example data:example\n", created_at: 20000 },
    { id: "commentary", role: "assistant", text: "Visible commentary", created_at: 10000 },
    { id: "attachment", role: "user", text: "Text beside attachment", created_at: null },
    { id: "final", role: "assistant", text: "Answer\n\n  with whitespace  ", created_at: null },
  ] });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|file-secret|asset_pointer/);
});

const invalidHistories: Array<[string, (value: any) => void]> = [
  ["old mapping schema", value => { value.mapping = {}; delete value.messages; }],
  ["foreign conversation", value => { value.conversation_id = "other"; }],
  ["foreign project", value => { value.gizmo_id = "g-p-" + "c".repeat(32); }],
  ["temporary chat", value => { value.is_temporary_chat = true; }],
  ["previous page", value => { value.page_info.has_previous_page = true; }],
  ["next page", value => { value.page_info.has_next_page = true; }],
  ["truncated context", value => { value.context_truncation_continuation = {}; }],
  ["missing truncation evidence", value => { delete value.context_truncation_continuation; }],
  ["missing current head", value => { delete value.current_node; }],
  ["wrong end cursor", value => { value.page_info.end_cursor = "other"; }],
  ["wrong start cursor", value => { value.page_info.start_cursor = "other"; }],
  ["old head", value => { value.current_node = value.page_info.end_cursor = "msg-user"; }],
  ["duplicate IDs", value => { value.messages.splice(1, 0, value.messages[0]); }],
  ["unknown visible content", value => { value.messages[1].content = { content_type: "unknown", parts: ["A"] }; }],
  ["malformed visible text", value => { value.messages[1].content.parts = [42]; }],
  ["malformed timestamp", value => { value.messages[0].create_time = "today"; }],
  ["unsafe timestamp", value => { value.messages[0].create_time = 1e30; }],
  ["malformed hidden flag", value => { value.messages[1].hidden = "true"; }],
];
test("history rejects incomplete or mismatched native branches and unknown visible formats", () => {
  for (const [label, mutate] of invalidHistories) {
    const value = conversation(); mutate(value);
    expect(() => parsePaperHistory(value, conversationUrl), label).toThrow(PaperError);
  }
  for (const url of [conversationUrl + "?token=example", "https://chatgpt.com/c/other", "https://foreign.test/c/other"]) {
    expect(() => parsePaperHistory(conversation(), url)).toThrow(PaperError);
  }
});
test("history keeps titles, null timestamps and literal text while skipping empty body and hidden unknown formats", () => {
  const value = conversation();
  value.title = "accessToken=literal blob:literal data:literal";
  value.messages[0].create_time = undefined; value.messages[1].create_time = null;
  value.messages.splice(1, 0, message("empty", "assistant", "  "), message("hidden", "assistant", "", {
    channel: "analysis", content: { content_type: "unknown-hidden-format" } }));
  const result = parsePaperHistory(value, conversationUrl);
  expect(result.title).toBe(value.title);
  expect(result.messages.map(message => message.created_at)).toEqual([null, null]);
  expect(result.messages.map(message => message.text)).toEqual(["Question", "Answer"]);
});

function setup(reader: PaperHistoryReader, backendHandler?: () => Promise<Response>, recoveryReader?: PaperRecoveryReader) {
  const root = mkdtempSync(join(tmpdir(), "paper-history-test-"));
  const key = "h".repeat(32), otherKey = "o".repeat(32);
  writeFileSync(join(root, "key"), key); writeFileSync(join(root, "other-key"), otherKey);
  let generations = 0;
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    generations++;
    return backendHandler ? backendHandler() : Response.json({ id: "resp-test", status: "completed", output: [] });
  } });
  const config: QaPoolConfig = { host: "127.0.0.1", port: 0, databasePath: join(root, "pool.sqlite"),
    clients: [{ id: "cpr", keyFile: join(root, "key") }, { id: "other", keyFile: join(root, "other-key") }],
    accounts: [{ id: accountId, origin: backend.url.origin, models: ["standard"], conversationStoreDirectory: join(root, "store"), browserHostDescriptorPath: join(root, "unused-descriptor") }],
    projectRoutes: [{ name: "papers", accountId, projectId, sessionNamespace: "papers", paperRegistry: true }, { name: "other", accountId, projectId }],
  };
  const pool = createQaPool(config, { paperHistoryReader: reader, paperRecoveryReader: recoveryReader });
  const db = new Database(config.databasePath);
  const sessionHash = poolSessionHash(["cpr", "papers"], threadId);
  db.query("INSERT INTO sessions(session_hash,account_id,created_at,project_id,project_name) VALUES(?,?,?,?,?)").run(sessionHash, accountId, "2026-01-01", projectId, "papers");
  db.query("INSERT INTO papers(paper_id,session_key,account_id,project_id,thread_id,session_hash,state,upload_token,expires_at,conversation_url,pdf_sha256,in_flight) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(paperId, "", accountId, projectId, threadId, sessionHash, "ready", null, null, conversationUrl, "b".repeat(64), 0);
  db.query("INSERT INTO paper_aliases VALUES(?,?)").run(aliasId, paperId);
  const store = new ChatGptConversationStore(config.accounts[0].conversationStoreDirectory!, accountId);
  const nativeKey = chatGptQuestionAnswerKey("qa-pool-" + sessionHash, chatGptQuestionAnswerNamespace(accountId));
  store.bind(nativeKey, store.reserve(nativeKey), conversationUrl);
  const mappingPath = join(store.directory, createHash("sha256").update(nativeKey).digest("hex") + ".json");
  const request = (metadata: Record<string, unknown> = {}, payload: Record<string, unknown> = {}, options: { path?: string; key?: string; signal?: AbortSignal } = {}) => pool.fetch(new Request("http://pool" + (options.path ?? "/project/papers/v1/responses"), {
    method: "POST", signal: options.signal, headers: { authorization: "Bearer " + (options.key ?? key), "content-type": "application/json" },
    body: JSON.stringify({ model: "standard", client_metadata: { "x-codex-turn-metadata": JSON.stringify({ paper_id: paperId, paper_operation: "history", ...metadata }) }, ...payload }),
  }));
  const snapshot = () => ({ version: db.query("PRAGMA data_version").get(),
    sessions: db.query("SELECT * FROM sessions ORDER BY session_hash").all(), papers: db.query("SELECT * FROM papers ORDER BY paper_id").all(),
    aliases: db.query("SELECT * FROM paper_aliases ORDER BY alias_id").all(), events: db.query("SELECT * FROM paper_events ORDER BY id").all(),
    temporary: db.query("SELECT * FROM temporary_history ORDER BY session_hash").all(), mapping: readFileSync(mappingPath, "utf8") });
  return { config, db, request, snapshot, mappingPath, sessionHash, otherKey, generations: () => generations,
    close() { pool.close(); db.close(); backend.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

test("JSON and SSE share completed Responses, zero usage, alias identity and verified URL without any DB or mapping changes", async () => {
  const reads: PaperHistoryRead[] = [];
  const fixture = setup(async request => { reads.push(request); return conversation(); });
  try {
    const before = fixture.snapshot();
    const json = await fixture.request({ paper_id: "DOI:https://doi.org/10.1234%2FHISTORY", conversation_url: "https://evil.test/c/other", thread_id: "client-forged", paper_pdf_sha256: "invalid", paper_upload_token: "forged" });
    expect(json.status).toBe(200);
    const response = await json.json();
    expect(response.status).toBe("completed");
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    const expected = { paper_id: paperId, paper_registry_version: 2, paper_session_id: "", thread_id: threadId, conversation_url: conversationUrl, title: "Existing paper", messages: [
      { id: "msg-user", role: "user", text: "Question", created_at: 1700000000125 },
      { id: "msg-answer", role: "assistant", text: "Answer", created_at: 1700000001000 },
    ] };
    expect(JSON.parse(response.output_text)).toEqual(expected);
    expect(response.output[0].content[0].text).toBe(response.output_text);
    const sse = await fixture.request({ paper_id: aliasId }, { stream: true });
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    const events = (await sse.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(events.map(event => event.type)).toEqual(["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    expect(events.map(event => event.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(JSON.parse(events[4].delta)).toEqual({ ...expected, paper_id: aliasId });
    expect(events[8].response.usage).toEqual(response.usage);
    expect(events[8].response.status).toBe("completed");
    expect(JSON.parse(events[8].response.output_text)).toEqual({ ...expected, paper_id: aliasId });
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ accountId, sessionHash: fixture.sessionHash, conversationUrl });
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.generations()).toBe(0);
  } finally { fixture.close(); }
});

test("unknown/no conversation are 404; busy is 409; uncertain reads preserve state; missing descriptor is 503", async () => {
  let reads = 0;
  const fixture = setup(async () => { reads++; return conversation(); });
  try {
    const before = fixture.snapshot();
    expect((await fixture.request({ paper_id: "doi:10.1234/unknown" })).status).toBe(404);
    expect(fixture.snapshot()).toEqual(before);
    fixture.db.query("UPDATE papers SET in_flight=1").run();
    const busyBefore = fixture.snapshot();
    expect((await fixture.request()).status).toBe(409);
    expect(fixture.snapshot()).toEqual(busyBefore);
    fixture.db.query("UPDATE papers SET in_flight=0,state='uncertain'").run();
    const uncertainBefore = fixture.snapshot();
    expect((await fixture.request()).status).toBe(200);
    expect(fixture.snapshot()).toEqual(uncertainBefore);
    const saved = readFileSync(fixture.mappingPath, "utf8");
    rmSync(fixture.mappingPath);
    expect((await fixture.request()).status).toBe(404);
    writeFileSync(fixture.mappingPath, "{malformed");
    expect((await fixture.request()).status).toBe(409);
    writeFileSync(fixture.mappingPath, saved);
    fixture.db.query("DELETE FROM sessions").run();
    expect((await fixture.request()).status).toBe(404);
    fixture.config.accounts[0].browserHostDescriptorPath = undefined;
    const unavailable = await fixture.request();
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("paper_history_unavailable");
    expect(reads).toBe(1);
    expect(fixture.generations()).toBe(0);
  } finally { fixture.close(); }
});

test("history enforces authenticated route, account models and alias scope before invoking the reader", async () => {
  let reads = 0;
  const fixture = setup(async () => { reads++; return conversation(); });
  try {
    const before = fixture.snapshot();
    expect((await fixture.request({}, {}, { key: "bad" })).status).toBe(401);
    expect((await fixture.request({}, {}, { key: fixture.otherKey })).status).toBe(409);
    expect((await fixture.request({}, {}, { path: "/project/other/v1/responses" })).status).toBe(409);
    expect((await fixture.request({}, {}, { path: "/project/papers/v1/responses/compact" })).status).toBe(409);
    expect((await fixture.request({}, { model: "unsupported" })).status).toBe(400);
    fixture.config.projectRoutes![0].modelAliases = { public: "unsupported", reading: "standard" };
    expect((await fixture.request({}, { model: "public" })).status).toBe(400);
    expect((await fixture.request({}, { model: "reading" })).status).toBe(200);
    delete fixture.config.projectRoutes![0].modelAliases;
    fixture.config.projectRoutes![0].sessionNamespace = "different";
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(409);
    fixture.config.projectRoutes![0].sessionNamespace = "papers";
    fixture.config.projectRoutes![0].projectId = "g-p-" + "c".repeat(32);
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(409);
    fixture.config.projectRoutes![0].projectId = projectId;
    fixture.config.accounts[0].id = "b"; fixture.config.projectRoutes![0].accountId = "b";
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(409);
    expect(reads).toBe(1);
    expect(fixture.generations()).toBe(0);
    expect(fixture.snapshot()).toEqual(before);
  } finally { fixture.close(); }
});

test("in-memory history lock covers aliases and blocks chat before prepare/begin; failures release it without writes", async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<unknown>();
  let reads = 0;
  const fixture = setup(async () => { reads++; if (reads === 1) { entered.resolve(); return finish.promise; } return conversation(); });
  try {
    const before = fixture.snapshot();
    const pending = fixture.request();
    await entered.promise;
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(409);
    expect((await fixture.request({ paper_id: aliasId, paper_operation: "chat" }, { input: "Do not send" })).status).toBe(409);
    expect(reads).toBe(1);
    expect(fixture.generations()).toBe(0);
    expect(fixture.snapshot()).toEqual(before);
    finish.reject(new Error("reader failed with private detail accessToken=SECRET"));
    const failed = await pending;
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("SECRET");
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(200);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.generations()).toBe(0);
  } finally { finish.resolve(conversation()); fixture.close(); }
});

test("chat in flight rejects history until its existing completion path releases ownership", async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<Response>();
  let reads = 0;
  const fixture = setup(async () => { reads++; return conversation(); }, async () => { entered.resolve(); return finish.promise; });
  try {
    const pending = fixture.request({ paper_operation: "chat" }, { input: "Only the isolated test backend receives this" });
    await entered.promise;
    const during = fixture.snapshot();
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(409);
    expect(reads).toBe(0);
    expect(fixture.snapshot()).toEqual(during);
    finish.resolve(Response.json({ id: "resp-test", status: "completed", output: [] }));
    expect((await pending).status).toBe(200);
    const afterChat = fixture.snapshot();
    expect((await fixture.request()).status).toBe(200);
    expect(fixture.snapshot()).toEqual(afterChat);
    expect(fixture.generations()).toBe(1);
  } finally { finish.resolve(Response.json({})); fixture.close(); }
});

test("malformed reader results return explicit errors without state changes or a completed SSE; the next read can succeed", async () => {
  let invalid = true;
  const fixture = setup(async () => invalid ? { ...conversation(), current_node: null } : conversation());
  try {
    const before = fixture.snapshot();
    const response = await fixture.request({}, { stream: true });
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("history_format_invalid");
    invalid = false;
    expect((await fixture.request()).status).toBe(200);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.generations()).toBe(0);
  } finally { fixture.close(); }
});

test("history blocks uncertain reconciliation and chat through every alias without registry writes", async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<unknown>();
  let historyReads = 0, recoveryReads = 0;
  const fixture = setup(async () => { historyReads++; entered.resolve(); return finish.promise; }, undefined,
    async () => { recoveryReads++; return conversation(); });
  try {
    fixture.db.query("UPDATE papers SET state='uncertain'").run();
    fixture.db.query("INSERT INTO paper_events(paper_id,at,event,detail) VALUES(?,?,?,?)")
      .run(paperId, "2020-01-01T00:00:00.000Z", "dispatch_started", "");
    const before = fixture.snapshot();
    const pending = fixture.request();
    await entered.promise;
    const blocked = await fixture.request({ paper_id: aliasId, paper_operation: "resolve" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("paper_busy");
    expect((await fixture.request({ paper_id: aliasId, paper_operation: "chat" }, { input: "Do not send" })).status).toBe(409);
    expect(fixture.snapshot()).toEqual(before);
    expect(recoveryReads).toBe(0); expect(fixture.generations()).toBe(0);
    finish.resolve(conversation());
    expect((await pending).status).toBe(200);
    expect(fixture.snapshot()).toEqual(before);
    const resumed = await fixture.request({ paper_id: aliasId, paper_operation: "resolve" });
    expect(resumed.status).toBe(200);
    expect(JSON.parse((await resumed.json()).output_text)).toMatchObject({ paper_id: aliasId, status: "ready", thread_id: threadId });
    expect(historyReads).toBe(1); expect(recoveryReads).toBe(1);
  } finally { finish.resolve(conversation()); fixture.close(); }
});

test("reconciliation blocks history and chat through aliases until its existing completion path finishes", async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<unknown>();
  let historyReads = 0, recoveryReads = 0;
  const fixture = setup(async () => { historyReads++; return conversation(); }, undefined,
    async () => { recoveryReads++; entered.resolve(); return finish.promise; });
  try {
    fixture.db.query("UPDATE papers SET state='uncertain'").run();
    fixture.db.query("INSERT INTO paper_events(paper_id,at,event,detail) VALUES(?,?,?,?)")
      .run(paperId, "2020-01-01T00:00:00.000Z", "dispatch_started", "");
    const before = fixture.snapshot();
    const pending = fixture.request({ paper_operation: "resolve" });
    await entered.promise;
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(409);
    expect((await fixture.request({ paper_id: aliasId, paper_operation: "chat" }, { input: "Do not send" })).status).toBe(409);
    expect(fixture.snapshot()).toEqual(before);
    expect(historyReads).toBe(0); expect(recoveryReads).toBe(1); expect(fixture.generations()).toBe(0);
    finish.resolve(conversation());
    expect((await pending).status).toBe(200);
    const afterRecovery = fixture.snapshot();
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(200);
    expect(fixture.snapshot()).toEqual(afterRecovery);
    expect(historyReads).toBe(1);
    expect((fixture.db.query("SELECT count(*) n FROM paper_events WHERE event='response_reconciled'").get() as any).n).toBe(1);
  } finally { finish.resolve(conversation()); fixture.close(); }
});

test("aborted history releases its canonical lock without accepting a late result or changing the registry", async () => {
  const entered = Promise.withResolvers<void>();
  let reads = 0;
  const fixture = setup(async request => {
    reads++;
    if (reads > 1) return conversation();
    entered.resolve();
    return await new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  });
  try {
    const before = fixture.snapshot(), abort = new AbortController();
    const pending = fixture.request({}, {}, { signal: abort.signal });
    await entered.promise;
    abort.abort();
    const response = await pending;
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("paper_history_unavailable");
    expect((await fixture.request({ paper_id: aliasId })).status).toBe(200);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.generations()).toBe(0); expect(reads).toBe(2);
  } finally { fixture.close(); }
});
