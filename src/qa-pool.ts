import { createReceiptStore, receiptIdentity, replayReceipt, MAX_RECEIPT_BYTES, isQaCompactionRequest } from "./qa-pool-receipts";
import { PaperRegistry, PaperError, normalizePaperId, poolSessionHash, type PaperScope, type PaperRow } from "./paper-registry";
import type { PaperRecoveryReader } from "./paper-recovery";
import { parsePaperHistory, readLauncherPaperHistory, type PaperHistoryReader } from "./paper-history";
import { Database } from "bun:sqlite";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

export interface QaPoolAccount { id: string; origin: string; models: string[]; enabled?: boolean; sessionModes?: boolean; conversationStoreDirectory?: string; browserHostDescriptorPath?: string }
export interface QaPoolConfig {
  host: string; port: number; databasePath: string;
  clients: Array<{ id: string; keyFile: string; trustClientIdentity?: boolean }>;
  accounts: QaPoolAccount[];
  modelCatalogPath?: string;
  projectRoutes?: Array<{ name: string; accountId: string; projectId: string; displayName?: string; sessionNamespace?: string; modelAliases?: Record<string, string> }>;
}
const nonempty = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// These adapter codes are emitted before Send. HTTP status alone is not proof.
const PRE_SEND_ATTACHMENT_FAILURE = "prompt_attachments_not_submitted";
function preSendAttachmentFailure(value: unknown, allowAdmissionFailure = false): boolean {
  const event = record(value);
  return [event, record(event.error), record(record(event.response).error)]
    .some(entry => entry.code === PRE_SEND_ATTACHMENT_FAILURE || (allowAdmissionFailure && entry.code === "concurrency_limit_exceeded"));
}

// Only the configured runtime's pre-admission 503 contract proves no execution.
// A status, message, code alone, or an error after acceptance is insufficient.
function responseNotAdmitted(value: unknown, status: number): boolean {
  const error = record(record(value).error);
  return status === 503 && error.type === "server_error" && error.code === "server_draining"
    && error.retryable === true && error.submission_state === "not_submitted" && error.phase === "admission";
}

export function parseQaSessionEffort(value: unknown): { effort?: string; mode: "temporary" | "persistent"; explicit: boolean } {
  const effort = nonempty(value);
  const matched = effort && /^(none|minimal|low|medium|high|xhigh|max|ultra)-(temporary|persistent)$/.exec(effort);
  return matched ? { effort: matched[1], mode: matched[2] === "temporary" ? "temporary" : "persistent", explicit: true }
    : { effort, mode: "persistent", explicit: false };
}

export function normalizeQaPoolRequest(payload: Record<string, unknown>, headers: Headers, requestId: string = randomUUID()) {
  const metadata = record(payload.client_metadata);
  const native = metadata["x-codex-turn-metadata"] ?? headers.get("x-codex-turn-metadata");
  let identity = record(native);
  if (typeof native === "string") {
    try { identity = record(JSON.parse(native)); } catch { throw new Error("Invalid turn metadata"); }
  }
  const session = nonempty(identity.thread_id) ?? nonempty(headers.get("thread-id"))
    ?? nonempty(headers.get("session-id")) ?? nonempty(headers.get("session_id"))
    ?? nonempty(payload.session_id) ?? nonempty(payload.conversation_id) ?? nonempty(payload.prompt_cache_key);
  const thread = nonempty(identity.thread_id) ?? (session
    ? "qa-session-" + createHash("sha256").update(session).digest("hex") : "qa-request-" + requestId);
  const stableTurn = nonempty(identity.turn_id) ?? nonempty(identity.request_id);
  const messageSeed = stableTurn ? createHash("sha256").update(JSON.stringify([thread, stableTurn])).digest("hex") : requestId;
  const normalized: Record<string, unknown> = { ...payload, client_metadata: { ...metadata,
    "x-codex-turn-metadata": JSON.stringify({ ...identity, thread_id: thread, turn_id: nonempty(identity.turn_id) ?? "qa-turn-" + (nonempty(identity.request_id) ?? requestId) }),
  } };
  if (typeof normalized.input === "string") normalized.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: normalized.input }] }];
  if (Array.isArray(normalized.input)) normalized.input = normalized.input.map((item, index) => {
    const message = record(item);
    if (typeof message.role !== "string") return item;
    return { ...message, type: message.type ?? "message",
      ...(message.role === "user" && !message.id ? { id: "qa-message-" + messageSeed + "-" + index } : {}),
    };
  });
  return { thread, payload: normalized };
}

