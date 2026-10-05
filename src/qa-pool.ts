import { PaperRegistry, PaperError, normalizePaperId, type PaperScope, type PaperRow } from "./paper-registry";
import { Database } from "bun:sqlite";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

export interface QaPoolAccount { id: string; origin: string; models: string[]; enabled?: boolean; sessionModes?: boolean; conversationStoreDirectory?: string }
export interface QaPoolConfig {
  host: string; port: number; databasePath: string;
  clients: Array<{ id: string; keyFile: string }>;
  accounts: QaPoolAccount[];
  modelCatalogPath?: string;
  projectRoutes?: Array<{ name: string; accountId: string; projectId: string; displayName?: string; sessionNamespace?: string; modelAliases?: Record<string, string> }>;
}
const nonempty = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// The only upstream failure that proves no question was submitted: the initial single-request
// file attachment stage failed strictly before Send. Any other error stays uncertain.
const PRE_SEND_ATTACHMENT_FAILURE = "prompt_attachments_not_submitted";
function preSendAttachmentFailure(value: unknown): boolean {
  const event = record(value);
  return [event, record(event.error), record(record(event.response).error)]
    .some(entry => entry.code === PRE_SEND_ATTACHMENT_FAILURE);
}

export function parseQaSessionEffort(value: unknown): { effort?: string; mode: "temporary" | "persistent"; explicit: boolean } {
  const effort = nonempty(value);
  const matched = effort && /^(none|minimal|low|medium|high|xhigh|max|ultra)-(temporary|persistent)$/.exec(effort);
  return matched ? { effort: matched[1], mode: matched[2] === "temporary" ? "temporary" : "persistent", explicit: true }
    : { effort, mode: "persistent", explicit: false };
}

