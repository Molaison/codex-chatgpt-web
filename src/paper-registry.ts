import { Database } from "bun:sqlite";
import { readLauncherPaperRecovery, validatePaperRecovery, type PaperRecoveryOptions } from "./paper-recovery";
import { createHash, randomUUID } from "node:crypto";
import { ChatGptConversationStore } from "./adapters/chatgpt-web/conversation-persistence";
import { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } from "./adapters/chatgpt-web/qa-conversation-key";

export class PaperError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export interface PaperScope { accountId: string; projectId: string; sessionScope: string | string[]; directory: string }
export interface PaperRow {
  paper_id: string; session_key: string; account_id: string; project_id: string; thread_id: string; session_hash: string;
  state: "reserved" | "ready" | "uncertain"; upload_token: string | null; expires_at: number | null;
  conversation_url: string | null; pdf_sha256: string | null; in_flight: number;
}
export const poolSessionHash = (scope: string | string[], thread: string) => createHash("sha256").update(JSON.stringify(["qa-pool/v1", scope, thread])).digest("hex");
export function normalizePaperSessionKey(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new PaperError("paper_session_id_invalid", "paper_session_id must be a string", 400);
  const key = value.trim();
  if (!key) return "";
  if (key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new PaperError("paper_session_id_invalid", "paper_session_id contains unsupported characters", 400);
  }
  return key;
}
export function normalizePaperId(value: unknown): string {
  if (typeof value !== "string") throw new PaperError("paper_id_invalid", "paper_id is required", 400);
  if (/^sha256:[a-f0-9]{64}$/i.test(value.trim())) return value.trim().toLowerCase();
  if (!/^doi:/i.test(value.trim())) throw new PaperError("paper_id_invalid", "Use doi: or sha256: identity", 400);
  let doi = value.trim().replace(/^doi:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  try { doi = decodeURIComponent(doi).trim().toLowerCase(); } catch { throw new PaperError("paper_id_invalid", "Invalid encoded DOI", 400); }
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new PaperError("paper_id_invalid", "Invalid DOI", 400);
  return "doi:" + doi;
}
export function paperInput(input: unknown, ready: boolean): unknown[] {
  if (typeof input === "string") return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  if (!Array.isArray(input)) throw new PaperError("paper_input_invalid", "A new user question is required", 400);
  const latest = input.findLast(item => item?.role === "user");
  if (!latest) throw new PaperError("paper_input_invalid", "A new user question is required", 400);
  const content = typeof latest.content === "string" ? [{ type: "input_text", text: latest.content }] : latest.content;
  if (!Array.isArray(content)) throw new PaperError("paper_input_invalid", "Invalid question content", 400);
  const kept = ready ? content.filter(part => part.type === "input_text") : content;
  if (!kept.some(part => part.type === "input_text" && typeof part.text === "string" && part.text.trim())) throw new PaperError("paper_input_invalid", "A new user question is required", 400);
  return [{ ...latest, content: kept }];
}

const papersTable = `CREATE TABLE papers (
  paper_id TEXT NOT NULL, session_key TEXT NOT NULL DEFAULT '', account_id TEXT NOT NULL, project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL, session_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  upload_token TEXT, expires_at INTEGER, conversation_url TEXT, pdf_sha256 TEXT, in_flight INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (paper_id, session_key));`;
const aliasesTable = "CREATE TABLE paper_aliases (alias_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL);";

export class PaperRegistry {
  constructor(private db: Database) {
    this.ensureSchema();
    db.exec(`INSERT INTO paper_events(paper_id,session_key,at,event,detail)
      SELECT paper_id,session_key,datetime('now'),'restart_uncertain','Recovered unfinished dispatch' FROM papers WHERE in_flight=1;
      UPDATE papers SET state='uncertain', in_flight=0 WHERE in_flight=1;`);
  }
  private ensureSchema() {
    const hasTable = (name: string) => Boolean(this.db.query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name));
    const columns = (name: string) => hasTable(name)
      ? this.db.query<{ name: string }, []>(`PRAGMA table_info(${name})`).all().map(column => column.name)
      : [];
    const paperColumns = columns("papers");
    if (!paperColumns.length) {
      this.db.exec(papersTable);
    } else if (!paperColumns.includes("session_key")) {
      this.db.transaction(() => {
        const hadAliases = hasTable("paper_aliases");
        this.db.exec("ALTER TABLE papers RENAME TO papers_legacy");
        if (hadAliases) this.db.exec("ALTER TABLE paper_aliases RENAME TO paper_aliases_legacy");
        this.db.exec(papersTable);
        this.db.exec(`INSERT INTO papers
          (paper_id,session_key,account_id,project_id,thread_id,session_hash,state,upload_token,expires_at,conversation_url,pdf_sha256,in_flight)
          SELECT paper_id,'',account_id,project_id,thread_id,session_hash,state,upload_token,expires_at,conversation_url,pdf_sha256,in_flight
          FROM papers_legacy`);
        this.db.exec("DROP TABLE papers_legacy");
        this.db.exec(aliasesTable);
        if (hadAliases) {
          this.db.exec("INSERT INTO paper_aliases(alias_id,paper_id) SELECT alias_id,paper_id FROM paper_aliases_legacy");
          this.db.exec("DROP TABLE paper_aliases_legacy");
        }
      }).immediate();
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS paper_aliases (alias_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_events (id INTEGER PRIMARY KEY, paper_id TEXT NOT NULL, session_key TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT);`);
    if (!columns("paper_events").includes("session_key")) {
      this.db.exec("ALTER TABLE paper_events ADD COLUMN session_key TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS papers_paper_idx ON papers(paper_id);
      CREATE INDEX IF NOT EXISTS papers_pdf_idx ON papers(pdf_sha256);
      CREATE INDEX IF NOT EXISTS paper_events_owner_idx ON paper_events(paper_id,session_key,event,id);`);
  }
  event(id: string, event: string, detail = "", sessionKey = "") {
    this.db.query("INSERT INTO paper_events(paper_id,session_key,at,event,detail) VALUES(?,?,?,?,?)")
      .run(id, sessionKey, new Date().toISOString(), event, detail);
  }
  get(id: string, sessionKey = "") {
    const key = normalizePaperSessionKey(sessionKey);
    return this.db.query<PaperRow, [string, string]>(`SELECT * FROM papers
      WHERE session_key=?1 AND paper_id=COALESCE((SELECT paper_id FROM paper_aliases WHERE alias_id=?2),?2)`).get(key, id)!;
  }
  private canonicalPaperId(id: string): string | undefined {
    const alias = this.db.query<{ paper_id: string }, [string]>(
      "SELECT paper_id FROM paper_aliases WHERE alias_id=?",
    ).get(id);
    if (alias) return alias.paper_id;
    return this.db.query<{ paper_id: string }, [string]>(
      "SELECT paper_id FROM papers WHERE paper_id=? LIMIT 1",
    ).get(id)?.paper_id;
  }
  private assertKnownPdfHash(paperId: string, sha: string | undefined) {
    if (!sha) return;
    const hashes = this.db.query<{ pdf_sha256: string }, [string]>(
      "SELECT DISTINCT pdf_sha256 FROM papers WHERE paper_id=? AND pdf_sha256 IS NOT NULL LIMIT 2",
    ).all(paperId).map(row => row.pdf_sha256);
    if (hashes.length > 1 || hashes[0] && hashes[0] !== sha) {
      throw new PaperError("paper_identity_conflict", "Paper already binds a different PDF hash");
    }
  }
  mapping(row: PaperRow, scope: PaperScope): string { return this.savedMapping(row, scope).url!; }
  private savedMapping(row: PaperRow, scope: PaperScope) {
    if (row.account_id !== scope.accountId || row.project_id !== scope.projectId || row.session_hash !== poolSessionHash(scope.sessionScope, row.thread_id)) throw new PaperError("paper_scope_mismatch", "Restore the paper's original account/project scope");
    const owner = this.db.query<{account_id:string;project_id:string},[string]>("SELECT account_id,project_id FROM sessions WHERE session_hash=?").get(row.session_hash);
    if (owner?.account_id !== scope.accountId || owner.project_id !== scope.projectId) throw new PaperError("paper_session_missing", "Original paper session ownership is missing");
    const key = chatGptQuestionAnswerKey("qa-pool-" + row.session_hash, chatGptQuestionAnswerNamespace(scope.accountId));
    let saved;
    try { saved = new ChatGptConversationStore(scope.directory, scope.accountId).lookup(key); }
    catch (error) { throw new PaperError("paper_mapping_unavailable", String(error)); }
    if (!saved?.url || saved.pendingProject || !saved.url.startsWith(`https://chatgpt.com/g/${scope.projectId}/c/`)
      || row.conversation_url && row.conversation_url !== saved.url) throw new PaperError("paper_mapping_missing", "Verified saved paper conversation mapping is required; no new chat was opened");
    return saved;
  }
  private insertReserved(paperId: string, sessionKey: string, scope: PaperScope, thread = "paper-" + randomUUID()) {
    const row: PaperRow = {
      paper_id: paperId, session_key: sessionKey, account_id: scope.accountId, project_id: scope.projectId,
      thread_id: thread, session_hash: poolSessionHash(scope.sessionScope, thread), state: "reserved",
      upload_token: randomUUID(), expires_at: Date.now() + 900_000, conversation_url: null, pdf_sha256: null, in_flight: 0,
    };
    this.db.query(`INSERT INTO papers
      (paper_id,session_key,account_id,project_id,thread_id,session_hash,state,upload_token,expires_at,conversation_url,pdf_sha256,in_flight)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.paper_id, row.session_key, row.account_id, row.project_id, row.thread_id, row.session_hash, row.state,
      row.upload_token, row.expires_at, row.conversation_url, row.pdf_sha256, row.in_flight,
    );
    return row;
  }
  resolve(id: string, scope: PaperScope, metadata: Record<string, unknown>, sessionKey = "") {
    const key = normalizePaperSessionKey(sessionKey);
    return this.db.transaction(() => {
      let row = this.get(id, key);
      const suppliedSha = metadata.paper_pdf_sha256;
      if (suppliedSha !== undefined && (typeof suppliedSha !== "string" || !/^[a-f0-9]{64}$/.test(suppliedSha))) throw new PaperError("paper_pdf_sha256_invalid", "Supply a lowercase PDF SHA256",400);
      const sha = id.startsWith("sha256:") ? id.slice(7) : typeof suppliedSha === "string" ? suppliedSha : undefined;
      if (id.startsWith("sha256:") && suppliedSha !== undefined && suppliedSha !== sha) throw new PaperError("paper_identity_conflict", "SHA identity disagrees with PDF hash");
      let canonical = row?.paper_id ?? this.canonicalPaperId(id) ?? id;
      this.assertKnownPdfHash(canonical, sha);
      if (row?.state === "ready" && sha && (row.pdf_sha256 && row.pdf_sha256 !== sha || row.paper_id.startsWith("sha256:") && row.paper_id !== "sha256:"+sha)) throw new PaperError("paper_identity_conflict", "Paper already binds a different PDF hash");
      if (sha) {
        const matches = this.db.query<{ paper_id: string }, [string, string]>(
          "SELECT DISTINCT paper_id FROM papers WHERE pdf_sha256=? OR paper_id=?",
        ).all(sha, "sha256:" + sha);
        const candidates = matches.filter(candidate => candidate.paper_id !== canonical && candidate.paper_id !== id);
        if (candidates.length > 1) throw new PaperError("paper_hash_conflict", "PDF hash has conflicting paper bindings");
        const target = candidates[0] ? this.db.query<PaperRow, [string]>(`SELECT * FROM papers
          WHERE paper_id=? AND state='ready' AND in_flight=0
          ORDER BY CASE WHEN session_key='' THEN 0 ELSE 1 END, rowid LIMIT 1`).get(candidates[0].paper_id) : undefined;
        if (candidates.length && !target) throw new PaperError("paper_hash_conflict", "PDF hash has conflicting or unresolved paper bindings");
        if (target) {
          if (row && (row.state !== "reserved" || row.in_flight || row.upload_token !== metadata.paper_upload_token || row.expires_at! <= Date.now())) {
            throw new PaperError("paper_hash_conflict", "PDF hash has conflicting or unresolved paper bindings");
          }
          this.mapping(target, scope);
          if (row && row.paper_id !== target.paper_id) {
            this.db.query("DELETE FROM papers WHERE paper_id=? AND session_key=?").run(row.paper_id, row.session_key);
          }
          this.db.query("INSERT OR REPLACE INTO paper_aliases(alias_id,paper_id) VALUES(?,?)").run(id, target.paper_id);
          this.event(id, "alias_bound", target.paper_id, key);
          canonical = target.paper_id;
          this.assertKnownPdfHash(canonical, sha);
          row = this.get(canonical, key);
        }
      }
      if (!row) {
        const legacy = key === "" && typeof metadata.paper_legacy_thread_id === "string"
          ? metadata.paper_legacy_thread_id.trim() : "";
        const uploaded = key === "" && metadata.paper_legacy_uploaded === true;
        if (uploaded && !legacy) throw new PaperError("paper_legacy_mapping_missing", "Legacy uploaded paper requires its original thread and saved mapping");
        row = this.insertReserved(canonical, key, scope, uploaded ? legacy : undefined);
        if (uploaded) {
          row.conversation_url = this.mapping(row, scope);
          row.state = "ready";
          row.upload_token = null;
          row.expires_at = null;
          this.db.query(`UPDATE papers SET state='ready',conversation_url=?,upload_token=NULL,expires_at=NULL
            WHERE paper_id=? AND session_key=?`).run(row.conversation_url, row.paper_id, row.session_key);
        }
        this.event(canonical, uploaded ? "legacy_adopted" : "reserved", "", key);
        return { ...this.result(row, true), paper_id: id };
      }
      if (row.account_id !== scope.accountId || row.project_id !== scope.projectId || row.session_hash !== poolSessionHash(scope.sessionScope,row.thread_id)) throw new PaperError("paper_scope_mismatch", "Original paper account/project required");
      if (row.state === "ready") this.mapping(row, scope);
      if (row.state === "reserved" && !row.in_flight && row.expires_at! <= Date.now()) {
        this.db.query("UPDATE papers SET upload_token=?,expires_at=? WHERE paper_id=? AND session_key=?")
          .run(randomUUID(),Date.now()+900_000,row.paper_id,row.session_key);
        this.event(row.paper_id,"reservation_expired","",row.session_key);
        row=this.get(row.paper_id,row.session_key);
        return { ...this.result(row,true), paper_id: id };
      }
      return {...this.result(row,metadata.paper_upload_token === row.upload_token),paper_id:id};
    }).immediate();
  }
  async reconcile(id: string, scope: PaperScope, options: PaperRecoveryOptions, sessionKey = "") {
    const key = normalizePaperSessionKey(sessionKey);
    const row = this.get(id, key);
    if (!row) throw new PaperError("paper_resolve_required", "Resolve this paper before recovery");
    const saved = this.savedMapping(row, scope);
    if (row.state !== "uncertain" || row.in_flight) throw new PaperError("paper_recovery_state_changed", "Only an idle uncertain paper can be reconciled");
    const dispatch = this.latestDispatch(row.paper_id, row.session_key);
    if (!dispatch || !Number.isFinite(Date.parse(dispatch.at))) throw new PaperError("paper_recovery_dispatch_missing", "The original dispatch event is required for recovery");
    options.signal.throwIfAborted();
    // Keep launcher/network work outside the SQLite write transaction.
    const raw = await (options.reader ?? readLauncherPaperRecovery)({
      accountId: row.account_id, sessionHash: row.session_hash, conversationUrl: saved.url!,
      browserHostDescriptorPath: options.browserHostDescriptorPath, signal: options.signal,
    });
    options.signal.throwIfAborted();
    const evidence = validatePaperRecovery(raw, {
      conversationUrl: saved.url!, projectId: row.project_id, dispatchStartedAt: dispatch.at,
      firstUpload: row.conversation_url === null, pdfSha256: row.pdf_sha256,
    });
    return this.db.transaction(() => {
      const current = this.get(id, key), latest = this.latestDispatch(row.paper_id, row.session_key);
      if (!current || (Object.keys(row) as Array<keyof PaperRow>).some(field => current[field] !== row[field])
        || latest?.id !== dispatch.id || latest.at !== dispatch.at) {
        throw new PaperError("paper_recovery_state_changed", "Paper ownership, state or dispatch changed during the saved-conversation read");
      }
      const mapping = this.savedMapping(current, scope);
      if (mapping.url !== saved.url || mapping.claim !== saved.claim || mapping.createdAt !== saved.createdAt) {
        throw new PaperError("paper_recovery_mapping_changed", "The original native conversation mapping changed during recovery");
      }
      this.db.query(`UPDATE papers SET state='ready',conversation_url=?,upload_token=NULL,expires_at=NULL
        WHERE paper_id=? AND session_key=?`).run(saved.url!, row.paper_id, row.session_key);
      this.event(row.paper_id, "response_reconciled", JSON.stringify({
        dispatch_event_id: dispatch.id, dispatch_started_at: dispatch.at, conversation_url: saved.url, ...evidence,
      }), row.session_key);
      return { ...this.result(this.get(row.paper_id, row.session_key), false), paper_id: id };
    }).immediate();
  }
  private latestDispatch(id: string, sessionKey = "") {
    return this.db.query<{ id: number; at: string }, [string, string]>(
      "SELECT id,at FROM paper_events WHERE paper_id=? AND session_key=? AND event='dispatch_started' ORDER BY id DESC LIMIT 1",
    ).get(id, sessionKey);
  }
  result(row: PaperRow, owns: boolean) {
    const upload = row.state === "reserved" && !row.in_flight && owns;
    return {paper_id:row.paper_id, paper_registry_version:2, paper_session_id:row.session_key,
      status:row.in_flight ? "pending" : row.state === "reserved" ? upload ? "missing" : "pending" : row.state,
      upload_required:upload, ...(upload ? {upload_token:row.upload_token} : {}), thread_id:row.thread_id, ...(row.conversation_url ? {conversation_url:row.conversation_url} : {})};
  }
  prepare(id: string, scope: PaperScope, metadata: Record<string, unknown>, input: unknown, sessionKey = "") {
    const key = normalizePaperSessionKey(sessionKey);
    try {
    const row = this.get(id, key);
    if (!row) throw new PaperError("paper_resolve_required", "Resolve this paper before uploading");
    if (row.in_flight) throw new PaperError("paper_busy", "Wait for the current paper turn");
    if (row.state === "uncertain") throw new PaperError("paper_uncertain", "Earlier submission is uncertain; inspect it before retrying");
    if (row.account_id !== scope.accountId || row.project_id !== scope.projectId || row.session_hash !== poolSessionHash(scope.sessionScope,row.thread_id)) throw new PaperError("paper_scope_mismatch", "Original paper scope required");
    if (row.state === "ready") this.mapping(row,scope);
    const clean = paperInput(input,row.state === "ready");
    if (row.state === "reserved") {
      if (metadata.paper_upload_token !== row.upload_token || row.expires_at! <= Date.now()) throw new PaperError("paper_upload_token_invalid", "Resolve for a valid upload reservation");
      const files = clean.flatMap((item:any) => item.content.filter((part:any) => part.type === "input_file"));
      if (files.length !== 1 || typeof files[0].file_data !== "string") throw new PaperError("paper_pdf_required", "Supply exactly one inline PDF",400);
      const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]*={0,2})$/.exec(files[0].file_data);
      if (!match) throw new PaperError("paper_pdf_invalid", "Expected a base64 PDF data URL",400);
      const bytes = Buffer.from(match[1]!,"base64"), sha = createHash("sha256").update(bytes).digest("hex");
      if (!bytes.subarray(0,5).equals(Buffer.from("%PDF-")) || sha !== metadata.paper_pdf_sha256 || id.startsWith("sha256:") && id !== "sha256:"+sha) {
        throw new PaperError("paper_pdf_sha256_mismatch", "Actual PDF does not match declared SHA256",400);
      }
      const duplicate = this.db.query<{paper_id:string},[string,string,string]>(
        "SELECT paper_id FROM papers WHERE (pdf_sha256=? OR paper_id=?) AND paper_id!=? LIMIT 1",
      ).get(sha,"sha256:"+sha,row.paper_id);
      if (duplicate) throw new PaperError("paper_hash_resolve_required", "Resolve with paper_pdf_sha256 before uploading an already registered PDF");
      this.db.query("UPDATE papers SET pdf_sha256=? WHERE paper_id=? AND session_key=?").run(sha,row.paper_id,row.session_key);
      row.pdf_sha256 = sha;
    }
    return {row,input:clean};
    } catch (error) {
      if (error instanceof PaperError) this.event(id,"pre_upload_rejected",error.code,key);
      throw error;
    }
  }
  begin(id: string, sessionKey = "") {
    const key = normalizePaperSessionKey(sessionKey);
    if (this.db.query("UPDATE papers SET in_flight=1 WHERE paper_id=? AND session_key=? AND in_flight=0 AND state!='uncertain'").run(id,key).changes !== 1) throw new PaperError("paper_busy","Wait for this paper turn");
    this.event(id,"dispatch_started","",key);
  }
  complete(id: string, scope: PaperScope, sessionKey = "") {
    const key = normalizePaperSessionKey(sessionKey);
    const url = this.mapping(this.get(id,key),scope);
    this.db.query("UPDATE papers SET state='ready',conversation_url=?,upload_token=NULL,expires_at=NULL WHERE paper_id=? AND session_key=?").run(url,id,key);
    this.event(id,"response_completed",url,key);
  }
  finish(id: string, completed: boolean, sessionKey = "") {
    const key = normalizePaperSessionKey(sessionKey);
    this.db.query("UPDATE papers SET state=CASE WHEN ? THEN state ELSE 'uncertain' END,in_flight=0 WHERE paper_id=? AND session_key=?").run(completed ? 1 : 0,id,key);
    if (!completed) this.event(id,"submission_uncertain","No verified completed response and saved mapping",key);
  }
  // A confirmed pre-send attachment failure never reached Send, so no question was submitted.
  // Keep the row, thread, PDF hash and reservation token (only refreshing an expired reservation)
  // so the same client can retry instead of being locked out by an unverifiable uncertainty.
  release(id: string, sessionKey = "", now = Date.now()) {
    const key = normalizePaperSessionKey(sessionKey);
    const row = this.get(id,key);
    if (!row?.in_flight) return;
    const expires = row.state === "reserved" && (row.expires_at === null || row.expires_at <= now) ? now + 900_000 : row.expires_at;
    this.db.query("UPDATE papers SET in_flight=0,expires_at=? WHERE paper_id=? AND session_key=?").run(expires,id,key);
    this.event(id,"dispatch_not_submitted","Confirmed pre-send attachment failure; reservation kept for retry",key);
  }
}
