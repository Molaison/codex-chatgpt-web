import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaPool, type QaPoolConfig } from "../src/qa-pool";
import { QaHealthAdmission, type HostAssignmentAdmission } from "../src/qa-health";
import { syntheticQaHealthAdmission as proof } from "./qa-pool-health-fixture";

let root: string;
let pool: ReturnType<typeof createQaPool> | undefined;
const key = "synthetic-client-key-" + "k".repeat(24);
const restorers: Array<() => void> = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "qa-pool-admission-")); });
afterEach(async () => {
  if (pool) {
    // Tests of uncertain work inspect the durable fence before explicitly cleaning
    // their synthetic fixture. This does not authorize production release.
    const db = new Database(join(root, "pool.db"));
    if (db.query("SELECT name FROM sqlite_master WHERE name='qa_release_dispatches'").get()) {
      db.exec("UPDATE qa_release_dispatches SET state='terminal'; UPDATE sessions SET pending_history_turn=NULL");
      await pool.fetch(control("drain"));
    }
    db.close();
    pool.close(); pool = undefined;
  }
  for (const restore of restorers.splice(0).reverse()) restore();
  rmSync(root, { recursive: true, force: true });
});

function config(releaseControl = false): QaPoolConfig {
  const keyFile = join(root, "client.key"); writeFileSync(keyFile, key, { mode: 0o600 });
  return { host: "127.0.0.1", port: 0, databasePath: join(root, "pool.db"),
    clients: [{ id: "fixture", keyFile }],
    accounts: ["a", "b"].map(id => ({ id, origin: `http://127.0.0.1:${id === "a" ? 11001 : 11002}`, models: ["standard"] })),
    ...(releaseControl ? { releaseControl: { tokenFile: keyFile, stateFile: join(root, "fence.json") } } : {}),
  };
}
function request(thread = "thread", extra: Record<string, unknown> = {}): Request {
  return new Request("http://pool/v1/responses", { method: "POST", headers: { authorization: "Bearer " + key },
    body: JSON.stringify({ model: "standard", input: "Question", stream: true,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: thread, request_id: thread }) }, ...extra }) });
}
function control(operation: string): Request {
  return new Request("http://pool/admin/release/" + operation, { method: "POST", headers: { authorization: "Bearer " + key } });
}
function health(authorize: (id: string, hash: string) => Promise<(() => HostAssignmentAdmission | undefined) | undefined>) {
  const check = spyOn(QaHealthAdmission.prototype, "check").mockResolvedValue(true);
  const eligible = spyOn(QaHealthAdmission.prototype, "eligibleNow").mockReturnValue(true);
  const selected = spyOn(QaHealthAdmission.prototype, "authorizeSelected").mockImplementation((account, hash) => authorize(account.id, hash));
  restorers.push(() => check.mockRestore(), () => eligible.mockRestore(), () => selected.mockRestore());
  return selected;
}
function backend(response: () => Response) {
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: Parameters<typeof globalThis.fetch>[0], options?: Parameters<typeof globalThis.fetch>[1]) => {
    calls.push({ url: String(url), payload: JSON.parse(String(options?.body)) }); return response();
  }, { preconnect: globalThis.fetch.preconnect }));
  restorers.push(() => fetch.mockRestore());
  return calls;
}
function terminal(status: string, includeId = true): Response {
  const event = { type: "response." + status, response: { ...(includeId ? { id: "response-fixture" } : {}), status, output: [] } };
  return new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("a new session tries another eligible account after final admission fails", async () => {
  const attempts: string[] = [];
  health(async (id, hash) => { attempts.push(id); return id === "a" ? undefined : () => proof(id, hash); });
  const calls = backend(() => terminal("completed"));
  pool = createQaPool(config());
  const response = await pool.fetch(request());
  expect(response.status).toBe(200);
  const events = (await response.text()).split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.split("\ndata: ")[1]!));
  expect(attempts).toEqual(["a", "b"]);
  expect(calls.map(call => call.url)).toEqual(["http://127.0.0.1:11002/v1/responses"]);
  expect(events.filter(event => event.type === "response.provider_notice")).toHaveLength(1);
  expect(events[0].notice).toMatchObject({ kind: "account_pinned", evidence: "observed" });
  expect(JSON.stringify(calls[0]!.payload)).not.toContain("provider_notice");
  expect(events.at(-1).response).toEqual({ id: "response-fixture", status: "completed", output: [] });
  const second = await pool.fetch(request()); await second.text();
  expect(attempts).toEqual(["a", "b"]);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.url).toBe(calls[0]!.url);
});