export function normalizeQaPoolRequest(payload: Record<string, unknown>, headers: Headers, requestId = randomUUID()) {
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
  const normalized: Record<string, unknown> = { ...payload, client_metadata: { ...metadata,
    "x-codex-turn-metadata": JSON.stringify({ ...identity, thread_id: thread, turn_id: nonempty(identity.turn_id) ?? "qa-turn-" + requestId }),
  } };
  if (typeof normalized.input === "string") normalized.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: normalized.input }] }];
  if (Array.isArray(normalized.input)) normalized.input = normalized.input.map((item, index) => {
    const message = record(item);
    if (typeof message.role !== "string") return item;
    return { ...message, type: message.type ?? "message",
      ...(message.role === "user" && !message.id ? { id: "qa-message-" + requestId + "-" + index } : {}),
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

export function createQaPool(config: QaPoolConfig) {
  configValid(config);
  const databasePath = resolve(config.databasePath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath, { create: true });
  chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS sessions (session_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS temporary_history (session_hash TEXT PRIMARY KEY, input_json TEXT NOT NULL, response_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  const history = db.query<{ input_json: string; response_id: string; expires_at: number }, [string]>("SELECT input_json, response_id, expires_at FROM temporary_history WHERE session_hash=?");
  const putHistory = db.query("INSERT OR REPLACE INTO temporary_history VALUES (?, ?, ?, ?)");
  const deleteHistory = db.query("DELETE FROM temporary_history WHERE session_hash=?");
  const purgeHistory = db.query("DELETE FROM temporary_history WHERE expires_at<=?");
  purgeHistory.run(Date.now());
  const sweep = setInterval(() => purgeHistory.run(Date.now()), 60_000);
  sweep.unref();
  const activeHistories = new Set<string>();
  if (!(db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(column => column.name === "project_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT; ALTER TABLE sessions ADD COLUMN project_name TEXT;");
  }
  const papers = new PaperRegistry(db);
  const find = db.query<{ account_id: string; project_id: string | null; project_name: string | null }, [string]>("SELECT account_id, project_id, project_name FROM sessions WHERE session_hash = ?");
  const insert = db.query("INSERT OR IGNORE INTO sessions (session_hash, account_id, created_at, project_id, project_name) VALUES (?, ?, ?, ?, ?)");
  const count = db.query<{ account_id: string; n: number }, []>("SELECT account_id, COUNT(*) AS n FROM sessions GROUP BY account_id");
  const clients = config.clients.map(client => {
    const key = readFileSync(resolve(client.keyFile), "utf8").trim();
    if (key.length < 24) throw new Error("QA pool keys must contain at least 24 characters");
    return { id: client.id, digest: createHash("sha256").update("Bearer " + key).digest() };
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
    const url = new URL(request.url);
    const supplied = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
    const client = clients.find(value => timingSafeEqual(value.digest, supplied));
    if (!client) return failure(401, "unauthorized", "Unauthorized");
    const prefix = /^\/project\/([^/]+)(\/v1\/(?:models|responses(?:\/compact)?))$/.exec(url.pathname);
    const route = prefix ? config.projectRoutes?.find(value => value.name === prefix[1]) : undefined;
    if (url.pathname.startsWith("/project/") && !route) return failure(404, "project_route_unknown", "Unknown project route");
    const pathname = prefix?.[2] ?? url.pathname;
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
        const result = papers.resolve(id, scope, paperMetadata);
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
      if (paperMetadata.paper_operation !== "chat") return failure(400,"paper_operation_invalid","Use resolve or chat");
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
    if (cached && cached.expires_at <= Date.now()) {
      deleteHistory.run(hash);
      return failure(409, "temporary_history_expired", "Temporary context expired after 48 idle hours; start a new thread or supply its full history");
    }
    const retainHistory = account.sessionModes && (selection.mode === "temporary" || cached !== null && cached !== undefined);
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
    if (account.sessionModes) metadata._chatgpt_session_mode = selection.mode;
    if (owner.project_id) metadata._chatgpt_project = { id: owner.project_id, name: owner.project_name };
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
    const release = (notSubmitted = false) => {
      activeHistories.delete(hash);
      if (!paper) return;
      if (notSubmitted && !paperCompleted) papers.release(paper.id); else papers.finish(paper.id, paperCompleted);
    };
    const completed = (value: unknown) => {
      const response = record(value);
      if (response.status !== "completed" || typeof response.id !== "string" || !Array.isArray(response.output)) return;
      if (paper && !paperCompleted) { papers.complete(paper.id,paper.scope); paperCompleted = true; }
      if (selection.mode !== "temporary") { deleteHistory.run(hash); return; }
      const messages = response.output.filter(item => record(item).type === "message" && record(item).role === "assistant");
      putHistory.run(hash, JSON.stringify([...(Array.isArray(normalized.payload.input) ? normalized.payload.input : []), ...messages]), response.id, Date.now() + 48 * 60 * 60 * 1000);
    };
    if (paper) papers.begin(paper.id);
    if (retainHistory) activeHistories.add(hash);
    try {
      const response = await fetch(account.origin.replace(/\/$/, "") + pathname, {
        method: "POST", headers, body: JSON.stringify(normalized.payload), signal: request.signal, redirect: "error",
      });
      let body: BodyInit | null = response.body;
      let notSubmitted = false;
      const streaming = (response.headers.get("content-type") ?? "").includes("text/event-stream");
      if (paper && response.body && !streaming) {
        // A failed paper turn is not always an HTTP error, so classify the explicit pre-send
        // attachment failure from the body before deciding whether the reservation is retryable.
        const bytes = await response.arrayBuffer();
        let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { parsed = undefined; }
        if (response.ok) completed(parsed);
        // A 200 stream-less body can still carry status:"failed" with the explicit adapter code.
        if (!paperCompleted && parsed !== undefined && preSendAttachmentFailure(parsed)) notSubmitted = true;
        body = bytes; release(notSubmitted);
      } else if ((retainHistory || paper) && response.body && response.ok) {
        if (!streaming) {
          const bytes = await response.arrayBuffer(); completed(JSON.parse(new TextDecoder().decode(bytes)));
          body = bytes; release();
        } else {
          const reader = response.body.getReader(), decoder = new TextDecoder(); let buffered = "";
          body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) { release(notSubmitted); controller.close(); return; }
                buffered += decoder.decode(chunk.value, { stream: true });
                const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
                for (const line of lines) {
                  if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") continue;
                  const event = record(JSON.parse(line.slice(6)));
                  if (event.type === "response.completed") completed(event.response);
                  else if ((event.type === "response.failed" || event.type === "error") && preSendAttachmentFailure(event)) notSubmitted = true;
                }
                controller.enqueue(chunk.value);
              } catch (error) { release(notSubmitted); controller.error(error); }
            },
            async cancel(reason) { release(notSubmitted); await reader.cancel(reason); },
          });
        }
      } else release();
      return new Response(body, { status: response.status, headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      } });
    } catch { release(); return failure(502, "session_account_unreachable", "This session's account runtime is unreachable; retry after it recovers"); }
  }
  return { fetch: async (request: Request) => {
    try { return await fetchRequest(request); }
    catch (error) { if (error instanceof PaperError) return failure(error.status,error.code,error.message); throw error; }
  }, close: () => { clearInterval(sweep); db.close(); } };
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: qa-pool <config.json>");
  const config = JSON.parse(readFileSync(resolve(process.argv[2]), "utf8")) as QaPoolConfig;
  const pool = createQaPool(config);
  Bun.serve({ hostname: config.host, port: config.port, fetch: pool.fetch, maxRequestBodySize: 64 * 1024 * 1024, idleTimeout: 0 });
}
