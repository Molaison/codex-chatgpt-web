import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { createReceiptStore } from "../src/qa-pool-receipts";

let root: string;
const databases: Database[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "qa-recovery-records-")); });
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});
function database(): Database {
  const db = new Database(":memory:"); databases.push(db); return db;
}

test("receipts retain each request identity after later turns in the same session", () => {
  const store = createReceiptStore(database());
  const expiresAt = Date.now() + 60_000;
  store.begin("session", "request-a", "digest-a", expiresAt);
  store.complete("session", "request-a", { id: "response-a", status: "completed" }, expiresAt);
  store.begin("session", "request-b", "digest-b", expiresAt);
  store.complete("session", "request-b", { id: "response-b", status: "completed" }, expiresAt);
  expect(store.get("session", "request-a")).toMatchObject({ digest: "digest-a", state: "completed" });
  expect(JSON.parse(store.get("session", "request-a")!.response_json!).response.id).toBe("response-a");
  expect(store.get("session", "request-b")).toMatchObject({ digest: "digest-b", state: "completed" });
  expect(() => store.begin("session", "request-a", "replacement", expiresAt)).toThrow();
  expect(store.get("session", "request-a")!.digest).toBe("digest-a");
});

test("legacy receipt migration preserves completed and uncertain work", () => {
  const db = database();
  db.exec("CREATE TABLE qa_request_receipts (session_hash TEXT PRIMARY KEY, identity_hash TEXT NOT NULL, digest TEXT, response_json TEXT, expires_at INTEGER NOT NULL, state TEXT NOT NULL)");
  const insert = db.query("INSERT INTO qa_request_receipts VALUES (?, ?, ?, ?, ?, ?)");
  const expiresAt = Date.now() + 60_000;
  insert.run("session", "request-a", "digest-a", JSON.stringify({ response: { id: "response-a" } }), expiresAt, "completed");
  insert.run("uncertain-session", "pending", "digest-pending", null, expiresAt, "pending");
  const store = createReceiptStore(db);
  store.begin("session", "request-b", "digest-b", expiresAt);
  expect(store.get("session", "request-a")).toMatchObject({ state: "completed", digest: "digest-a" });
  expect(store.get("uncertain-session", "pending")).toMatchObject({ state: "pending", digest: "digest-pending" });
  expect(() => store.begin("uncertain-session", "pending", "changed", expiresAt)).toThrow();
  expect(createReceiptStore(db).get("session", "request-a")).toEqual(store.get("session", "request-a"));
  const columns = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(qa_request_receipts)").all();
  expect(columns.filter(column => column.pk).map(column => column.name)).toEqual(["session_hash", "identity_hash"]);
});

test("expired and unretained receipt identities remain fences after another turn", () => {
  const store = createReceiptStore(database());
  store.begin("session", "expired", "digest-expired", Date.now() - 1);
  store.purge();
  store.begin("session", "unretained", "digest-unretained", Date.now() + 60_000);
  store.complete("session", "unretained", { id: "response" }, Date.now() + 60_000, undefined, false);
  store.begin("session", "later", "digest-later", Date.now() + 60_000);
  expect(store.get("session", "expired")).toMatchObject({ digest: null, response_json: null, state: "expired" });
  expect(store.get("session", "unretained")).toMatchObject({ response_json: null, state: "completed_unretained" });
});

test("cancelling an unsubmitted recovery restores the complete saved conversation", () => {
  const store = new ChatGptConversationStore(root, "account");
  const project = { id: "g-p-" + "a".repeat(32), name: "Paper library" };
  const bound = store.bind("thread", store.reserve("thread"), "https://chatgpt.com/c/original", project);
  const original = store.recordHistory("thread", bound, ["a".repeat(64), "b".repeat(64)]);
  const recovery = store.recover("thread", original);
  expect(() => store.lookup("thread")).toThrow(expect.objectContaining({ code: "saved_conversation_unresolved" }));
  const restarted = new ChatGptConversationStore(root, "account");
  restarted.cancelBeforeSend("thread", recovery);
  expect(restarted.lookup("thread")).toEqual(original);
  expect(readdirSync(store.directory)).toHaveLength(1);
});

test("recovery rollback preserves prior uncertainty and earlier recovery lineage", () => {
  const store = new ChatGptConversationStore(root, "account");
  const initial = store.bind("thread", store.reserve("thread"), "https://chatgpt.com/c/original");
  const firstRecovery = store.recover("thread", initial);
  const secondRecovery = store.recover("thread", firstRecovery);
  expect(() => store.cancelBeforeSend("thread", firstRecovery)).toThrow(expect.objectContaining({ code: "saved_conversation_conflict" }));
  store.cancelBeforeSend("thread", secondRecovery);
  expect(store.read("thread")).toEqual(firstRecovery);
  expect(() => store.lookup("thread")).toThrow(expect.objectContaining({ code: "saved_conversation_unresolved" }));
  store.cancelBeforeSend("thread", firstRecovery);
  expect(store.lookup("thread")).toEqual(initial);
});
