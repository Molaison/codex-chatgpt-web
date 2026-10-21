import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";

const denyNetwork = (async () => { throw new Error("Network is disabled in this audit replay"); }) as typeof fetch;
globalThis.fetch = denyNetwork;

function checkout(name: string): string {
  const configured = process.env[name];
  if (!configured) throw new Error(`Set ${name} to the local checkout root`);
  const directory = resolve(configured);
  if (!existsSync(join(directory, "src"))) throw new Error(`${name} must contain a src directory`);
  return directory;
}

function revision(directory: string): string {
  const result = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]);
  if (result.exitCode !== 0) throw new Error("The audit target must be a Git checkout");
  return new TextDecoder().decode(result.stdout).trim();
}

const upstreamRoot = checkout("PAPER_AUDIT_UPSTREAM_ROOT");
const upstreamRevision = revision(upstreamRoot);
const upstreamModule = (path: string) => import(pathToFileURL(join(upstreamRoot, path)).href);
const { createQaPool } = await upstreamModule("src/qa-pool.ts");
const { ChatGptConversationStore } = await upstreamModule("src/adapters/chatgpt-web/conversation-persistence.ts");
const { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } = await upstreamModule("src/adapters/chatgpt-web/qa-conversation-key.ts");

const downstreamRoot = checkout("PAPER_AUDIT_DOWNSTREAM_ROOT");
const downstreamRevision = revision(downstreamRoot);
const downstreamModule = (path: string) => import(pathToFileURL(join(downstreamRoot, path)).href);
const { poolSessionHash } = await upstreamModule("src/paper-registry.ts");
const { prepareCprPaperRequest } = await downstreamModule("src/utils/cprPapers.ts");
const { resetProviderSessionIdCacheForTests } = await downstreamModule("src/utils/providerSessionId.ts");

const root = mkdtempSync(join(tmpdir(), "review-paper-joint-"));
const key = "c".repeat(32), accountId = "account", projectId = "g-p-" + "c".repeat(32);
const apiBase = "http://127.0.0.1:43220/project/papers/v1";
const backendOrigin = "http://127.0.0.1:43219";
writeFileSync(join(root, "key"), key);
const store = new ChatGptConversationStore(join(root, "conversations"), accountId);
const config: Parameters<typeof createQaPool>[0] = {
  host: "127.0.0.1", port: 0, databasePath: join(root, "sessions.sqlite"),
  clients: [{ id: "cpr", keyFile: join(root, "key") }],
  accounts: [{ id: accountId, origin: backendOrigin, models: ["standard"], sessionModes: true,
    conversationStoreDirectory: join(root, "conversations") }],
  projectRoutes: [{ name: "papers", sessionNamespace: "papers", accountId, projectId,
    modelAliases: { "papers/gpt-5.6-sol": "standard" } }],
};
const originalZotero = globalThis.Zotero;
const calls: Record<string, any>[] = [];
const lookupBodies: Record<string, any>[] = [];
const checks: string[] = [];
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const originalPdf = "%PDF-1.4\njoint review original\n%%EOF";
const replacementPdf = "%PDF-1.4\njoint review replacement\n%%EOF";
const originalHash = digest(originalPdf);
const replacementHash = digest(replacementPdf);
let doi = "10.1234/joint-review";
let hasAttachment = true;
let path: string | false = "/fixture/paper.pdf";
let currentPdf = originalPdf;
const metadata = (body: Record<string, any>) => JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
const fileCount = (body: Record<string, any>) => body.input.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
  .filter((part: any) => part.type === "input_file").length;
