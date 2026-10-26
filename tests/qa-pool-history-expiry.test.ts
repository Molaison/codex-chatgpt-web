import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaPool, type QaPoolConfig } from "../src/qa-pool";
import { installReadyQaHealthFixture } from "./qa-pool-health-fixture";

installReadyQaHealthFixture();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qa-history-expiry-"));
  const key = "a".repeat(32);
  writeFileSync(join(root, "key"), key);
  const config: QaPoolConfig = {
    host: "127.0.0.1", port: 0, databasePath: join(root, "sessions.sqlite"),
    clients: [{ id: "test", keyFile: join(root, "key") }],
    accounts: [{ id: "a", origin: "http://127.0.0.1:9", models: ["standard"], sessionModes: true }],
  };
  const calls: any[] = [];
  const originalFetch = globalThis.fetch;
  let reply = () => Response.json({ id: "response-" + calls.length, status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ORCHID" }] }] });
  globalThis.fetch = (async (_url, init) => {
    calls.push(JSON.parse(init!.body as string));
    return reply();
  }) as typeof fetch;
  let pool = createQaPool(config);
  const sql = (query: string) => { const db = new Database(config.databasePath); try { db.exec(query); } finally { db.close(); } };
  return {
    calls, sql, config,
    respond: (next: typeof reply) => { reply = next; },
    restart: () => { pool.close(); pool = createQaPool(config); },
    request: (thread = "thread", effort = "high-temporary", extra: object = {}) => pool.fetch(new Request("http://pool/v1/responses", {
      method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ model: "standard", input: "Remember ORCHID", reasoning: { effort },
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread }) }, ...extra }),
    })),
    close: () => { pool.close(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); },
  };
}

async function expectExpired(response: Response) {
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("temporary_history_expired");
}

for (const expiry of ["request", "restart", "purged"] as const) {
  test(`temporary history fails closed after ${expiry} expiry, retries and restart`, async () => {
    const f = fixture();
    try {
      expect((await f.request()).status).toBe(200);
      f.sql("UPDATE temporary_history SET expires_at=0");
      if (expiry === "restart") f.restart();
      if (expiry === "purged") f.sql("DELETE FROM temporary_history WHERE expires_at<=0");
      await expectExpired(await f.request());
      await expectExpired(await f.request());
      await expectExpired(await f.request("thread", "high"));
      f.restart();
      await expectExpired(await f.request());
      expect(f.calls).toHaveLength(1);
      expect((await f.request("fresh", "high-temporary", { input: [
        { role: "user", content: "Remember ORCHID" }, { role: "assistant", content: "ORCHID" },
        { role: "user", content: "What was the marker?" },
      ] })).status).toBe(200);
      expect(f.calls.at(-1).input).toHaveLength(3);
      const db = new Database(f.config.databasePath);
      try { expect(db.query("SELECT COUNT(*) AS n FROM temporary_history WHERE expires_at<=0").get()).toEqual({ n: 0 }); }
      finally { db.close(); }
    } finally { f.close(); }
  });
}

test("legacy retained history migrates before startup expiry purge", async () => {
  const f = fixture();
  try {
    await f.request();
    const db = new Database(f.config.databasePath);
    try {
      if ((db.query("PRAGMA table_info(sessions)").all() as any[]).some(column => column.name === "temporary_history_expected")) {
        db.exec("ALTER TABLE sessions DROP COLUMN temporary_history_expected");
      }
      db.exec("UPDATE temporary_history SET expires_at=0");
    } finally { db.close(); }
    f.restart();
    await expectExpired(await f.request());
    f.restart();
    await expectExpired(await f.request());
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test("unexpired history survives restart and successful promotion clears its expectation", async () => {
  const f = fixture();
  try {
    await f.request(); f.restart();
    expect((await f.request("thread", "high", { previous_response_id: "wrong" })).status).toBe(409);
    expect(f.calls).toHaveLength(1);
    expect((await f.request("thread", "high", { previous_response_id: "response-1" })).status).toBe(200);
    expect(f.calls[1].input.map((item: any) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(f.calls[1].previous_response_id).toBeUndefined();
    f.restart();
    expect((await f.request("thread", "high")).status).toBe(200);
    expect(f.calls[2].input).toHaveLength(1);
    expect((await f.request()).status).toBe(200);
    f.sql("UPDATE temporary_history SET expires_at=0");
    f.restart();
    await expectExpired(await f.request());
  } finally { f.close(); }
});

for (const failed of ["http", "incomplete", "stream"] as const) {
  test(`failed ${failed} promotion preserves history expectation`, async () => {
    const f = fixture();
    try {
      await f.request();
      f.respond(() => failed === "http" ? Response.json({ error: "unavailable" }, { status: 503 })
        : failed === "incomplete" ? Response.json({ id: "failed", status: "incomplete", output: [] })
        : new Response('data: {"type":"response.failed","response":{"id":"failed","status":"failed","output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } }));
      await (await f.request("thread", "high")).text();
      f.sql("UPDATE temporary_history SET expires_at=0"); f.restart();
      await expectExpired(await f.request("thread", "high"));
      expect(f.calls).toHaveLength(2);
    } finally { f.close(); }
  });
}

test("completed streamed promotion clears history expectation across restart", async () => {
  const f = fixture();
  try {
    await f.request();
    f.respond(() => new Response('data: {"type":"response.completed","response":{"id":"promoted","status":"completed","output":[]}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    }));
    expect((await (await f.request("thread", "high")).text())).toContain("response.completed");
    f.restart();
    expect((await f.request("thread", "high")).status).toBe(200);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2].input).toHaveLength(1);
  } finally { f.close(); }
});

test("failed temporary history commit preserves a durable uncertain-turn barrier", async () => {
  const f = fixture();
  try {
    f.sql("CREATE TRIGGER reject_history BEFORE INSERT ON temporary_history BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
    expect((await f.request()).status).toBe(502);
    const db = new Database(f.config.databasePath);
    try {
      expect(db.query("SELECT temporary_history_expected FROM sessions").get()).toEqual({ temporary_history_expected: 0 });
      expect(db.query("SELECT COUNT(*) AS n FROM temporary_history").get()).toEqual({ n: 0 });
    } finally { db.close(); }
    f.sql("DROP TRIGGER reject_history");
    f.restart();
    const retry = await f.request();
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.code).toBe("temporary_turn_uncertain");
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});
