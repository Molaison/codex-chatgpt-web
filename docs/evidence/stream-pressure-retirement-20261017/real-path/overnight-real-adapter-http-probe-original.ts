import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mode = process.argv[2];
assert.ok(mode === "json" || mode === "sse", "mode must be json or sse");
const stream = mode === "sse";
const output = process.argv[3];
assert.ok(output, "evidence path required");
const root = mkdtempSync(join(tmpdir(), "overnight-real-http-"));
const oldHome = process.env.CODEX_CHATGPT_WEB_HOME;
process.env.CODEX_CHATGPT_WEB_HOME = root;
const signals = new Map<string, ReadonlySet<unknown>>((["SIGINT", "SIGTERM"] as const).map(s => [s, new Set<unknown>(process.listeners(s))]));
const { defaultConfig, providerConfig } = await import("./src/config");
const { startServer } = await import("./src/server");
const { createChatGptWebAdapter } = await import("./src/adapters/chatgpt-web");
const { ChatGptBrowserWorker } = await import("./src/adapters/chatgpt-web/browser-worker");
const { chatGptTurnSessions } = await import("./src/adapters/chatgpt-web/turn-execution");
const { TurnBroker } = await import("./src/adapters/chatgpt-web/turn-broker");
const { flushResponseState } = await import("./src/responses/state");
const config = { ...defaultConfig("browser-only"), port: 0, useSavedChats: false,
  accountId: "offline-" + randomUUID(), brokerSocketPath: join(root, "broker.sock"),
  conversationStoreDirectory: join(root, "conversations") };
const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
const originalRun = worker.run;
let browserSignal: AbortSignal | undefined;
let runtime: ReturnType<typeof startServer> | undefined;
const observations: any = { mode, platform: process.platform, bun: Bun.version, revision: Bun.revision,
  physicalModelSubmissions: 0, inputDeltas: 10001, bytesPerDelta: 1,
  workerStarts: 0, sendActivated: 0, submitted: 0, adapterCalls: 0, upstreamCalls: 0,
  responseHttpRequests: 0, healthHttpRequests: 0, portChecks: 0, health: [], attempts: [], phases: [],
  unhandledRejections: [] };