const paper = {
  id: 7, key: "PAPER", libraryID: 1,
  isRegularItem: () => true, isAttachment: () => false,
  getField: (field: string) => field === "DOI" ? doi : "Joint review paper",
  getBestAttachment: async () => hasAttachment ? attachment : false,
};
const attachment = {
  id: 8, parentID: 7, attachmentContentType: "application/pdf",
  isRegularItem: () => false, isAttachment: () => true,
  getFilePathAsync: async () => path,
};
const selected = { ...attachment, id: 9, getFilePathAsync: async () => "/fixture/selected.pdf" };
function newDevice() {
  const prefs = new Map<string, unknown>();
  globalThis.Zotero = {
    Prefs: { get: (name: string) => prefs.get(name), set: (name: string, value: unknown) => prefs.set(name, value) },
    Items: { get: (id: number) => id === 7 ? paper : id === 8 ? attachment : id === 9 ? selected : false },
  } as unknown as typeof Zotero;
  resetProviderSessionIdCacheForTests();
}
newDevice();
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init);
  assert.equal(new URL(request.url).origin, backendOrigin, "No real network is permitted");
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url).pathname, "/v1/responses");
  const body = await request.json() as Record<string, any>;
  calls.push(body);
  const nativeThread = metadata(body).thread_id;
  const nativeKey = chatGptQuestionAnswerKey(nativeThread, chatGptQuestionAnswerNamespace(accountId));
  if (!store.lookup(nativeKey)) {
    store.bind(nativeKey, store.reserve(nativeKey), `https://chatgpt.com/g/${projectId}/c/fixture-${calls.length}`);
  }
  return Response.json({ id: `fixture-response-${calls.length}`, status: "completed", output: [] });
}) as typeof fetch;
let pool = createQaPool(config);
const db = new Database(config.databasePath);
const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init);
  assert.equal(new URL(request.url).origin, new URL(apiBase).origin);
  lookupBodies.push(await request.clone().json() as Record<string, any>);
  return pool.fetch(request);
}) as typeof fetch;
const prepare = (itemId = 7) => prepareCprPaperRequest({
  itemId, apiBase, apiKey: key, model: "papers/gpt-5.6-sol", prompt: "Fixture question", fetchFn,
  readBytes: async file => new TextEncoder().encode(file === "/fixture/selected.pdf" ? replacementPdf : currentPdf),
});
const direct = (identity: Record<string, unknown>, input: unknown = "Fixture direct text") => pool.fetch(new Request(`${apiBase}/responses`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: "papers/gpt-5.6-sol", stream: false, input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity) } }),
}));
const send = async (request: Awaited<ReturnType<typeof prepare>>) => {
  const response = await pool.fetch(new Request(`${apiBase}/responses`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(request.payload),
  }));
  const body = await response.json() as Record<string, any>;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, "completed");
  request.accept();
};
const pdfInput = (value: string) => [{ type: "message", role: "user", content: [
  { type: "input_file", filename: "fixture.pdf", file_data: `data:application/pdf;base64,${Buffer.from(value).toString("base64")}` },
  { type: "input_text", text: "Fixture direct file" },
] }];
const expectError = async (response: Response, status: number, code: string) => {
  const body = await response.json() as Record<string, any>;
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error?.code, code, JSON.stringify(body));
};
const row = (id: string) => db.query("SELECT * FROM papers WHERE paper_id = ?").get(id) as Record<string, any>;
try {
  const first = await prepare();
  assert.equal(first.registry.status, "missing");
  assert.equal(fileCount(first.payload), 1);
  assert.equal(metadata(first.payload).paper_pdf_sha256, originalHash);
  await send(first);
  const canonicalThread = first.registry.thread_id;
  const canonicalBackendThread = metadata(calls[0]).thread_id;
  const saved = row("doi:" + doi);
  assert.equal(saved.state, "ready");
  assert.equal(saved.pdf_sha256, originalHash);
  assert.equal(calls.length, 1);
  assert.equal(fileCount(calls[0]), 1);
  checks.push("initial actual downstream preparation and pool chat persist one verified upload");

  newDevice();
  const repeat = await prepare();
  assert.equal(repeat.registry.status, "ready");
  assert.equal(repeat.registry.thread_id, canonicalThread);
  assert.equal(metadata(repeat.payload).paper_pdf_sha256, originalHash);
  assert.equal(fileCount(repeat.payload), 0);
  assert.equal(metadata(lookupBodies.at(-1)!).paper_pdf_sha256, originalHash);
  await send(repeat);
  assert.equal(calls.length, 2);
  assert.equal(fileCount(calls.at(-1)!), 0);
  assert.equal(metadata(calls.at(-1)!).thread_id, canonicalBackendThread);
  checks.push("fresh device with original local PDF validates hash and preserves conversation without upload");

  currentPdf = replacementPdf;
  const beforeReplacement = calls.length;
  await assert.rejects(prepare(), /paper_identity_conflict/);
  assert.equal(calls.length, beforeReplacement);
  assert.equal(row("doi:" + doi).pdf_sha256, originalHash);
  checks.push("replacement bytes at identical path rejected before any backend chat");
  currentPdf = originalPdf;
  await assert.rejects(prepare(9), /paper_identity_conflict/);
  assert.equal(calls.length, beforeReplacement);
  checks.push("explicitly selected different attachment rejected despite correct best attachment");

  hasAttachment = false;
  const withoutAttachment = await prepare();
  assert.equal(withoutAttachment.registry.thread_id, canonicalThread);
  assert.equal(metadata(withoutAttachment.payload).paper_pdf_sha256, undefined);
  await send(withoutAttachment);
  assert.equal(metadata(calls.at(-1)!).thread_id, canonicalBackendThread);
  assert.equal(fileCount(calls.at(-1)!), 0);
  checks.push("no attachment continues saved thread with text alone");
  hasAttachment = true;
  path = false;
  const withoutPath = await prepare();
  await send(withoutPath);
  assert.equal(withoutPath.registry.thread_id, canonicalThread);
  assert.equal(metadata(calls.at(-1)!).thread_id, canonicalBackendThread);
  assert.equal(fileCount(calls.at(-1)!), 0);
  checks.push("attachment without local path continues saved thread with text alone");
  path = "/fixture/paper.pdf";

  doi = "";
  newDevice();
  const hashAlias = await prepare();
  assert.equal(hashAlias.paperId, "sha256:" + originalHash);
  assert.equal(hashAlias.registry.thread_id, canonicalThread);
  await send(hashAlias);
  assert.equal(fileCount(calls.at(-1)!), 0);
  assert.equal(metadata(calls.at(-1)!).thread_id, canonicalBackendThread);
  checks.push("no DOI uses content hash alias and preserves canonical conversation without upload");
  doi = "10.1234/joint-alias";
  newDevice();
  const doiAlias = await prepare();
  assert.equal(doiAlias.registry.thread_id, canonicalThread);
  assert.equal(doiAlias.registry.status, "ready");
  await send(doiAlias);
  assert.equal(fileCount(calls.at(-1)!), 0);
  assert.equal(metadata(calls.at(-1)!).thread_id, canonicalBackendThread);
  checks.push("new DOI with original PDF resolves hash alias instead of uploading twice");

  const beforeDirectErrors = calls.length;
  const identity = { paper_id: "doi:10.1234/joint-review", paper_operation: "chat" };
  await expectError(await direct({ ...identity, paper_pdf_sha256: replacementHash }), 409, "paper_identity_conflict");
  await expectError(await direct(identity, pdfInput(replacementPdf)), 409, "paper_identity_conflict");
  await expectError(await direct({ ...identity, paper_pdf_sha256: originalHash }, pdfInput(replacementPdf)), 400, "paper_pdf_sha256_mismatch");
  assert.equal(calls.length, beforeDirectErrors);
  checks.push("direct ready chat validates declared hash and actual bytes even without a resolve call");
  const directOriginal = await direct(identity, pdfInput(originalPdf));
  assert.equal(directOriginal.status, 200, await directOriginal.text());
  assert.equal(fileCount(calls.at(-1)!), 0);
  assert.equal(metadata(calls.at(-1)!).thread_id, canonicalBackendThread);
  checks.push("direct ready chat with original PDF verifies then strips duplicate upload");

  const legacyThread = "legacy-no-hash";
  const legacySession = poolSessionHash(["cpr", "papers"], legacyThread);
  db.query("INSERT INTO sessions(session_hash,account_id,created_at,project_id,project_name) VALUES(?,?,?,?,?)")
    .run(legacySession, accountId, new Date().toISOString(), projectId, "papers");
  const legacyNativeKey = chatGptQuestionAnswerKey("qa-pool-" + legacySession, chatGptQuestionAnswerNamespace(accountId));
  const legacyUrl = `https://chatgpt.com/g/${projectId}/c/legacy-fixture`;
  store.bind(legacyNativeKey, store.reserve(legacyNativeKey), legacyUrl);
  const legacyId = "doi:10.1234/legacy-no-hash";
  const adoption = await direct({ paper_id: legacyId, paper_operation: "resolve",
    paper_legacy_thread_id: legacyThread, paper_legacy_uploaded: true });
  assert.equal(adoption.status, 200, await adoption.clone().text());
  const legacyResolution = JSON.parse((await adoption.json() as any).output[0].content[0].text);
  assert.equal(legacyResolution.status, "ready");
  assert.equal(legacyResolution.thread_id, legacyThread);
  assert.equal(row(legacyId).pdf_sha256, null);
  doi = legacyId.slice(4);
  newDevice();
  const beforeLegacyErrors = calls.length;
  await assert.rejects(prepare(), /paper_pdf_identity_unverified/);
  await expectError(await direct({ paper_id: legacyId, paper_operation: "chat", paper_pdf_sha256: originalHash }), 409, "paper_pdf_identity_unverified");
  await expectError(await direct({ paper_id: legacyId, paper_operation: "chat" }, pdfInput(originalPdf)), 409, "paper_pdf_identity_unverified");
  assert.equal(calls.length, beforeLegacyErrors);
  assert.equal(row(legacyId).pdf_sha256, null);
  checks.push("legacy DOI with no trusted hash rejects new hash or PDF claims without backfilling history");
  hasAttachment = false;
  const legacyText = await prepare();
  assert.equal(legacyText.registry.thread_id, legacyThread);
  await send(legacyText);
  assert.equal(metadata(calls.at(-1)!).thread_id, "qa-pool-" + legacySession);
  assert.equal(fileCount(calls.at(-1)!), 0);
  assert.equal(row(legacyId).pdf_sha256, null);
  assert.equal(row(legacyId).conversation_url, legacyUrl);
  checks.push("legacy DOI without local attachment still continues original conversation with unknown hash unchanged");

  pool.close();
  pool = createQaPool(config);
  doi = "10.1234/joint-review";
  hasAttachment = true;
  newDevice();
  const afterRestart = await prepare();
  await send(afterRestart);
  assert.equal(afterRestart.registry.thread_id, canonicalThread);
  assert.equal(metadata(calls.at(-1)!).thread_id, canonicalBackendThread);
  assert.equal(fileCount(calls.at(-1)!), 0);
  assert.equal(calls.reduce((total, body) => total + fileCount(body), 0), 1);
  checks.push("pool restart preserves verified identity and thread with only one lifetime fixture upload");
  assert.equal(revision(upstreamRoot), upstreamRevision, "Upstream HEAD changed during replay");
  assert.equal(revision(downstreamRoot), downstreamRevision, "Downstream HEAD changed during replay");
  console.log(JSON.stringify({ status: "passed", checks: checks.length, details: checks,
    controlledBackendCalls: calls.length, controlledBackendPdfCount: calls.reduce((total, body) => total + fileCount(body), 0),
    realNetworkCalls: 0, realZoteroWrites: 0,
    upstream: upstreamRevision, downstream: downstreamRevision }, null, 2));
} finally {
  pool.close();
  db.close();
  globalThis.fetch = denyNetwork;
  globalThis.Zotero = originalZotero;
  resetProviderSessionIdCacheForTests();
  rmSync(root, { recursive: true, force: true });
}