function configValid(config: QaPoolConfig): void {
  if (!config || !config.host || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
    || !config.databasePath || !Array.isArray(config.clients) || !config.clients.length
    || !Array.isArray(config.accounts) || !config.accounts.length) throw new Error("Invalid QA pool configuration");
  const ids = new Set<string>();
  for (const account of config.accounts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(account.id) || ids.has(account.id)
      || !Array.isArray(account.models) || !account.models.length
      || account.models.some(model => typeof model !== "string" || !model)) throw new Error("Invalid QA pool account");
    ids.add(account.id);
    const url = new URL(account.origin);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("QA pool backends must be loopback HTTP origins");
  }
  const clients = new Set<string>();
  for (const client of config.clients) {
    if (!client.id || clients.has(client.id) || !client.keyFile) throw new Error("Invalid QA pool client");
    clients.add(client.id);
  }
  const routes = new Set<string>();
  for (const route of config.projectRoutes ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(route.name) || routes.has(route.name)
      || !ids.has(route.accountId) || !/^g-p-[a-f0-9]{32}$/.test(route.projectId)
      || (route.displayName !== undefined && (typeof route.displayName !== "string" || !route.displayName.trim() || route.displayName.length > 128))
      || (route.sessionNamespace !== undefined && (typeof route.sessionNamespace !== "string" || !route.sessionNamespace.trim()))) {
      throw new Error("Invalid QA pool project route");
    }
    routes.add(route.name);
  }
}

