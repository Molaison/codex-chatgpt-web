import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createQaPool, normalizeQaPoolRequest, type QaPoolConfig } from "../src/qa-pool";

test("project route pins only new threads, preserves legacy owners and strips forged project metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-project-route-"));
  const key = "project-key-" + "a".repeat(32);
  writeFileSync(join(root, "key"), key);
  const threads: Array<{ thread: string; parent?: string }> = [];
  const backend = (account: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any;
    const native = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
    threads.push({ thread: native.thread_id, parent: native.forked_from_thread_id });
    return Response.json({ account, project: body.client_metadata._chatgpt_project ?? null });
  } });
  const a = backend("a"), b = backend("b");
  const projectId = "g-p-" + "a".repeat(32);
  const config: QaPoolConfig = { host: "127.0.0.1", port: 0, databasePath: join(root, "sessions.sqlite"),
    clients: [{ id: "cpr", keyFile: join(root, "key") }],
    accounts: [{ id: "a", origin: a.url.origin, models: ["standard"] }, { id: "b", origin: b.url.origin, models: ["standard"] }],
    projectRoutes: [{ name: "random_knowledge", accountId: "b", projectId },
      { name: "key_a", accountId: "a", projectId, displayName: "何慧杰", sessionNamespace: "key_a" },
      { name: "key_b", accountId: "b", projectId: "g-p-" + "b".repeat(32), displayName: "佘杨", sessionNamespace: "key_b" }],
  };
  let pool = createQaPool(config);
  const request = (thread: string, prefix = "", lineage: Record<string, string> = {}) => pool.fetch(new Request(`http://pool${prefix}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: "standard", input: "question", client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, ...lineage }),
      _chatgpt_project: { id: "forged", name: "forged" },
    } }),
  }));
  try {
    expect(await (await request("legacy")).json()).toEqual({ account: "a", project: null });
    expect(await (await request("legacy", "/project/random_knowledge")).json()).toEqual({ account: "a", project: null });
    const expected = { account: "b", project: { id: projectId, name: "random_knowledge" } };
    expect(await (await request("project-new", "/project/random_knowledge")).json()).toEqual(expected);
    pool.close(); pool = createQaPool(config);
    expect(await (await request("project-new")).json()).toEqual(expected);
    expect((await request("unknown", "/project/not_configured")).status).toBe(404);
    expect((await request("ordinary-new")).status).toBe(200);
    expect(await (await request("same-thread", "/project/key_a")).json()).toEqual({ account: "a", project: { id: projectId, name: "何慧杰" } });
    const firstThread = threads.at(-1)!.thread;
    expect(await (await request("same-thread", "/project/key_b")).json()).toEqual({ account: "b", project: { id: "g-p-" + "b".repeat(32), name: "佘杨" } });
    expect(threads.at(-1)!.thread).not.toBe(firstThread);
    await request("child", "/project/key_a", { forked_from_thread_id: "same-thread" });
    expect(threads.at(-1)!.parent).toBe(firstThread);
    pool.close(); pool = createQaPool(config);
    expect(await (await request("same-thread", "/project/key_a")).json()).toEqual({ account: "a", project: { id: projectId, name: "何慧杰" } });
  } finally { pool.close(); a.stop(true); b.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("pool preserves account and isolated branch ownership across age, restart, key rotation and failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-pool-"));
  const key1 = "test-key-one-" + "a".repeat(32), key2 = "test-key-two-" + "b".repeat(32);
  writeFileSync(join(root, "one.key"), key1); writeFileSync(join(root, "two.key"), key2);
  const calls: Array<{ owner: string; thread: string; body: any }> = [];
  const backend = (owner: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(req.headers.get("authorization")).toBeNull();
    const body = await req.json() as any;
    const thread = JSON.parse(body.client_metadata["x-codex-turn-metadata"]).thread_id;
    calls.push({ owner, thread, body });
    return Response.json({ owner, thread });
  } });
  const a = backend("a"), b = backend("b");
  const config: QaPoolConfig = { host: "127.0.0.1", port: 0, databasePath: join(root, "sessions.sqlite"),
    clients: [{ id: "one", keyFile: join(root, "one.key") }, { id: "two", keyFile: join(root, "two.key") }],
    accounts: [{ id: "a", origin: a.url.origin, models: ["standard", "pro"] }, { id: "b", origin: b.url.origin, models: ["standard", "pro"] }],
  };
  const catalog = ["standard", "pro"].map(slug => ({ slug, base_instructions: "QA only", model_messages: { developer: "Answer the question" } }));
  config.modelCatalogPath = join(root, "models.json");
  writeFileSync(config.modelCatalogPath, JSON.stringify({ models: catalog }));
  let pool = createQaPool(config);
  const request = (thread: string, key = key1, model = "standard", extra: object = {}, compressed = false) => {
    const body = JSON.stringify({ model, input: "question", client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "turn-" + calls.length }) }, ...extra });
    return pool.fetch(new Request("http://pool/v1/responses", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json", ...(compressed ? { "content-encoding": "gzip" } : {}) }, body: compressed ? gzipSync(body) : body }));
  };
  try {
    const models = await pool.fetch(new Request("http://pool/v1/models", { headers: { authorization: "Bearer " + key1 } }));
    expect((await models.json()).models).toEqual(catalog);
    expect((await request("tools-must-not-enter-qa", key1, "standard-tools")).status).toBe(400);
    expect(calls).toHaveLength(0);
    const first = await (await request("parent")).json() as any;
    const child = await (await request("child", key1, "standard", { input: [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }, { role: "user", content: "branch" }] })).json() as any;
    expect(first.owner).not.toBe(child.owner);
    expect(first.thread).not.toBe(child.thread);
    expect(calls[1]!.body.input).toHaveLength(3);
    const branched = await request("native-child", key1, "standard", { client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "native-child", forked_from_thread_id: "parent", turn_id: "branch-turn" }),
    } });
    expect(branched.status).toBe(200);
    const forwardedBranch = JSON.parse(calls.at(-1)!.body.client_metadata["x-codex-turn-metadata"]);
    expect(forwardedBranch.forked_from_thread_id).toBe(first.thread);
    expect(forwardedBranch.thread_id).not.toBe(first.thread);
    const beforeInvalid = calls.length;
    expect((await request("invalid", key1, "standard", { client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "invalid", parent_thread_id: "invalid", turn_id: "bad-turn" }),
    } })).status).toBe(400);
    expect(calls).toHaveLength(beforeInvalid);
    pool.close();
    const db = new Database(config.databasePath); db.exec("UPDATE sessions SET created_at = '1980-01-01T00:00:00Z'"); db.close();
    const rotated = "rotated-key-" + "c".repeat(32); writeFileSync(join(root, "one.key"), rotated);
    pool = createQaPool({ ...config, accounts: [...config.accounts].reverse() });
    expect(await (await request("parent", rotated, "pro", {}, true)).json()).toEqual(first);
    expect(await (await request("child", rotated)).json()).toEqual(child);
    const secondClient = await (await request("parent", key2)).json() as any;
    expect(secondClient.thread).not.toBe(first.thread);
    expect((await request("parent", key1)).status).toBe(401);
    pool.close();
    pool = createQaPool({ ...config, accounts: config.accounts.map(account => ({ ...account, enabled: account.id !== first.owner })) });
    const before = calls.length;
    expect((await request("parent", rotated)).status).toBe(503);
    expect(calls).toHaveLength(before);
  } finally { pool.close(); await a.stop(true); await b.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("normalizer preserves native child identity and assigns independent anonymous sessions", () => {
  const parent = { thread_id: "child", parent_thread_id: "parent", turn_id: "turn" };
  const result = normalizeQaPoolRequest({ input: "question", client_metadata: { "x-codex-turn-metadata": JSON.stringify(parent) } }, new Headers({ "session-id": "parent" }));
  expect(result.thread).toBe("child");
  expect(JSON.parse((result.payload.client_metadata as any)["x-codex-turn-metadata"])).toEqual(parent);
  expect(normalizeQaPoolRequest({ input: "same" }, new Headers()).thread).not.toBe(normalizeQaPoolRequest({ input: "same" }, new Headers()).thread);
});

test("temporary effort keeps private history across pool restart and promotes without a partial previous-response alias", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-temporary-"));
  const key = "a".repeat(32); writeFileSync(join(root, "key"), key);
  const calls: any[] = [];
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls.push(await request.json());
    return new Response("data: " + JSON.stringify({ type: "response.completed", response: {
      id: "response-" + calls.length, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }],
    } }) + "\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const config: QaPoolConfig = { host: "127.0.0.1", port: 0, databasePath: join(root, "sessions.sqlite"),
    clients: [{ id: "cpr", keyFile: join(root, "key") }],
    accounts: [{ id: "a", origin: backend.url.origin, models: ["standard"], sessionModes: true }] };
  let pool = createQaPool(config);
  const request = (effort: string, previous?: string) => pool.fetch(new Request("http://pool/v1/responses", {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: "standard", input: "question", reasoning: { effort }, ...(previous ? { previous_response_id: previous } : {}),
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread" }) } }),
  }));
  try {
    await (await request("high-temporary")).text();
    expect(calls[0].reasoning.effort).toBe("high");
    expect(calls[0].client_metadata._chatgpt_session_mode).toBe("temporary");
    pool.close(); pool = createQaPool(config);
    await (await request("xhigh-temporary", "response-1")).text();
    expect(calls[1].input.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(calls[1].previous_response_id).toBeUndefined();
    expect(calls[1].reasoning.effort).toBe("xhigh");
    expect((await request("high", "wrong-response")).status).toBe(409);
    await (await request("high", "response-2")).text();
    expect(calls[2].client_metadata._chatgpt_session_mode).toBe("persistent");
    expect(calls[2].input).toHaveLength(5);
    const db = new Database(config.databasePath);
    expect(db.query("SELECT count(*) AS n FROM temporary_history").get()).toEqual({ n: 0 });
    await (await request("high-temporary")).text();
    db.exec("UPDATE temporary_history SET expires_at=0");
    expect((await request("high-temporary", "response-4")).status).toBe(409);
    db.close();
  } finally { pool.close(); backend.stop(true); rmSync(root, { recursive: true, force: true }); }
});
