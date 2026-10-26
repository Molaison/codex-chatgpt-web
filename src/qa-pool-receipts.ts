import { Database } from "bun:sqlite";
import { isNativeTextCompaction } from "./responses/compaction";
import { createHash } from "node:crypto";

export const MAX_RECEIPT_BYTES = 1024 * 1024;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

export function isQaCompactionRequest(payload: Record<string, unknown>): boolean {
  return (Array.isArray(payload.input) && payload.input.some(item => item && typeof item === "object"
    && (item as Record<string, unknown>).type === "compaction_trigger")) || isNativeTextCompaction(payload);
}

export function receiptIdentity(payload: Record<string, unknown>, native: Record<string, unknown>, scope: string) {
  const explicit = typeof native.request_id === "string" && native.request_id.trim() ? native.request_id.trim() : undefined;
  const turn = typeof native.turn_id === "string" && native.turn_id.trim() ? native.turn_id.trim() : undefined;
  if (!explicit && !turn) return undefined;
  const input = Array.isArray(payload.input) ? payload.input : [];
  const structure = input.map((value, index) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (item.role === "user") return ["user", item.id ?? index];
    if (typeof item.type === "string" && item.type.endsWith("_output")) return [item.type, item.call_id ?? null];
    return null;
  }).filter(Boolean);
  return { key: hash(["qa-receipt/v1", scope, explicit ? ["request", turn ?? null, explicit] : ["turn", turn, structure]]), digest: hash(canonical(payload)) };
}

export function createReceiptStore(db: Database) {
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS qa_request_receipts (session_hash TEXT NOT NULL, identity_hash TEXT NOT NULL, digest TEXT, response_json TEXT, expires_at INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (session_hash, identity_hash))");
    const columns = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(qa_request_receipts)").all();
    if (columns.find(column => column.name === "identity_hash")?.pk === 0) {
      // Older pools retained only the latest receipt per session. Preserve that
      // receipt, including uncertain work, while allowing every request its own fence.
      db.exec("CREATE TABLE qa_request_receipts_migration (session_hash TEXT NOT NULL, identity_hash TEXT NOT NULL, digest TEXT, response_json TEXT, expires_at INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (session_hash, identity_hash))");
      db.exec("INSERT INTO qa_request_receipts_migration SELECT session_hash, identity_hash, digest, response_json, expires_at, state FROM qa_request_receipts");
      db.exec("DROP TABLE qa_request_receipts; ALTER TABLE qa_request_receipts_migration RENAME TO qa_request_receipts");
    }
  }).immediate();
  const get = db.query<{ digest: string | null; response_json: string | null; expires_at: number; state: string }, [string, string]>("SELECT digest, response_json, expires_at, state FROM qa_request_receipts WHERE session_hash=? AND identity_hash=?");
  const insert = db.query("INSERT INTO qa_request_receipts VALUES (?, ?, ?, NULL, ?, 'pending')");
  const finish = db.query("UPDATE qa_request_receipts SET response_json=?, state=?, expires_at=? WHERE session_hash=? AND identity_hash=? AND state='pending'");
  const forget = db.query("UPDATE qa_request_receipts SET digest=NULL, response_json=NULL, state='completed_unretained' WHERE session_hash=?");
  const remove = db.query("DELETE FROM qa_request_receipts WHERE session_hash=? AND identity_hash=? AND state='pending'");
  const purge = db.query("UPDATE qa_request_receipts SET digest=NULL, response_json=NULL, state='expired' WHERE expires_at<=? AND state!='expired'");
  return { get: (session: string, key: string) => get.get(session, key),
    begin: (session: string, key: string, digest: string, expiry: number) => insert.run(session, key, digest, expiry),
    complete: (session: string, key: string, response: unknown, expiresAt: number, wire?: Uint8Array, cacheable = true) => {
      let json = cacheable ? JSON.stringify({ response, ...(wire ? { wire: Buffer.from(wire).toString("base64") } : {}) }) : null;
      if (json && Buffer.byteLength(json) > MAX_RECEIPT_BYTES) json = null;
      if (finish.run(json, json ? "completed" : "completed_unretained", expiresAt, session, key).changes !== 1) throw new Error("Receipt is no longer pending");
    },
    promote: (session: string) => forget.run(session),
    release: (session: string, key: string) => remove.run(session, key),
    purge: () => purge.run(Date.now()),
  };
}

export function replayReceipt(saved: { response: Record<string, unknown>; wire?: string }): Response {
  if (!saved.wire) return Response.json(saved.response, { headers: { "cache-control": "no-store" } });
  return new Response(Buffer.from(saved.wire, "base64"), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}