function paperResultResponse(result: object, payload: Record<string, unknown>): Response {
  const text = JSON.stringify(result);
  const part = {type:"output_text",text,annotations:[]};
  const item = {id:"msg_"+randomUUID(),type:"message",status:"completed",role:"assistant",content:[part]};
  const response = { id:"resp_paper_"+randomUUID(), object:"response", created_at:Math.floor(Date.now()/1000), status:"completed", model:payload.model,
    error:null, incomplete_details:null, output:[item], output_text:text,
    usage:{input_tokens:0,output_tokens:0,total_tokens:0} };
  if (payload.stream !== true) return Response.json(response);
  const pending = {...response,status:"in_progress",output:[],output_text:"",usage:null};
  const events = [
    {type:"response.created",response:pending},
    {type:"response.in_progress",response:pending},
    {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},
    {type:"response.content_part.added",item_id:item.id,output_index:0,content_index:0,part:{...part,text:""}},
    {type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:text,logprobs:[]},
    {type:"response.output_text.done",item_id:item.id,output_index:0,content_index:0,text,logprobs:[]},
    {type:"response.content_part.done",item_id:item.id,output_index:0,content_index:0,part},
    {type:"response.output_item.done",output_index:0,item},
    {type:"response.completed",response},
  ];
  return new Response(events.map((event,sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number})}\n\n`).join(""), {
    headers:{"content-type":"text/event-stream","cache-control":"no-store"},
  });
}

export function createQaPool(config: QaPoolConfig, options: { paperRecoveryReader?: PaperRecoveryReader; paperHistoryReader?: PaperHistoryReader } = {}) {
  configValid(config);
  const databasePath = resolve(config.databasePath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath, { create: true });
  chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS sessions (session_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS temporary_history (session_hash TEXT PRIMARY KEY, input_json TEXT NOT NULL, response_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  db.transaction(() => {
    if (!(db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(column => column.name === "temporary_history_expected")) {
      db.exec("ALTER TABLE sessions ADD COLUMN temporary_history_expected INTEGER NOT NULL DEFAULT 0");
    }
    // Preserve the existence of private context before any content expiry deletes it.
    db.exec("UPDATE sessions SET temporary_history_expected=1 WHERE session_hash IN (SELECT session_hash FROM temporary_history)");
  })();
  if (!(db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(column => column.name === "pending_history_turn")) {
    db.exec("ALTER TABLE sessions ADD COLUMN pending_history_turn TEXT");
  }
  const reserveHistoryTurn = db.query("UPDATE sessions SET pending_history_turn=? WHERE session_hash=? AND pending_history_turn IS NULL");
  const clearHistoryTurn = db.query("UPDATE sessions SET pending_history_turn=NULL WHERE session_hash=? AND pending_history_turn=?");
  const history = db.query<{ input_json: string; response_id: string; expires_at: number }, [string]>("SELECT input_json, response_id, expires_at FROM temporary_history WHERE session_hash=?");
  const putHistory = db.query("INSERT OR REPLACE INTO temporary_history VALUES (?, ?, ?, ?)");
  const deleteHistory = db.query("DELETE FROM temporary_history WHERE session_hash=?");
  const expectHistory = db.query("UPDATE sessions SET temporary_history_expected=? WHERE session_hash=?");
  const saveHistory = db.transaction((hash: string, input: string, responseId: string, expiresAt: number) => {
    expectHistory.run(1, hash);
    putHistory.run(hash, input, responseId, expiresAt);
  });
  const promoteHistory = db.transaction((hash: string) => {
    deleteHistory.run(hash);
    expectHistory.run(0, hash);
  });
  const purgeHistory = db.query("DELETE FROM temporary_history WHERE expires_at<=?");
  const receipts = createReceiptStore(db);
  purgeHistory.run(Date.now()); receipts.purge();
  const sweep = setInterval(() => { purgeHistory.run(Date.now()); receipts.purge(); }, 60_000);
  sweep.unref();
  const activeHistories = new Set<string>();
  const activeReceipts = new Map<string, Promise<void>>();
  const shutdownObservers = new Set<() => void>();
  let closed = false;
  if (!(db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(column => column.name === "project_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT; ALTER TABLE sessions ADD COLUMN project_name TEXT;");
  }
  const papers = new PaperRegistry(db);
  const paperRecoveries = new Map<string, Promise<unknown>>();
  const activePaperReads = new Set<string>();
  const readPaperHistory = options.paperHistoryReader ?? readLauncherPaperHistory;
  const find = db.query<{ account_id: string; project_id: string | null; project_name: string | null; temporary_history_expected: number; pending_history_turn: string | null }, [string]>("SELECT account_id, project_id, project_name, temporary_history_expected, pending_history_turn FROM sessions WHERE session_hash = ?");
  const insert = db.query("INSERT OR IGNORE INTO sessions (session_hash, account_id, created_at, project_id, project_name) VALUES (?, ?, ?, ?, ?)");
  const count = db.query<{ account_id: string; n: number }, []>("SELECT account_id, COUNT(*) AS n FROM sessions GROUP BY account_id");
  const clients = config.clients.map(client => {
    const key = readFileSync(resolve(client.keyFile), "utf8").trim();
    if (key.length < 24) throw new Error("QA pool keys must contain at least 24 characters");
    return { id: client.id, trustClientIdentity: client.trustClientIdentity === true, digest: createHash("sha256").update("Bearer " + key).digest() };
  });
  if (new Set(clients.map(client => client.digest.toString("hex"))).size !== clients.length) {
    db.close(); throw new Error("Each QA pool client must have a distinct API key");
  }
  const failure = (status: number, code: string, message: string) => Response.json({ error: { code, type: "qa_pool_error", message } }, { status });
  const select = db.transaction((hash: string, model: string, route?: NonNullable<QaPoolConfig["projectRoutes"]>[number]) => {
    const owner = find.get(hash);
    if (owner) return owner;
    const counts = new Map(count.all().map(row => [row.account_id, row.n]));
    const eligible = config.accounts.filter(account => account.enabled !== false && account.models.includes(model)
      && (!route || account.id === route.accountId))
      .sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    if (!eligible[0]) return undefined;
    insert.run(hash, eligible[0].id, new Date().toISOString(), route?.projectId ?? null, route?.displayName ?? route?.name ?? null);
    return find.get(hash)!;
  });
  async function fetchRequest(request: Request): Promise<Response> {
    if (closed) return failure(503, "pool_closed", "The QA pool is closed");
    const url = new URL(request.url);
    const supplied = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
    const client = clients.find(value => timingSafeEqual(value.digest, supplied));
    if (!client) return failure(401, "unauthorized", "Unauthorized");
    const prefix = /^\/project\/([^/]+)(\/v1\/(?:models|responses(?:\/compact)?))$/.exec(url.pathname);
    const identityPath = /^\/by-client(\/v1\/(?:models|responses(?:\/compact)?))$/.exec(url.pathname);
    let route = prefix ? config.projectRoutes?.find(value => value.name === prefix[1]) : undefined;
    if (url.pathname.startsWith("/project/") && !route) return failure(404, "project_route_unknown", "Unknown project route");
    if (identityPath) {
      if (!client.trustClientIdentity) return failure(403, "client_identity_untrusted", "Client identity forwarding is not enabled");
      const identity = nonempty(request.headers.get("x-cpr-client-id"));
      if (!identity && !(request.method === "GET" && identityPath[1] === "/v1/models")) {
        return failure(400, "client_identity_required", "Authenticated client identity is required");
      }
      if (identity) {
        route = config.projectRoutes?.find(value => value.name === identity);
        if (!route) return failure(403, "client_project_unknown", "No project is configured for this client");
      }
    }
    const pathname = identityPath?.[1] ?? prefix?.[2] ?? url.pathname;
    if (request.method === "GET" && url.pathname === "/healthz") return Response.json({ status: "ok", persistentSessions: true, accounts: config.accounts.filter(a => a.enabled !== false).length });
    if (request.method === "GET" && pathname === "/v1/models") {
      const models = route?.modelAliases ? Object.keys(route.modelAliases) : [...new Set(config.accounts.filter(a => a.enabled !== false && (!route || a.id === route.accountId)).flatMap(a => a.models))];
      const catalog = config.modelCatalogPath
        ? JSON.parse(readFileSync(resolve(config.modelCatalogPath), "utf8")).models as Array<Record<string, unknown>>
        : undefined;
      return Response.json({ object: "list", data: models.map(id => ({ id, object: "model", owned_by: "chatgpt-web", created: 0 })),
        ...(catalog ? { models: models.map(id => {
          const source = catalog.find(item => item.slug === (route?.modelAliases?.[id] ?? id));
          if (!source) throw new Error(`QA model metadata missing: ${id}`);
          return { ...source, slug: id };
        }) } : {}),
      });
    }
    if (request.method !== "POST" || !["/v1/responses", "/v1/responses/compact"].includes(pathname)) return failure(404, "not_found", "Unknown route");
    let payload: Record<string, unknown>;
    try {
      const bytes = Buffer.from(await request.arrayBuffer());
      const encoding = request.headers.get("content-encoding") ?? "identity";
      const decoded = encoding === "gzip" ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
        : encoding === "zstd" ? zstdDecompressSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
        : encoding === "identity" ? bytes : undefined;
      if (!decoded) return failure(415, "unsupported_encoding", "Unsupported content encoding");
      if (decoded.length > 64 * 1024 * 1024) return failure(413, "request_too_large", "Request too large");
      payload = record(JSON.parse(decoded.toString("utf8")));
      if (!Object.keys(payload).length) throw new Error();
    } catch { return failure(400, "invalid_request", "Invalid JSON request"); }
    if (route?.modelAliases) {
      const publicModel = nonempty(payload.model);
      if (!publicModel || !Object.hasOwn(route.modelAliases, publicModel)) return failure(400, "model_unavailable", "Model is not offered by this project route");
      payload.model = route.modelAliases[publicModel];
    }
    const model = nonempty(payload.model);
    if (!model) return failure(400, "invalid_model", "An explicit model is required");
    let normalized: ReturnType<typeof normalizeQaPoolRequest>;
    try { normalized = normalizeQaPoolRequest(payload, request.headers); }
    catch { return failure(400, "invalid_identity", "Invalid session identity"); }
    const originalNative = record(payload.client_metadata)["x-codex-turn-metadata"] ?? request.headers.get("x-codex-turn-metadata");
    const receiptNative = typeof originalNative === "string" ? record(JSON.parse(originalNative)) : record(originalNative);
    const sessionScope = route?.sessionNamespace ? [client.id, route.sessionNamespace] : client.id;
    const paperMetadata = JSON.parse(record(normalized.payload.client_metadata)["x-codex-turn-metadata"] as string);
    let paper: { id: string; scope: PaperScope; row: PaperRow } | undefined;
    if (route?.name === "papers" && (paperMetadata.paper_id === undefined || paperMetadata.paper_operation === undefined)) return failure(400,"paper_id_required","Upgrade the papers client or provide paper_id and paper_operation; anonymous paper chats are disabled");
    if (paperMetadata.paper_id !== undefined || paperMetadata.paper_operation !== undefined) {
      if (pathname !== "/v1/responses" || client.id !== "cpr" || route?.name !== "papers") return failure(409, "paper_route_required", "Paper operations require the authenticated papers project route");
      const paperAccount = config.accounts.find(a => a.id === route.accountId);
      if (!paperAccount?.conversationStoreDirectory || paperAccount.enabled === false) return failure(503, "paper_store_unconfigured", "Paper account conversation store is unavailable");
      const id = normalizePaperId(paperMetadata.paper_id);
      const scope: PaperScope = { accountId:route.accountId, projectId:route.projectId, sessionScope, directory:paperAccount.conversationStoreDirectory };
      if (paperMetadata.paper_operation === "resolve") {
        let result = papers.resolve(id, scope, paperMetadata);
        if (result.status === "uncertain" && paperAccount.browserHostDescriptorPath) {
          const canonicalId = papers.get(id).paper_id;
          if (activePaperReads.has(canonicalId)) return failure(409,"paper_busy","Wait for this paper's history read");
          let recovery = paperRecoveries.get(canonicalId);
          if (!recovery) {
            recovery = papers.reconcile(canonicalId, scope, {
              browserHostDescriptorPath: paperAccount.browserHostDescriptorPath,
              signal: request.signal, reader: options.paperRecoveryReader,
            });
            paperRecoveries.set(canonicalId, recovery);
          }
          try { await recovery; }
          finally { if (paperRecoveries.get(canonicalId) === recovery) paperRecoveries.delete(canonicalId); }
          result = papers.resolve(id, scope, paperMetadata);
        }
        return paperResultResponse(result, payload);
      }
      if (paperMetadata.paper_operation === "history") {
        const row = papers.get(id);
        if (!row) return failure(404,"paper_history_not_found","No existing conversation for this paper");
        if (row.account_id !== scope.accountId || row.project_id !== scope.projectId || row.session_hash !== poolSessionHash(scope.sessionScope,row.thread_id)) {
          return failure(409,"paper_scope_mismatch","Original paper account/project/session scope required");
        }
        if (!paperAccount.models.includes(model)) return failure(400,"session_model_unavailable","This paper account does not support the requested model");
        if (row.in_flight || activePaperReads.has(row.paper_id) || paperRecoveries.has(row.paper_id)) return failure(409,"paper_busy","Wait for this paper's current operation");
        if (!nonempty(paperAccount.browserHostDescriptorPath)) return failure(503,"paper_history_unavailable","This account has no native history reader configured");
        let conversationUrl: string;
        try { conversationUrl = papers.mapping(row,scope); }
        catch (error) {
          if (error instanceof PaperError && ["paper_mapping_missing","paper_session_missing"].includes(error.code)) {
            return failure(404,"paper_history_not_found","No verified saved conversation for this paper");
          }
          throw error;
        }
        activePaperReads.add(row.paper_id);
        try {
          request.signal.throwIfAborted();
          const raw = await readPaperHistory({accountId:paperAccount.id,sessionHash:row.session_hash,
            browserHostDescriptorPath:paperAccount.browserHostDescriptorPath!,conversationUrl,signal:request.signal});
          request.signal.throwIfAborted();
          const result = parsePaperHistory(raw,conversationUrl);
          return paperResultResponse({paper_id:id,thread_id:row.thread_id,conversation_url:conversationUrl,...result},payload);
        } catch (error) {
          if (error instanceof PaperError) throw error;
          return failure(503,"paper_history_unavailable","Native conversation history could not be read; no message was sent");
        } finally { activePaperReads.delete(row.paper_id); }
      }
      if (paperMetadata.paper_operation !== "chat") return failure(400,"paper_operation_invalid","Use resolve, history or chat");
      const existingPaper = papers.get(id);
      if (existingPaper && (activePaperReads.has(existingPaper.paper_id) || paperRecoveries.has(existingPaper.paper_id))) return failure(409,"paper_busy","Wait for this paper's current operation");
      if (parseQaSessionEffort(record(normalized.payload.reasoning).effort).mode === "temporary") return failure(400,"paper_persistent_required","Papers require persistent conversations");
      const prepared = papers.prepare(id,scope,paperMetadata,normalized.payload.input);
      paper = {id:prepared.row.paper_id,scope,row:prepared.row}; normalized.thread = prepared.row.thread_id; normalized.payload.input = prepared.input;
      delete normalized.payload.previous_response_id;
      delete paperMetadata.parent_thread_id; delete paperMetadata.forked_from_thread_id;
      record(normalized.payload.client_metadata)["x-codex-turn-metadata"] = JSON.stringify({...paperMetadata,thread_id:normalized.thread});
    }
    const hash = createHash("sha256").update(JSON.stringify(["qa-pool/v1", sessionScope, normalized.thread])).digest("hex");
    const owner = select(hash, model, route);
    if (!owner) return failure(400, "model_unavailable", "No account supports the requested model");
    const account = config.accounts.find(a => a.id === owner.account_id);
    // 旧会话永远不因过期、禁用或上游故障静默换号。
    if (!account || account.enabled === false) return failure(503, "session_account_unavailable", "This session's account is unavailable; restore the original account to continue");
    if (!account.models.includes(model)) return failure(400, "session_model_unavailable", "This session's account does not support the requested model");
    const reasoning = record(normalized.payload.reasoning);
    const selection = parseQaSessionEffort(reasoning.effort);
    if (selection.explicit && !account.sessionModes) return failure(400, "session_modes_unavailable", "This account does not enable temporary/persistent effort selection");
    if (selection.explicit) normalized.payload.reasoning = { ...reasoning, effort: selection.effort };
    const cached = account.sessionModes ? history.get(hash) : undefined;
    if ((cached && cached.expires_at <= Date.now()) || (owner.temporary_history_expected && !cached)) {
      if (cached) deleteHistory.run(hash);
      return failure(409, "temporary_history_expired", "Temporary context expired or is unavailable; start a new thread seeded with the history you want to retain");
    }
    const retainHistory = account.sessionModes && (selection.mode === "temporary" || cached !== null && cached !== undefined);
    receipts.purge();
    let compactionRequest: boolean;
    try { compactionRequest = pathname === "/v1/responses/compact" || isQaCompactionRequest(normalized.payload); }
    catch { return failure(400, "invalid_compaction_request", "Unsupported native compaction protocol"); }
    const receipt = !paper && !compactionRequest && (account.sessionModes || owner.pending_history_turn)
      ? receiptIdentity({ ...normalized.payload, session_mode: selection.mode }, receiptNative, JSON.stringify([hash, owner.account_id, owner.project_id, pathname])) : undefined;
    if (receipt) {
      let prior = receipts.get(hash, receipt.key);
      if (prior) {
        if (prior.state === "completed_unretained") return failure(409, "request_completed_unretained", "This request completed, but its response is not cached locally; no new message was sent");
        if (prior.state === "expired") return failure(409, "request_receipt_expired", "The request receipt expired; no new message was sent");
        if (prior.digest !== receipt.digest) return failure(409, "request_identity_conflict", "This request identity was already used for a different payload");
        if (prior.state === "pending") {
          const active = activeReceipts.get(hash + ":" + receipt.key);
          if (active) { await active; if (closed) return failure(503, "pool_closed", "The QA pool is closed"); prior = receipts.get(hash, receipt.key);
            if (!prior) return failure(409, "request_receipt_unavailable", "The prior attempt has no retained receipt; no new message was sent"); }
        }
        if (prior.state === "completed_unretained") return failure(409, "request_completed_unretained", "This request completed, but its response is not cached locally; no new message was sent");
        if (prior.state === "completed" && prior.response_json) return replayReceipt(JSON.parse(prior.response_json));
        return failure(409, "temporary_turn_uncertain", "This request may have been submitted; reconcile it before retrying");
      }
    }
    if (owner.pending_history_turn) return failure(409, "temporary_turn_uncertain", "A prior turn may have been submitted but its history was not committed; reconcile it before continuing");
    const historyExpiresAt = Date.now() + 48 * 60 * 60 * 1000;
    if (retainHistory && activeHistories.has(hash)) return failure(409, "temporary_turn_in_progress", "Wait for this conversation's current turn to finish");
    if (cached) {
      const previous = nonempty(normalized.payload.previous_response_id);
      if (previous && previous !== cached.response_id) return failure(409, "previous_response_identity_mismatch", "The previous response does not belong to this temporary conversation head");
      const incoming = Array.isArray(normalized.payload.input) ? normalized.payload.input : [];
      if (!incoming.some(item => record(item).role === "assistant")) {
        normalized.payload.input = [...JSON.parse(cached.input_json), ...incoming];
      }
      // The pool proves account/key/thread ownership and supplies the complete private history.
      delete normalized.payload.previous_response_id;
    }
    // 客户端作用域也进入运行时 thread，避免不同 API key 的同名会话串聊。
    const metadata = record(normalized.payload.client_metadata);
    // The authenticated upstream route owns project selection, never caller metadata.
    delete metadata._chatgpt_project;
    delete metadata._chatgpt_session_mode;
    delete metadata._chatgpt_defer_text_until_complete;
    if (route?.name === "papers") metadata._chatgpt_defer_text_until_complete = true;
    if (account.sessionModes) metadata._chatgpt_session_mode = selection.mode;
    if (owner.project_id) {
      const title = paper && typeof paperMetadata.paper_title === "string"
        ? Array.from(paperMetadata.paper_title.replace(/\s+/g, " ").trim()).slice(0,80).join("") : "";
      metadata._chatgpt_project = { id: owner.project_id, name: owner.project_name, ...(title ? { conversationTitle:title } : {}) };
    }
    const native = JSON.parse(metadata["x-codex-turn-metadata"] as string);
    for (const name of ["parent_thread_id", "forked_from_thread_id"]) {
      const parent = nonempty(native[name]);
      if (!parent) continue;
      if (parent === normalized.thread) return failure(400, "invalid_identity", "A fork must have its own thread identity");
      native[name] = "qa-pool-" + createHash("sha256")
        .update(JSON.stringify(["qa-pool/v1", sessionScope, parent])).digest("hex");
    }
    metadata["x-codex-turn-metadata"] = JSON.stringify({ ...native, thread_id: "qa-pool-" + hash });
    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["accept", "openai-beta", "user-agent"]) {
      const value = request.headers.get(name); if (value) headers.set(name, value);
    }
    let paperCompleted = false;
    const historyAttempt = randomUUID();
    let historyReserved = false;
    let settleReceipt = () => {};
    let observation: AbortController | undefined;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelRead: (() => void) | undefined;
    let detachObserverAbort = () => {};
    const stopObservation = () => { detachObserverAbort(); if (observationTimer) clearTimeout(observationTimer); observation?.abort(); cancelRead?.(); settleReceipt(); };
    const release = (notSubmitted = false) => {
      activeHistories.delete(hash);
      settleReceipt();
      detachObserverAbort();
      if (observationTimer) clearTimeout(observationTimer);
      shutdownObservers.delete(stopObservation);
      if (closed) return;
      if (notSubmitted && historyReserved) {
        db.transaction(() => { clearHistoryTurn.run(hash, historyAttempt); if (receipt) receipts.release(hash, receipt.key); })();
        historyReserved = false;
      }
      if (!paper) return;
      if (notSubmitted && !paperCompleted) papers.release(paper.id); else papers.finish(paper.id, paperCompleted);
    };
    const commitHistory = db.transaction((value: unknown, wire?: Uint8Array, cacheable = true) => {
      const response = record(value);
      if (response.status !== "completed" || typeof response.id !== "string" || !Array.isArray(response.output)) return;
      if (historyReserved) clearHistoryTurn.run(hash, historyAttempt);
      if (selection.mode !== "temporary") { promoteHistory(hash); receipts.promote(hash); return; }
      const expiresAt = Date.now() + 48 * 60 * 60 * 1000;
      if (receipt && historyReserved) receipts.complete(hash, receipt.key, response, expiresAt, wire, cacheable);
      const messages = response.output.filter(item => record(item).type === "message" && record(item).role === "assistant");
      saveHistory(hash, JSON.stringify([...(Array.isArray(normalized.payload.input) ? normalized.payload.input : []), ...messages]), response.id, expiresAt);
    });
    const completed = (value: unknown, wire?: Uint8Array, cacheable = true) => {
      if (closed || observation?.signal.aborted) throw new Error("Observation ended before completion was committed");
      const response = record(value);
      if (response.status !== "completed" || typeof response.id !== "string" || !Array.isArray(response.output)) return;
      if (paper) {
        if (!paperCompleted) { papers.complete(paper.id, paper.scope); paperCompleted = true; }
        promoteHistory(hash);
        return;
      }
      try { commitHistory(value, wire, cacheable); }
      catch (error) {
        if (!receipt || !historyReserved || !cacheable || record(error).code !== "SQLITE_FULL") throw error;
        commitHistory(value, undefined, false);
      }
      settleReceipt();
      return true;
    };
    if (retainHistory && !paper && !compactionRequest) {
      try {
        const reserved = db.transaction(() => {
          if (receipt && receipts.get(hash, receipt.key)) return "existing";
          const current = history.get(hash);
          if (current?.response_id !== cached?.response_id || (current && current.expires_at <= Date.now())
            || (!current && find.get(hash)?.temporary_history_expected)) return "head_changed";
          if (reserveHistoryTurn.run(historyAttempt, hash).changes !== 1) return "pending";
          if (receipt) receipts.begin(hash, receipt.key, receipt.digest, historyExpiresAt);
          return "reserved";
        }).immediate();
        if (reserved === "existing" && receipt) {
          const existing = receipts.get(hash, receipt.key);
          if (existing?.digest === receipt.digest && existing.state === "completed" && existing.response_json) return replayReceipt(JSON.parse(existing.response_json));
          return failure(409, "request_receipt_changed", "This request already has a receipt; no new message was sent");
        }
        if (reserved === "head_changed") return failure(409, "temporary_history_changed", "The conversation head changed; reload it before continuing");
        if (reserved !== "reserved") return failure(409, "temporary_turn_uncertain", "A prior turn is still pending; no new message was sent");
        historyReserved = true;
        if (receipt) {
          const activeKey = hash + ":" + receipt.key;
          let settle!: () => void;
          activeReceipts.set(activeKey, new Promise<void>(resolve => { settle = resolve; }));
          settleReceipt = () => { activeReceipts.delete(activeKey); settle(); };
          observation = new AbortController();
          observationTimer = setTimeout(stopObservation, 10 * 60 * 1000);
          observationTimer.unref();
          shutdownObservers.add(stopObservation);
        }
      } catch { return failure(503, "temporary_history_unavailable", "The pending turn could not be persisted; no message was sent"); }
    }
    if (paper) papers.begin(paper.id);
    if (retainHistory) activeHistories.add(hash);
    let receivedResponse = false;
    try {
      const response = await fetch(account.origin.replace(/\/$/, "") + pathname, {
        method: "POST", headers, body: JSON.stringify(normalized.payload), signal: observation?.signal ?? request.signal, redirect: "error",
      });
      receivedResponse = true;
      if (closed || observation?.signal.aborted) { await response.body?.cancel(); throw new Error("Observation ended"); }
      let body: BodyInit | null = response.body;
      let notSubmitted = false;
      const streaming = (response.headers.get("content-type") ?? "").includes("text/event-stream");
      if ((paper || retainHistory) && response.body && !streaming) {
        // A failed paper turn is not always an HTTP error, so classify the explicit pre-send
        // attachment failure from the body before deciding whether the reservation is retryable.
        const bytes = await response.arrayBuffer();
        let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { parsed = undefined; }
        if (response.ok) completed(parsed);
        // A 200 stream-less body can still carry status:"failed" with the explicit adapter code.
        if (!paperCompleted && parsed !== undefined && (preSendAttachmentFailure(parsed, Boolean(retainHistory))
          || responseNotAdmitted(parsed, response.status))) notSubmitted = true;
        body = bytes; release(notSubmitted);
      } else if ((retainHistory || paper) && response.body && response.ok) {
        const reader = response.body.getReader(); let buffered = Buffer.alloc(0);
        cancelRead = () => { resumeRead?.(); void reader.cancel().catch(() => {}); };
        const wire: Uint8Array[] = []; let wireBytes = 0; let terminalSaved = false; let cacheable = true;
        let observerCancelled = false;
        let resumeRead: (() => void) | undefined;
        const observerAborted = () => { observerCancelled = true; resumeRead?.(); };
        if (receipt) {
          // A client may disconnect before Bun attaches the returned response body,
          // so stream.cancel alone is insufficient to release reader backpressure.
          // Keep observing accepted upstream work and persist its terminal result.
          request.signal.addEventListener("abort", observerAborted, { once: true });
          detachObserverAbort = () => request.signal.removeEventListener("abort", observerAborted);
          if (request.signal.aborted) observerAborted();
        }
        const consume = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
            try {
              while (true) {
              if (receipt && !observerCancelled && (controller.desiredSize ?? 1) <= 0) {
                await new Promise<void>(resolve => { resumeRead = resolve; });
                resumeRead = undefined;
              }
              const chunk = await reader.read();
              if (closed || observation?.signal.aborted) throw new Error("Observation ended");
              if (chunk.done) { release(notSubmitted); if (!observerCancelled) controller.close(); return; }
              if (receipt && !terminalSaved) {
                wireBytes += chunk.value.byteLength;
                if (wireBytes > MAX_RECEIPT_BYTES) { cacheable = false; wire.length = 0; }
              }
              buffered = Buffer.concat([buffered, chunk.value]);
              if (receipt && buffered.byteLength > 64 * MAX_RECEIPT_BYTES) throw new Error("Receipt event too large");
              while (true) {
                const lf = buffered.indexOf("\n\n"), crlf = buffered.indexOf("\r\n\r\n");
                const end = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
                if (end < 0) break;
                const length = end + (end === crlf ? 4 : 2);
                const frame = buffered.subarray(0, length); buffered = buffered.subarray(length);
                if (receipt && !terminalSaved && cacheable) wire.push(frame);
                const data = frame.toString("utf8").split(/\r?\n/).filter(line => line.startsWith("data:"))
                  .map(line => line.slice(5).replace(/^ /, "")).join("\n");
                if (!data || data.trim() === "[DONE]") continue;
                const event = record(JSON.parse(data));
                if (event.type === "response.completed") {
                  if (terminalSaved) throw new Error("Duplicate terminal event");
                  const committed = completed(event.response, receipt && cacheable ? Buffer.concat(wire) : undefined, cacheable);
                  if (receipt && !committed) throw new Error("Invalid completed response");
                  terminalSaved = true;
                } else if ((event.type === "response.failed" || event.type === "error") && preSendAttachmentFailure(event, Boolean(retainHistory))) notSubmitted = true;
              }
              if (!observerCancelled) controller.enqueue(chunk.value);
              if (receipt && terminalSaved) {
                release(notSubmitted); if (!observerCancelled) controller.close();
                await reader.cancel(); return;
              }
              if (!receipt) return;
              }
            } catch (error) { release(notSubmitted); if (!observerCancelled) controller.error(error); }
        };
        body = new ReadableStream<Uint8Array>({
          ...(receipt ? { start: (controller: ReadableStreamDefaultController<Uint8Array>) => { void consume(controller); }, pull: () => { resumeRead?.(); } } : { pull: consume }),
          async cancel(reason) {
            observerAborted(); detachObserverAbort();
            if (!receipt || !historyReserved) { release(notSubmitted); await reader.cancel(reason); }
          },
        });
      } else release();
      return new Response(body, { status: response.status, headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      } });
    } catch (error) {
      const connectionCode = record(error).code ?? record(record(error).cause).code;
      release(!receivedResponse && (connectionCode === "ECONNREFUSED" || connectionCode === "ConnectionRefused"));
      return failure(502, "session_account_unreachable", "This session's account runtime is unreachable; retry after it recovers"); }
  }
  return { fetch: async (request: Request) => {
    try { return await fetchRequest(request); }
    catch (error) { if (error instanceof PaperError) return failure(error.status,error.code,error.message); throw error; }
  }, close: () => { closed = true; clearInterval(sweep); for (const stop of shutdownObservers) stop(); shutdownObservers.clear(); db.close(); } };
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: qa-pool <config.json>");
  const config = JSON.parse(readFileSync(resolve(process.argv[2]), "utf8")) as QaPoolConfig;
  const pool = createQaPool(config);
  Bun.serve({ hostname: config.host, port: config.port, fetch: pool.fetch, maxRequestBodySize: 64 * 1024 * 1024, idleTimeout: 0 });
}
