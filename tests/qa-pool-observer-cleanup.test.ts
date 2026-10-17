import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaPool, type QaPoolConfig } from "../src/qa-pool";

// Real pool and SQLite with a CPU-only controlled upstream. These tests prove
// observer-listener lifecycle at the pool boundary, not physical browser sends,
// TCP disconnect behavior, or the passage of the ten-minute wall-clock timeout.
const created = 'data: {"type":"response.created","response":{"id":"cleanup-response","status":"in_progress","output":[]}}\n\n';
const terminal = 'data: {"type":"response.completed","response":{"id":"cleanup-response","status":"completed","output":[]}}\n\n';
const payload = { model: "standard", stream: true, reasoning: { effort: "high-temporary" },
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "CLEANUP_CANARY" }] }],
  client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "cleanup-thread", turn_id: "cleanup-turn" }) } };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for pool cleanup"); await tick(); }
}

function fixture(alreadyAborted = false) {
  const root = mkdtempSync(join(tmpdir(), "qa-observer-cleanup-")), key = "c".repeat(32);
  writeFileSync(join(root, "key"), key);
  const config: QaPoolConfig = { host: "127.0.0.1", port: 0, databasePath: join(root, "pool.sqlite"),
    clients: [{ id: "cleanup-client", keyFile: join(root, "key") }],
    accounts: [{ id: "cleanup-account", origin: "http://127.0.0.1:9", models: ["standard"], sessionModes: true }] };
  const abort = new AbortController();
  if (alreadyAborted) abort.abort();
  const request = () => new Request("http://pool/v1/responses", { method: "POST", signal: abort.signal,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
  const incoming = request();
  // Observe the exact Request signal; Request may derive it from the controller.
  const add = spyOn(incoming.signal, "addEventListener"), remove = spyOn(incoming.signal, "removeEventListener");
  const originalFetch = globalThis.fetch, originalSetTimeout = globalThis.setTimeout;
  let fireTimeout: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 10 * 60 * 1000) fireTimeout = () => callback(...args);
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  let upstream!: ReadableStreamDefaultController<Uint8Array>, upstreamSignal: AbortSignal | null | undefined;
  let calls = 0, pulls = 0, cancellations = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++; upstreamSignal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; },
      pull() { pulls++; },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const pool = createQaPool(config);
  let open = true;
  const stop = () => { if (open) { open = false; pool.close(); } };
  return {
    abort, add, remove, start: () => pool.fetch(incoming), replay: () => pool.fetch(request()), stop,
    enqueue: (text: string) => upstream.enqueue(new TextEncoder().encode(text)),
    fail: () => upstream.error(new Error("injected upstream read failure")),
    timeout: () => { expect(fireTimeout).toBeDefined(); fireTimeout!(); },
    get calls() { return calls; }, get pulls() { return pulls; }, get cancellations() { return cancellations; },
    get upstreamAborted() { return upstreamSignal?.aborted; },
    completed: () => { const db = new Database(config.databasePath); try {
      return (db.query("SELECT state FROM qa_request_receipts").get() as { state: string } | null)?.state === "completed";
    } finally { db.close(); } },
    assertDetached: () => {
      const registered = add.mock.calls.filter(call => call[0] === "abort");
      expect(registered).toHaveLength(1);
      expect(remove.mock.calls.some(call => call[0] === "abort" && call[1] === registered[0]![1])).toBe(true);
    },
    close: () => { stop(); timer.mockRestore(); add.mockRestore(); remove.mockRestore(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); },
  };
}

for (const alreadyAborted of [false, true]) {
  test(`observer listener is removed after completion with ${alreadyAborted ? "an already-aborted" : "a live"} request signal`, async () => {
    const f = fixture(alreadyAborted);
    let response: Response | undefined;
    try {
      response = await f.start(); expect(response.status).toBe(200);
      f.enqueue(created + terminal);
      if (!alreadyAborted) expect(await response.text()).toBe(created + terminal);
      await until(f.completed);
      f.assertDetached(); expect(f.upstreamAborted).toBe(false);
      const replay = await f.replay(); expect(await replay.text()).toBe(created + terminal); expect(f.calls).toBe(1);
    } finally { await response?.body?.cancel().catch(() => {}); f.close(); }
  }, 3000);
}

test("abort wakes a parked observer, saves accepted work, and removes the listener", async () => {
  const f = fixture(); let response: Response | undefined;
  try {
    response = await f.start(); f.enqueue(created); await tick();
    expect(f.pulls).toBe(1); expect(f.remove.mock.calls).toHaveLength(0);
    f.abort.abort(); await until(() => f.pulls === 2);
    expect(f.upstreamAborted).toBe(false);
    f.enqueue(terminal); await until(f.completed);
    f.assertDetached(); expect(f.upstreamAborted).toBe(false);
    const replay = await f.replay(); expect(await replay.text()).toBe(created + terminal); expect(f.calls).toBe(1);
  } finally { await response?.body?.cancel().catch(() => {}); f.close(); }
}, 3000);

test("upstream read failure removes the observer listener and preserves uncertainty", async () => {
  const f = fixture();
  try {
    const response = await f.start(); f.fail();
    await expect(response.text()).rejects.toThrow("injected upstream read failure");
    f.assertDetached(); expect(f.completed()).toBe(false);
    const replay = await f.replay(); expect(replay.status).toBe(409); await replay.text(); expect(f.calls).toBe(1);
  } finally { f.close(); }
}, 3000);

for (const ending of ["timeout", "shutdown"] as const) {
  test(`${ending} removes a parked observer listener and cancels its upstream reader`, async () => {
    const f = fixture();
    try {
      const response = await f.start(); f.enqueue(created); await tick();
      expect(f.pulls).toBe(1); expect(f.remove.mock.calls).toHaveLength(0);
      if (ending === "timeout") f.timeout(); else f.stop();
      f.assertDetached(); expect(f.upstreamAborted).toBe(true);
      await expect(response.text()).rejects.toThrow("Observation ended");
      await until(() => f.cancellations === 1);
      if (ending === "timeout") {
        expect(f.completed()).toBe(false);
        const replay = await f.replay(); expect(replay.status).toBe(409); await replay.text(); expect(f.calls).toBe(1);
      }
    } finally { f.close(); }
  }, 3000);
}