const persist = () => writeFileSync(output, JSON.stringify(observations, null, 2) + "\n");
const phase = (name: string) => { observations.phases.push({ name, at: Date.now(), rss: process.memoryUsage().rss }); persist(); console.log("HTTP_PROBE_PHASE " + JSON.stringify({ mode, name })); };
const unhandled = (error: unknown) => { observations.unhandledRejections.push(String(error)); persist(); };
process.on("unhandledRejection", unhandled);
worker.run = async turn => {
  observations.workerStarts++; browserSignal = turn.abortSignal;
  const prepared = await turn.prepare(); prepared.release();
  assert.ok(turn.onSendActivated && turn.onSubmitted, "real adapter lifecycle hooks required");
  await turn.onSendActivated(); observations.sendActivated++;
  await turn.onSubmitted(); observations.submitted++;
  for (let n = 0; n < 10001; n++) turn.onTextDelta("x");
  return "x".repeat(10001);
};
let base = "";
const health = async (stage: string) => {
  observations.healthHttpRequests++;
  const response = await fetch(base + "/healthz");
  assert.equal(response.status, 200);
  const h = await response.json() as any;
  observations.health.push({ stage, activeHttp: h.active_http_turns, activeBrowser: h.active_browser_turns, pid: h.pid });
  return h;
};
try {
  phase("starting");
  runtime = startServer(config, {
    fetchUpstream: async () => { observations.upstreamCalls++; throw new Error("offline probe forbids upstream"); },
    adapterFactory(provider) {
      assert.equal(ChatGptBrowserWorker.forProvider(provider), worker, "production provider must select the replaced worker");
      observations.adapterCalls++;
      return createChatGptWebAdapter(provider);
    },
  });
  base = `http://127.0.0.1:${runtime.port}`;
  observations.port = runtime.port;
  await health("before"); phase("healthy");
  const id = randomUUID();
  const body = { model: "chatgpt-web/gpt-5.6-sol-instant", stream,
    input: [{ type: "message", role: "user", id: "pressure-user", content: "controlled browser feed" }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread-${id}`, turn_id: `turn-${id}` }) } };
  for (const attempt of ["feed", "exact-replay"]) {
    phase(attempt + "-start"); observations.responseHttpRequests++;
    const response = await fetch(base + "/v1/responses", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const wire = await response.text();
    const frames = stream ? wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))) : [];
    const terminals = stream ? frames.filter(event => ["response.completed", "response.failed", "response.incomplete"].includes(event.type)) : [];
    const result = stream ? terminals[0]?.response : JSON.parse(wire);
    const summary: any = { attempt, httpStatus: response.status, wireBytes: Buffer.byteLength(wire),
      terminalCount: stream ? terminals.length : 1, status: result?.status, error: result?.error,
      retryable: result?.retryable, doneCount: stream ? wire.split("data: [DONE]").length - 1 : null };
    observations.attempts.push(summary);
    assert.equal(summary.terminalCount, 1);
    if (stream) assert.equal(summary.doneCount, 1);
    if (attempt === "feed") {
      assert.equal(response.status, 200); assert.equal(result.status, "completed");
      const text = result.output[0].content[0].text;
      summary.textBytes = Buffer.byteLength(text);
      summary.textSha256 = createHash("sha256").update(text).digest("hex");
      summary.expectedSha256 = createHash("sha256").update("x".repeat(10001)).digest("hex");
      assert.equal(text.length, 10001); assert.equal(summary.textSha256, summary.expectedSha256);
    } else {
      assert.equal(response.status, stream ? 200 : 502); assert.equal(result.status, "failed");
      assert.equal(result.error.code, "adapter_event_backlog_exceeded"); assert.equal(result.retryable, false);
    }
    await health("after-" + attempt); phase(attempt + "-finished");
  }
  observations.ownerAbortedBeforeCleanup = browserSignal?.aborted;
  assert.equal(observations.workerStarts, 1); assert.equal(observations.sendActivated, 1); assert.equal(observations.submitted, 1);
  assert.equal(observations.adapterCalls, 2); assert.equal(observations.upstreamCalls, 0);
  assert.equal(browserSignal?.aborted, false); assert.deepEqual(observations.unhandledRejections, []);
  observations.passed = true;
} catch (error) { observations.error = String(error); observations.passed = false; process.exitCode = 1; }
finally {
  phase("cleanup-start");
  try {
    worker.run = originalRun;
    chatGptTurnSessions.clear(); await chatGptTurnSessions.waitForPhysicalSettlement();
    await TurnBroker.forSocket(config.brokerSocketPath).close(); flushResponseState();
    if (runtime) {
      const h = await health("after-cleanup-before-stop");
      assert.equal(h.active_http_turns, 0); assert.equal(h.active_browser_turns, 0);
      await runtime.stop(true);
      observations.portChecks++;
      try { await fetch(base + "/healthz", { signal: AbortSignal.timeout(500) }); observations.portClosed = false; }
      catch (error) { observations.portClosed = true; observations.portCloseError = (error as any)?.code ?? String(error); }
      assert.equal(observations.portClosed, true);
    }
    observations.cleaned = true;
  } catch (error) { observations.cleanupError = String(error); process.exitCode = 1; }
  for (const signal of ["SIGINT", "SIGTERM"] as const) for (const listener of process.listeners(signal))
    if (!signals.get(signal)!.has(listener)) process.removeListener(signal, listener);
  process.removeListener("unhandledRejection", unhandled);
  if (oldHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
  phase("finished"); console.log("REAL_ADAPTER_HTTP " + JSON.stringify(observations));
}