test("all failed admissions leave a new session unowned and never dispatch", async () => {
  const attempts: string[] = [];
  health(async id => { attempts.push(id); return undefined; });
  const calls = backend(() => terminal("completed"));
  pool = createQaPool(config());
  expect((await pool.fetch(request())).status).toBe(503);
  expect(attempts).toEqual(["a", "b"]);
  expect(calls).toHaveLength(0);
  const db = new Database(join(root, "pool.db"));
  try { expect(db.query("SELECT * FROM sessions").all()).toHaveLength(0); } finally { db.close(); }
});

test("a concurrent owner wins while a candidate is awaiting final admission", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const attempts: string[] = [];
  health(async (id, hash) => {
    attempts.push(id);
    if (attempts.length === 1) {
      entered(); await new Promise<void>(resolve => { release = resolve; }); return undefined;
    }
    return () => proof(id, hash);
  });
  const calls = backend(() => terminal("completed"));
  pool = createQaPool(config());
  const first = pool.fetch(request());
  await waiting;
  try {
    const second = await pool.fetch(request()); expect(second.status).toBe(200); await second.text();
  } finally { release(); }
  const response = await first; expect(response.status).toBe(200); await response.text();
  expect(attempts).toEqual(["a", "a"]);
  expect(calls.map(call => call.url)).toEqual(["http://127.0.0.1:11001/v1/responses", "http://127.0.0.1:11001/v1/responses"]);
});

test("a delayed retry replays its original receipt after a later temporary turn", async () => {
  health(async (id, hash) => () => proof(id, hash));
  const calls = backend(() => terminal("completed"));
  const options = config(); options.accounts.forEach(account => { account.sessionModes = true; });
  pool = createQaPool(options);
  const turn = (id: string) => request("session", { input: "Question " + id, reasoning: { effort: "high-temporary" },
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "session", turn_id: id, request_id: id }) } });
  const original = await (await pool.fetch(turn("a"))).text();
  await (await pool.fetch(turn("b"))).text();
  const replay = await pool.fetch(turn("a"));
  expect(replay.status).toBe(200); expect(await replay.text()).toBe(original);
  expect(calls).toHaveLength(2);
});

test("a drain during final admission fences later candidates", async () => {
  const attempts: string[] = [];
  health(async id => { attempts.push(id); await pool!.fetch(control("drain")); return undefined; });
  const calls = backend(() => terminal("completed"));
  pool = createQaPool(config(true));
  const response = await pool.fetch(request());
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("pool_draining");
  expect(attempts).toEqual(["a"]);
  expect(calls).toHaveLength(0);
});

test("a dispatched rate limit stays on the original account", async () => {
  const attempts: string[] = [];
  health(async (id, hash) => { attempts.push(id); return () => proof(id, hash); });
  const calls = backend(() => Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 }));
  pool = createQaPool(config());
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await pool.fetch(request()); expect(response.status).toBe(429); await response.text();
  }
  expect(attempts).toEqual(["a"]);
  expect(calls.map(call => call.url)).toEqual(["http://127.0.0.1:11001/v1/responses", "http://127.0.0.1:11001/v1/responses"]);
});

for (const status of ["incomplete", "cancelled"]) {
  test(`a verified response.${status} terminal releases the dispatch drain fence`, async () => {
    health(async (id, hash) => () => proof(id, hash));
    backend(() => terminal(status));
    pool = createQaPool(config(true));
    expect(await (await pool.fetch(request())).text()).toContain(`"status":"${status}"`);
    const drained = await (await pool.fetch(control("drain"))).json();
    expect(drained).toMatchObject({ active_http: 0, active_dispatches: 0, pending_dispatches: 0, safe_to_stop: true });
  });
}

test("an incomplete temporary turn releases dispatch ownership but retains uncertain history", async () => {
  health(async (id, hash) => () => proof(id, hash));
  backend(() => terminal("incomplete"));
  const options = config(true); options.accounts.forEach(account => { account.sessionModes = true; });
  pool = createQaPool(options);
  await (await pool.fetch(request("temporary", { reasoning: { effort: "high-temporary" } }))).text();
  const drained = await (await pool.fetch(control("drain"))).json();
  expect(drained).toMatchObject({ active_dispatches: 0, pending_dispatches: 0, pending_history: 1, safe_to_stop: false });
});

test("an incomplete frame without a terminal response identity remains fenced", async () => {
  health(async (id, hash) => () => proof(id, hash));
  backend(() => terminal("incomplete", false));
  pool = createQaPool(config(true));
  await (await pool.fetch(request())).text();
  const drained = await (await pool.fetch(control("drain"))).json();
  expect(drained).toMatchObject({ active_dispatches: 0, pending_dispatches: 1, safe_to_stop: false });
});
