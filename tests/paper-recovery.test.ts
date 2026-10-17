import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { PaperRegistry, PaperError, type PaperScope } from "../src/paper-registry";
import { createQaPool, type QaPoolConfig } from "../src/qa-pool";
import { withPaperRecoveryTextRequests, type PaperRecoveryReader } from "../src/paper-recovery";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } from "../src/adapters/chatgpt-web/qa-conversation-key";

const projectId = "g-p-" + "a".repeat(32), accountId = "account-a";
const paperId = "doi:10.1234/recovery", aliasId = "doi:10.1234/recovery-alias", conversationId = "saved-paper";
const conversationUrl = `https://chatgpt.com/g/${projectId}/c/${conversationId}`;
const dispatchStartedAt = "2026-01-01T00:00:00.000Z", userTime = Date.parse(dispatchStartedAt) / 1000 + 1;
function conversation(): any {
  return {
    conversation_id: conversationId, gizmo_id: projectId, is_temporary_chat: false, async_status: null,
    current_node: "final", context_truncation_continuation: null,
    page_info: { start_cursor: "system", end_cursor: "final", has_previous_page: false, has_next_page: false },
    messages: [
      { id: "system", author: { role: "system" }, content: { content_type: "text", parts: ["System fixture"] } },
      { id: "user", author: { role: "user" }, create_time: userTime, channel: null, recipient: "all",
        metadata: { request_id: "request-current", attachments: [{ id: "file-pdf", mime_type: "application/pdf", size: 100, name: "fixture.pdf" }] },
        content: { content_type: "text", parts: ["Fixture question"] } },
      { id: "analysis", author: { role: "assistant" }, channel: "analysis",
        content: { content_type: "text", parts: ["Hidden fixture must never leave the validator"] } },
      { id: "final", author: { role: "assistant" }, channel: "final", recipient: "all",
        status: "finished_successfully", end_turn: true, metadata: { request_id: "request-current" },
        content: { content_type: "text", parts: ["Fixture answer"] } },
    ],
  };
}
function fixture(existingReady = false) {
  const root = mkdtempSync(join(tmpdir(), "paper-recovery-")), db = new Database(join(root, "pool.sqlite"));
  // Commit the real file-backed fixture once; reconciliation still runs outside a transaction.
  const { registry, scope, sha, mappingPath } = db.transaction(() => {
    db.exec("CREATE TABLE sessions(session_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at TEXT NOT NULL,project_id TEXT,project_name TEXT)");
    const registry = new PaperRegistry(db), scope: PaperScope = { accountId, projectId, sessionScope: ["cpr", "papers"], directory: join(root, "native") };
    const reservation = registry.resolve(paperId, scope, {}), row = registry.get(paperId);
    db.query("INSERT INTO sessions VALUES(?,?,?,?,?)").run(row.session_hash, accountId, dispatchStartedAt, projectId, "papers");
    const pdf = Buffer.from("%PDF-1.4\nRecovery fixture\n%%EOF"), sha = createHash("sha256").update(pdf).digest("hex");
    registry.prepare(paperId, scope, { paper_upload_token: reservation.upload_token, paper_pdf_sha256: sha }, [
      { role: "user", content: [{ type: "input_text", text: "Fixture question" }, { type: "input_file", file_data: "data:application/pdf;base64," + pdf.toString("base64") }] },
    ]);
    const store = new ChatGptConversationStore(scope.directory, accountId);
    const nativeKey = chatGptQuestionAnswerKey("qa-pool-" + row.session_hash, chatGptQuestionAnswerNamespace(accountId));
    store.bind(nativeKey, store.reserve(nativeKey), conversationUrl);
    const mappingPath = join(store.directory, createHash("sha256").update(nativeKey).digest("hex") + ".json");
    if (existingReady) {
      registry.begin(paperId); registry.complete(paperId, scope); registry.finish(paperId, true);
    }
    registry.begin(paperId);
    db.query("UPDATE paper_events SET at=? WHERE id=(SELECT max(id) FROM paper_events WHERE event='dispatch_started')").run(dispatchStartedAt);
    registry.finish(paperId, false);
    db.query("INSERT INTO paper_aliases VALUES(?,?)").run(aliasId, paperId);
    return { registry, scope, sha, mappingPath };
  }).immediate();
  const options = (reader: PaperRecoveryReader) => ({ reader, browserHostDescriptorPath: join(root, "unused-descriptor"), signal: new AbortController().signal });
  const snapshot = () => ({ papers: db.query("SELECT * FROM papers").all(), events: db.query("SELECT * FROM paper_events").all(), mapping: readFileSync(mappingPath, "utf8") });
  return { root, db, registry, scope, row: registry.get(paperId), sha, mappingPath, options, snapshot,
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("first upload recovers using verified hash, saved PDF and current terminal; aliases retain canonical ownership", async () => {
  const f = fixture();
  try {
    const beforeMapping = readFileSync(f.mappingPath, "utf8"), beforeRow = f.registry.get(paperId);
    let reads = 0;
    const result = await f.registry.reconcile(aliasId, f.scope, f.options(async request => {
      reads++;
      expect(f.db.inTransaction).toBe(false);
      expect(request).toMatchObject({ accountId, sessionHash: f.row.session_hash, conversationUrl });
      return conversation();
    }));
    expect(result).toMatchObject({ paper_id: aliasId, status: "ready", upload_required: false, thread_id: beforeRow.thread_id, conversation_url: conversationUrl });
    expect(reads).toBe(1);
    expect(f.registry.get(paperId)).toEqual({ ...beforeRow, state: "ready", conversation_url: conversationUrl, upload_token: null, expires_at: null });
    expect(readFileSync(f.mappingPath, "utf8")).toBe(beforeMapping);
    const event = f.db.query<{ detail: string }, []>("SELECT detail FROM paper_events WHERE event='response_reconciled'").get()!;
    expect(JSON.parse(event.detail)).toMatchObject({ user_id: "user", terminal_id: "final", request_id: "request-current", file_id: "file-pdf", body_chars: 14, dispatch_started_at: dispatchStartedAt });
    expect(event.detail).not.toContain("Fixture answer");
    expect(event.detail).not.toContain("Hidden fixture");
    expect(f.registry.resolve(aliasId, f.scope, {}).status).toBe("ready");
    await expect(f.registry.reconcile(paperId, f.scope, f.options(async () => { reads++; return conversation(); }))).rejects.toMatchObject({ code: "paper_recovery_state_changed" });
    expect(reads).toBe(1);
  } finally { f.close(); }
});

test("a failed continuation reuses registered PDF even with earlier pages omitted and no attachment in this question", async () => {
  const f = fixture(true);
  try {
    const value = conversation();
    value.page_info.has_previous_page = true;
    value.context_truncation_continuation = { omitted: true };
    delete value.messages[1].metadata.attachments;
    // Legacy-adopted ready papers can have a valid saved URL without a recorded hash.
    f.db.query("UPDATE papers SET pdf_sha256=NULL").run();
    const result = await f.registry.reconcile(paperId, f.scope, f.options(async () => value));
    expect(result.status).toBe("ready");
    const event = f.db.query<{ detail: string }, []>("SELECT detail FROM paper_events WHERE event='response_reconciled'").get()!;
    expect(JSON.parse(event.detail).file_id).toBeNull();
  } finally { f.close(); }
});

const rejected: Array<[string, string, (value: any) => void]> = [
  ["running", "running", value => { value.async_status = "in_progress"; }],
  ["old head", "head_unverified", value => { value.current_node = "older"; }],
  ["unfinished pagination", "head_unverified", value => { value.page_info.has_next_page = true; }],
  ["foreign conversation", "identity_mismatch", value => { value.conversation_id = "other"; }],
  ["foreign project", "identity_mismatch", value => { value.gizmo_id = "g-p-" + "b".repeat(32); }],
  ["temporary", "temporary", value => { value.is_temporary_chat = true; }],
  ["older user", "user_unverified", value => { value.messages[1].create_time = userTime - 2; }],
  ["another request", "turn_mismatch", value => { value.messages[3].metadata.request_id = "other"; }],
  ["unfinished final", "terminal_unverified", value => { value.messages[3].end_turn = false; }],
  ["failed final", "terminal_unverified", value => { value.messages[3].status = "failed"; }],
  ["hidden final", "terminal_unverified", value => { value.messages[3].metadata.is_visually_hidden_from_conversation = true; }],
  ["reasoning head", "terminal_unverified", value => { value.messages[3].channel = "analysis"; }],
  ["empty body", "body_unverified", value => { value.messages[3].content.parts = [" "]; }],
  ["missing PDF", "pdf_unverified", value => { delete value.messages[1].metadata.attachments; }],
  ["filename-only PDF", "pdf_unverified", value => { delete value.messages[1].metadata.attachments[0].id; }],
  ["multiple PDFs", "pdf_unverified", value => { value.messages[1].metadata.attachments.push({ ...value.messages[1].metadata.attachments[0], id: "file-other" }); }],
  ["first-upload previous page", "page_incomplete", value => { value.page_info.has_previous_page = true; }],
  ["first-upload truncation", "page_incomplete", value => { value.context_truncation_continuation = {}; }],
  ["missing required status", "format_invalid", value => { delete value.async_status; }],
];
// Each rejection has its own real SQLite fixture and the default test deadline.
// A serial loop incorrectly charged all independent fixtures to one 5s budget.
test.each(rejected)("unverified native evidence (%s) leaves the actual SQLite row and event log unchanged", async (label, code, mutate) => {
  const f = fixture();
  try {
    const value = conversation(); mutate(value);
    const before = f.snapshot();
    await expect(f.registry.reconcile(paperId, f.scope, f.options(async () => value)), label).rejects.toMatchObject({ code: "paper_recovery_" + code });
    expect(f.snapshot(), label).toEqual(before);
  } finally { f.close(); }
});

test("a first upload requires the SHA verified by prepare, not a matching filename", async () => {
  const f = fixture();
  try {
    f.db.query("UPDATE papers SET pdf_sha256=NULL").run();
    const before = f.snapshot();
    await expect(f.registry.reconcile(paperId, f.scope, f.options(async () => conversation()))).rejects.toMatchObject({ code: "paper_recovery_pdf_unverified" });
    expect(f.snapshot()).toEqual(before);
  } finally { f.close(); }
});

test("ownership, native mapping and active dispatch are checked before reading", async () => {
  for (const kind of ["account", "session", "native", "busy", "no-dispatch"] as const) {
    const f = fixture();
    try {
      let reads = 0;
      if (kind === "account") f.scope.accountId = "another";
      if (kind === "session") f.db.query("DELETE FROM sessions").run();
      if (kind === "native") rmSync(f.mappingPath);
      if (kind === "busy") f.db.query("UPDATE papers SET in_flight=1").run();
      if (kind === "no-dispatch") f.db.query("DELETE FROM paper_events WHERE event='dispatch_started'").run();
      const beforeRow = f.registry.get(paperId);
      await expect(f.registry.reconcile(paperId, f.scope, f.options(async () => { reads++; return conversation(); }))).rejects.toThrow();
      expect(reads).toBe(0); expect(f.registry.get(paperId)).toEqual(beforeRow);
    } finally { f.close(); }
  }
});

test("two overlapping reconciliations commit exactly once", async () => {
  const f = fixture();
  try {
    let release!: (value: unknown) => void;
    const waiting = new Promise<unknown>(resolve => { release = resolve; });
    const first = f.registry.reconcile(paperId, f.scope, f.options(async () => waiting));
    const second = f.registry.reconcile(aliasId, f.scope, f.options(async () => waiting));
    release(conversation());
    const results = await Promise.allSettled([first, second]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.code).toBe("paper_recovery_state_changed");
    expect(f.db.query<{ count: number }, []>("SELECT count(*) count FROM paper_events WHERE event='response_reconciled'").get()!.count).toBe(1);
  } finally { f.close(); }
});

test("state, dispatch, alias and native-map changes during the read reject stale recovery", async () => {
  for (const kind of ["state", "busy", "dispatch", "dispatch-time", "alias", "mapping"] as const) {
    const f = fixture();
    try {
      const options = f.options(async () => {
        if (kind === "state") f.db.query("UPDATE papers SET state='reserved'").run();
        if (kind === "busy") f.db.query("UPDATE papers SET in_flight=1").run();
        if (kind === "dispatch") f.registry.event(paperId, "dispatch_started");
        if (kind === "dispatch-time") f.db.query("UPDATE paper_events SET at='2026-01-01T00:00:00.100Z' WHERE event='dispatch_started'").run();
        if (kind === "alias") f.db.query("DELETE FROM paper_aliases").run();
        if (kind === "mapping") {
          const value = JSON.parse(readFileSync(f.mappingPath, "utf8")); value.createdAt = "2025-01-01T00:00:00.000Z";
          writeFileSync(f.mappingPath, JSON.stringify(value));
        }
        return conversation();
      });
      await expect(f.registry.reconcile(aliasId, f.scope, options)).rejects.toMatchObject({ code: kind === "mapping" ? "paper_recovery_mapping_changed" : "paper_recovery_state_changed" });
      expect(f.db.query<{ count: number }, []>("SELECT count(*) count FROM paper_events WHERE event='response_reconciled'").get()!.count).toBe(0);
    } finally { f.close(); }
  }
});

test("read errors and cancellation never promote uncertain", async () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    await expect(f.registry.reconcile(paperId, f.scope, f.options(async () => { throw new Error("GET unavailable"); }))).rejects.toThrow("GET unavailable");
    const abort = new AbortController();
    await expect(f.registry.reconcile(paperId, f.scope, { ...f.options(async () => { abort.abort(); return conversation(); }), signal: abort.signal })).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
  } finally { f.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("browser request scope permits history GET and blocks send/upload/download, then removes its handler", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
  const received: string[] = [];
  // Every request is fulfilled locally; no external website is contacted.
  await context.route("**/*", route => {
    const request = route.request(), url = new URL(request.url());
    received.push(request.method() + " " + url.pathname);
    return route.fulfill({ contentType: url.pathname === "/" ? "text/html" : "application/json", body: url.pathname === "/" ? "<!doctype html><title>Recovery fixture</title>" : "{}" });
  });
  try {
    await page.goto("https://chatgpt.com/");
    received.length = 0;
    const results = await withPaperRecoveryTextRequests(page, () => page.evaluate(async () => {
      return await Promise.all([
        fetch("/backend-api/conversation/saved-paper").then(() => true, () => false),
        fetch("/backend-api/conversation", { method: "POST", body: "{}" }).then(() => true, () => false),
        fetch("/backend-api/files", { method: "POST", body: "{}" }).then(() => true, () => false),
        fetch("/backend-api/files/file-pdf/download").then(() => true, () => false),
        fetch("/fixture.pdf").then(() => true, () => false),
      ]);
    }));
    expect(results).toEqual([true, false, false, false, false]);
    expect(received).toEqual(["GET /backend-api/conversation/saved-paper"]);
    await page.evaluate(() => fetch("/after-recovery", { method: "POST", body: "{}" }));
    expect(received).toContain("POST /after-recovery");
  } finally { await browser.close(); }
});

test("pool recovery shares canonical and alias resolves without generation and preserves native failures", async () => {
  const f = fixture();
  const key = "r".repeat(32), keyFile = join(f.root, "client-key");
  writeFileSync(keyFile, key);
  let generations = 0, reads = 0, readingStarted!: () => void, releaseRead!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { readingStarted = resolve; });
  let pending: Promise<unknown> | undefined = new Promise(resolve => { releaseRead = resolve; });
  let nextValue: unknown = conversation(), nextError: PaperError | undefined;
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    generations++;
    return Response.json({ id: "unexpected-generation", status: "completed", output: [] });
  } });
  const config: QaPoolConfig = {
    host: "127.0.0.1", port: 0, databasePath: join(f.root, "pool.sqlite"),
    clients: [{ id: "cpr", keyFile }],
    accounts: [{ id: accountId, origin: backend.url.origin, models: ["standard"], conversationStoreDirectory: f.scope.directory }],
    projectRoutes: [{ name: "papers", sessionNamespace: "papers", accountId, projectId }],
  };
  const reader: PaperRecoveryReader = async request => {
    reads++;
    expect(request).toMatchObject({ accountId, sessionHash: f.row.session_hash, conversationUrl,
      browserHostDescriptorPath: join(f.root, "native-browser-descriptor") });
    readingStarted();
    if (nextError) throw nextError;
    return pending ?? nextValue;
  };
  let pool = createQaPool(config, { paperRecoveryReader: reader });
  const resolve = (id: string) => pool.fetch(new Request("http://pool/project/papers/v1/responses", {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: "standard", input: "Paper lookup",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ paper_id: id, paper_operation: "resolve" }) } }),
  }));
  try {
    const unconfigured = await resolve(paperId);
    expect(unconfigured.status).toBe(200);
    expect(JSON.parse((await unconfigured.json() as any).output_text).status).toBe("uncertain");
    expect(reads).toBe(0);
    pool.close();
    config.accounts[0]!.browserHostDescriptorPath = join(f.root, "native-browser-descriptor");
    pool = createQaPool(config, { paperRecoveryReader: reader });

    const first = resolve(paperId);
    await started;
    const second = resolve(aliasId);
    // Let both request bodies enter fetchRequest while the shared native read is held.
    await Bun.sleep(0);
    expect(reads).toBe(1);
    expect(f.registry.get(paperId).state).toBe("uncertain");
    expect(generations).toBe(0);
    releaseRead(conversation());
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const values = await Promise.all(responses.map(async response => JSON.parse((await response.json() as any).output_text)));
    expect(values.map(value => value.paper_id)).toEqual([paperId, aliasId]);
    for (const value of values) expect(value).toMatchObject({ status: "ready", thread_id: f.row.thread_id,
      upload_required: false, conversation_url: conversationUrl });
    expect(reads).toBe(1);
    expect(f.db.query<{ count: number }, []>("SELECT count(*) count FROM paper_events WHERE event='response_reconciled'").get()!.count).toBe(1);

    f.registry.begin(paperId);
    f.db.query("UPDATE paper_events SET at=? WHERE id=(SELECT max(id) FROM paper_events WHERE event='dispatch_started')").run(dispatchStartedAt);
    f.registry.finish(paperId, false);
    pending = undefined;
    nextValue = { ...conversation(), async_status: "in_progress" };
    const running = await resolve(aliasId);
    expect(running.status).toBe(409);
    expect((await running.json() as any).error.code).toBe("paper_recovery_running");
    expect(f.registry.get(paperId).state).toBe("uncertain");

    nextError = new PaperError("paper_recovery_unavailable", "Native saved conversation GET failed", 503);
    const unavailable = await resolve(paperId);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json() as any).error).toMatchObject({ code: "paper_recovery_unavailable", message: "Native saved conversation GET failed" });
    expect(f.registry.get(paperId).state).toBe("uncertain");
    expect(reads).toBe(3);
    expect(generations).toBe(0);
    expect(f.db.query<{ count: number }, []>("SELECT count(*) count FROM paper_events WHERE event='response_reconciled'").get()!.count).toBe(1);
  } finally { pool.close(); backend.stop(true); f.close(); }
});
