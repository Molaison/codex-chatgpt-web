import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { ChatGptConversationStore } from "./adapters/chatgpt-web/conversation-persistence";
import { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } from "./adapters/chatgpt-web/qa-conversation-key";

export class PaperError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export interface PaperScope { accountId: string; projectId: string; sessionScope: string | string[]; directory: string }
export interface PaperRow {
  paper_id: string; account_id: string; project_id: string; thread_id: string; session_hash: string;
  state: "reserved" | "ready" | "uncertain"; upload_token: string | null; expires_at: number | null;
  conversation_url: string | null; pdf_sha256: string | null; in_flight: number;
}
export const poolSessionHash = (scope: string | string[], thread: string) => createHash("sha256").update(JSON.stringify(["qa-pool/v1", scope, thread])).digest("hex");
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
export class PaperRegistry {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS papers (
      paper_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, session_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
      upload_token TEXT, expires_at INTEGER, conversation_url TEXT, pdf_sha256 TEXT, in_flight INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS paper_aliases (alias_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(paper_id));
      CREATE TABLE IF NOT EXISTS paper_events (id INTEGER PRIMARY KEY, paper_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT);
      INSERT INTO paper_events(paper_id,at,event,detail) SELECT paper_id,datetime('now'),'restart_uncertain','Recovered unfinished dispatch' FROM papers WHERE in_flight=1;
      UPDATE papers SET state='uncertain', in_flight=0 WHERE in_flight=1;`);
  }
  event(id: string, event: string, detail = "") { this.db.query("INSERT INTO paper_events(paper_id,at,event,detail) VALUES(?,?,?,?)").run(id, new Date().toISOString(), event, detail); }
  get(id: string) { return this.db.query<PaperRow, [string]>("SELECT * FROM papers WHERE paper_id=COALESCE((SELECT paper_id FROM paper_aliases WHERE alias_id=?1),?1)").get(id)!; }
  mapping(row: PaperRow, scope: PaperScope): string {
    if (row.account_id !== scope.accountId || row.project_id !== scope.projectId || row.session_hash !== poolSessionHash(scope.sessionScope, row.thread_id)) throw new PaperError("paper_scope_mismatch", "Restore the paper's original account/project scope");
    const owner = this.db.query<{account_id:string;project_id:string},[string]>("SELECT account_id,project_id FROM sessions WHERE session_hash=?").get(row.session_hash);
    if (owner?.account_id !== scope.accountId || owner.project_id !== scope.projectId) throw new PaperError("paper_session_missing", "Original paper session ownership is missing");
    const key = chatGptQuestionAnswerKey("qa-pool-" + row.session_hash, chatGptQuestionAnswerNamespace(scope.accountId));
    let saved;
    try { saved = new ChatGptConversationStore(scope.directory, scope.accountId).lookup(key); }
    catch (error) { throw new PaperError("paper_mapping_unavailable", String(error)); }
    if (!saved?.url || saved.pendingProject || !saved.url.startsWith(`https://chatgpt.com/g/${scope.projectId}/c/`)
      || row.conversation_url && row.conversation_url !== saved.url) throw new PaperError("paper_mapping_missing", "Verified saved paper conversation mapping is required; no new chat was opened");
    return saved.url;
  }
  resolve(id: string, scope: PaperScope, metadata: Record<string, unknown>) {
    return this.db.transaction(() => {
      let row = this.get(id);
      const suppliedSha = metadata.paper_pdf_sha256;
      if (suppliedSha !== undefined && (typeof suppliedSha !== "string" || !/^[a-f0-9]{64}$/.test(suppliedSha))) throw new PaperError("paper_pdf_sha256_invalid", "Supply a lowercase PDF SHA256",400);
      const sha = id.startsWith("sha256:") ? id.slice(7) : typeof suppliedSha === "string" ? suppliedSha : undefined;
      if (id.startsWith("sha256:") && suppliedSha !== undefined && suppliedSha !== sha) throw new PaperError("paper_identity_conflict", "SHA identity disagrees with PDF hash");
      if (sha) {
        const matches = this.db.query<PaperRow,[string,string]>("SELECT * FROM papers WHERE pdf_sha256=? OR paper_id=?").all(sha,"sha256:"+sha);
        const candidates = matches.filter(candidate => candidate.paper_id !== row?.paper_id);
        if (row?.state === "ready" && (row.pdf_sha256 && row.pdf_sha256 !== sha || row.paper_id.startsWith("sha256:") && row.paper_id !== "sha256:"+sha)) throw new PaperError("paper_identity_conflict", "Paper already binds a different PDF hash");
        if (candidates.length) {
          if (candidates.length !== 1 || candidates[0]!.state !== "ready" || candidates[0]!.in_flight || row && (row.state !== "reserved" || row.in_flight)) throw new PaperError("paper_hash_conflict", "PDF hash has conflicting or unresolved paper bindings");
          if (row && (row.upload_token !== metadata.paper_upload_token || row.expires_at! <= Date.now())) throw new PaperError("paper_upload_token_invalid", "Only the valid reservation owner may link this DOI");
          const target = candidates[0]!;
          this.mapping(target,scope);
          if (row) this.db.query("DELETE FROM papers WHERE paper_id=?").run(row.paper_id);
          this.db.query("INSERT INTO paper_aliases(alias_id,paper_id) VALUES(?,?)").run(id,target.paper_id);
          this.event(id,"alias_bound",target.paper_id);
          return {...this.result(target,false),paper_id:id};
        }
      }
      if (!row) {
        const legacy = typeof metadata.paper_legacy_thread_id === "string" ? metadata.paper_legacy_thread_id.trim() : "";
        const uploaded = metadata.paper_legacy_uploaded === true;
        if (uploaded && !legacy) throw new PaperError("paper_legacy_mapping_missing", "Legacy uploaded paper requires its original thread and saved mapping");
        const thread = uploaded ? legacy : "paper-" + randomUUID();
        row = { paper_id:id, account_id:scope.accountId, project_id:scope.projectId, thread_id:thread, session_hash:poolSessionHash(scope.sessionScope,thread), state:"reserved", upload_token:randomUUID(), expires_at:Date.now()+900_000, conversation_url:null, pdf_sha256:null, in_flight:0 };
        if (uploaded) { row.conversation_url = this.mapping(row, scope); row.state = "ready"; row.upload_token = null; row.expires_at = null; }
        this.db.query("INSERT INTO papers VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id,row.account_id,row.project_id,thread,row.session_hash,row.state,row.upload_token,row.expires_at,row.conversation_url,null,0);
        this.event(id, uploaded ? "legacy_adopted" : "reserved");
        return this.result(row, true);
      }
      if (row.account_id !== scope.accountId || row.project_id !== scope.projectId || row.session_hash !== poolSessionHash(scope.sessionScope,row.thread_id)) throw new PaperError("paper_scope_mismatch", "Original paper account/project required");
      if (row.state === "ready") this.mapping(row, scope);
      if (row.state === "reserved" && !row.in_flight && row.expires_at! <= Date.now()) {
        this.db.query("UPDATE papers SET upload_token=?,expires_at=? WHERE paper_id=?").run(randomUUID(),Date.now()+900_000,id);
        this.event(id,"reservation_expired"); row=this.get(id); return this.result(row,true);
      }
      return {...this.result(row,metadata.paper_upload_token === row.upload_token),paper_id:id};
    }).immediate();
  }
  result(row: PaperRow, owns: boolean) {
    const upload = row.state === "reserved" && !row.in_flight && owns;
    return {paper_id:row.paper_id, status:row.in_flight ? "pending" : row.state === "reserved" ? upload ? "missing" : "pending" : row.state,
      upload_required:upload, ...(upload ? {upload_token:row.upload_token} : {}), thread_id:row.thread_id, ...(row.conversation_url ? {conversation_url:row.conversation_url} : {})};
  }
  prepare(id: string, scope: PaperScope, metadata: Record<string, unknown>, input: unknown) {
    try {
    const row = this.get(id);
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
      const duplicate = this.db.query<{paper_id:string},[string,string,string]>("SELECT paper_id FROM papers WHERE (pdf_sha256=? OR paper_id=?) AND paper_id!=?").get(sha,"sha256:"+sha,row.paper_id);
      if (duplicate) throw new PaperError("paper_hash_resolve_required", "Resolve with paper_pdf_sha256 before uploading an already registered PDF");
      this.db.query("UPDATE papers SET pdf_sha256=? WHERE paper_id=?").run(sha,row.paper_id);
    }
    return {row,input:clean};
    } catch (error) {
      if (error instanceof PaperError) this.event(id,"pre_upload_rejected",error.code);
      throw error;
    }
  }
  begin(id: string) {
    if (this.db.query("UPDATE papers SET in_flight=1 WHERE paper_id=? AND in_flight=0 AND state!='uncertain'").run(id).changes !== 1) throw new PaperError("paper_busy","Wait for this paper turn");
    this.event(id,"dispatch_started");
  }
  complete(id: string, scope: PaperScope) {
    const url = this.mapping(this.get(id),scope);
    this.db.query("UPDATE papers SET state='ready',conversation_url=?,upload_token=NULL,expires_at=NULL WHERE paper_id=?").run(url,id);
    this.event(id,"response_completed",url);
  }
  finish(id: string, completed: boolean) {
    this.db.query("UPDATE papers SET state=CASE WHEN ? THEN state ELSE 'uncertain' END,in_flight=0 WHERE paper_id=?").run(completed ? 1 : 0,id);
    if (!completed) this.event(id,"submission_uncertain","No verified completed response and saved mapping");
  }
  // A confirmed pre-send attachment failure never reached Send, so no question was submitted.
  // Keep the row, thread, PDF hash and reservation token (only refreshing an expired reservation)
  // so the same client can retry instead of being locked out by an unverifiable uncertainty.
  release(id: string, now = Date.now()) {
    const row = this.get(id);
    if (!row?.in_flight) return;
    const expires = row.state === "reserved" && (row.expires_at === null || row.expires_at <= now) ? now + 900_000 : row.expires_at;
    this.db.query("UPDATE papers SET in_flight=0,expires_at=? WHERE paper_id=?").run(expires,id);
    this.event(id,"dispatch_not_submitted","Confirmed pre-send attachment failure; reservation kept for retry");
  }
}
