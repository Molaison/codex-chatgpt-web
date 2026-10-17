// Task-owned fixture. No production edits; execution requires the separate, reviewed supervisor.
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

assert.equal(process.argv[2], "--execute-reviewed-suite", "Do not execute before parent review");
const prefix = resolve(process.argv[3] ?? "");
assert.match(prefix, /\/overnight-cli-completion-cb12-[1-9][0-9]*$/);
const phaseName = process.argv[4] ?? "all";
assert.ok(["all", "exec-resume", "reconnect", "interrupt-peer", "cleanup"].includes(phaseName));
const ledgerPath = join(dirname(prefix), "overnight-cli-completion-cb12-ledger.json");
// The supervisor creates one shared stage ledger before launch. Never silently reset it.
const ledger: any = JSON.parse(readFileSync(ledgerPath, "utf8"));
const ledgerRun = ledger.runs.find((run: any) => run.prefix === prefix);
assert.ok(ledgerRun && ledgerRun.status === "launched");
function saveLedger() {
  const temporary = ledgerPath + `.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(ledger, null, 2) + "\n"); renameSync(temporary, ledgerPath);
}
const codex = "<YWL_HOME>/.local/lib/codex-official-v0.162.0/bin/codex";
const model = "chatgpt-web/gpt-5.6-luna";
const root = prefix + "-data";
assert.ok(!existsSync(root), "Never reuse an old home or overwrite prior evidence");
const home = join(root, "codex-home"), appHome = join(root, "app-home");
const cwd = join(root, "workspace"), temp = join(root, "tmp");
for (const path of [root, home, appHome, cwd, temp]) mkdirSync(path, { recursive: true });
// Set all homes before importing production code. Do not read or inherit user credentials.
process.env.CODEX_HOME = home;
process.env.CODEX_SQLITE_HOME = home;
process.env.CODEX_CHATGPT_WEB_HOME = appHome;
const { defaultConfig, providerConfig, saveConfig } = await import("./src/config");
const { startServer } = await import("./src/server");
const { createChatGptWebAdapter } = await import("./src/adapters/chatgpt-web");
const { ChatGptBrowserWorker, closeChatGptBrowserWorkers } = await import("./src/adapters/chatgpt-web/browser-worker");
const { chatGptTurnSessions } = await import("./src/adapters/chatgpt-web/turn-execution");
const { extractCodexTurnIdentityFromBody } = await import("./src/adapters/chatgpt-web/environment");
const { requireChatGptWebModelRoute } = await import("./src/chatgpt-web-models");
const { installCodexInterruptHook, verifyCodexInterruptHook } = await import("./src/codex-interrupt-hook");
const { TurnBroker } = await import("./src/adapters/chatgpt-web/turn-broker");
const { flushResponseState } = await import("./src/responses/state");

const limits = { logicalTurns: 30, responsesHttp: 40, perLogicalMs: 45_000, suiteMs: 900_000,
  proxyRssBytes: 512 * 1024 ** 2, treeRssBytes: 2 * 1024 ** 3, diskBytes: 2 * 1024 ** 3 };
const observations: any = { startedAt: new Date().toISOString(), phaseName, ledgerPath,
  fixture: "native Codex custom loopback provider + production adapter; only worker.run substituted",
  model, physicalModelSubmissions: 0, upstreamCalls: 0, logicalTurns: 0, responsesHttp: 0,
  spawnedNativeProcesses: 0, limits, phases: [], requests: [], workers: [], cases: [], health: [],
  unhandledRejections: [], cleanup: {}, failure: null, completed: false };
const persist = () => writeFileSync(prefix + "-result.json", JSON.stringify(observations, null, 2) + "\n");
const record = (event: any) => {
  const item = { at: new Date().toISOString(), ...event };
  observations.phases.push(item); persist(); console.log(JSON.stringify(item));
};
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const children = new Set<ChildProcess>();
const childRecords: any[] = [];
let fatal: Error | undefined;
let lastLogicalDeadline = 0;
const fail = (error: unknown) => {
  fatal ??= error instanceof Error ? error : new Error(String(error));
  for (const child of children) killChild(child);
};
process.on("unhandledRejection", error => { observations.unhandledRejections.push(String(error)); fail(error); persist(); });
const checked = () => { if (fatal) throw fatal; assert.ok(Date.now() - Date.parse(observations.startedAt) < limits.suiteMs); };
function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid!, signal); } catch {}
  try { child.kill(signal); } catch {}
}
async function deadline<T>(name: string, operation: () => Promise<T>): Promise<T> {
  checked(); let timer: ReturnType<typeof setTimeout> | undefined;
  const beginning = Date.now();
  lastLogicalDeadline = beginning + limits.perLogicalMs;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { fail(new Error(name + " exceeded 45s; stop, no retry"));
        for (const child of children) killChild(child); reject(fatal); }, limits.perLogicalMs);
    })]);
  } finally { clearTimeout(timer); record({ event: "logical_window", name, elapsedMs: Date.now() - beginning }); }
}
type State = { name: string; marker: string; answer: string; kind: "normal" | "resume" | "reconnect" | "interrupt" | "peer";
  starts: number; sends: number; submitted: number; attempts: number; cuts: number; done: boolean; aborted: boolean;
  release: () => void; hold: Promise<void>; requestIds: any[]; signal?: AbortSignal; workerTrace?: string };
const states: State[] = [];
function newState(name: string, kind: State["kind"] = "normal"): State {
  checked();
  assert.ok(!ledger.turns.some((turn: any) => turn.name === name), "never repeat a passed/failed/aborted logical turn automatically");
  assert.ok(ledger.logicalTurns < limits.logicalTurns);
  ledger.logicalTurns++; ledger.turns.push({ name, kind, prefix, status: "started", at: new Date().toISOString() }); saveLedger();
  observations.logicalTurns++;
  let release!: () => void; const hold = new Promise<void>(r => { release = r; });
  const state: State = { name, kind, marker: `OVERNIGHT_INPUT_${name}_${randomUUID().replaceAll("-", "")}`,
    answer: `OVERNIGHT_ANSWER_${name}_${randomUUID().replaceAll("-", "")}`, starts: 0, sends: 0, submitted: 0,
    attempts: 0, cuts: 0, done: false, aborted: false, release, hold, requestIds: [] };
  states.push(state); return state;
}
const config = { ...defaultConfig("browser-only"), port: 0, subagentProtocol: "native" as const,
  solAvailable: false, proAvailable: false, extraHighAvailable: false, zeroRiskProEnabled: false,
  experimentalBiggerContext: false, composerPredictionsEnabled: false, useSavedChats: false,
  standardConcurrencyLimit: 2, accountId: "controlled-cli-" + randomUUID(),
  brokerSocketPath: join(appHome, "broker.sock"), conversationStoreDirectory: join(appHome, "conversations"),
  runtimeCommand: [process.execPath, resolve("src/cli.ts")] };
const route = requireChatGptWebModelRoute(model, config, "low");
assert.equal(route.backendModel, "gpt-5.6-luna"); assert.equal(route.requiresPro, false);
const provider = providerConfig(config);
assert.equal(provider.chatgptWeb?.solAvailable, false); assert.equal(provider.chatgptWeb?.proAvailable, false);
assert.equal(provider.chatgptWeb?.localToolsEnabled, false);
observations.route = { model, backendModel: route.backendModel, requiresPro: route.requiresPro,
  solAvailable: false, proAvailable: false, localToolsEnabled: false, fallback: "none; unknown routes rejected" };
const worker = ChatGptBrowserWorker.forProvider(provider), originalRun = worker.run;
let activeStubWorkers = 0;
worker.run = async turn => {
  assert.equal(turn.modelId, "gpt-5.6-luna"); assert.notEqual(turn.proModel, true);
  const prepared = await turn.prepare();
  const matches = states.filter(s => prepared.text.includes(s.marker));
  const state = matches.sort((a, b) => prepared.text.lastIndexOf(b.marker) - prepared.text.lastIndexOf(a.marker))[0];
  assert.ok(state, "worker input must contain this suite's unique current prompt");
  assert.equal(state.starts++, 0, "no duplicate physical worker for a logical turn");
  activeStubWorkers++;
  const allowedPeak = ["interrupt", "peer"].includes(state.kind) ? 2 : 1;
  assert.ok(activeStubWorkers <= allowedPeak, "only target/peer may overlap stub owners");
  observations.stubWorkerPeak = Math.max(observations.stubWorkerPeak ?? 0, activeStubWorkers);
  state.signal = turn.abortSignal; state.workerTrace = turn.traceId;
  prepared.release();
  const row: any = { name: state.name, traceId: turn.traceId, startedAt: new Date().toISOString(),
    model: turn.modelId, starts: state.starts, aborted: false, settled: false, activeStubWorkers,
    compiledContextHasOldCanary: oldCanary ? prepared.text.includes(oldCanary) : false,
    compiledContextSha256: hash(prepared.text) };
  if (state.kind === "resume") assert.equal(row.compiledContextHasOldCanary, true,
    "production compiled resume context must contain the old answer; do not refill the prompt");
  observations.workers.push(row); record({ event: "worker_started", name: state.name });
  const onAbort = () => { state.aborted = true; row.aborted = true; record({ event: "worker_aborted", name: state.name }); };
  turn.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    assert.ok(turn.onSendActivated && turn.onSubmitted);
    await turn.onSendActivated(); state.sends++;
    await turn.onSubmitted(); state.submitted++;
    record({ event: "worker_accepted", name: state.name, sends: state.sends, submitted: state.submitted });
    turn.onTextDelta(state.answer);
    if (["reconnect", "interrupt", "peer"].includes(state.kind)) {
      await Promise.race([state.hold, new Promise<never>((_, reject) => {
        if (turn.abortSignal?.aborted) reject(turn.abortSignal.reason);
        else turn.abortSignal?.addEventListener("abort", () => reject(turn.abortSignal!.reason), { once: true });
      })]);
    }
    assert.equal(turn.abortSignal?.aborted, false, "completed worker owner must not be aborted");
    return state.answer;
  } finally {
    activeStubWorkers--;
    state.done = true; row.settled = true; row.settledAt = new Date().toISOString();
    turn.abortSignal?.removeEventListener("abort", onAbort); persist();
  }
};
let runtime: ReturnType<typeof startServer> | undefined;
let runtimePort = 0, proxyPort = 0;
const proxySockets = new Set<any>();
const proxy = createServer();
proxy.on("connection", socket => { proxySockets.add(socket); socket.on("close", () => proxySockets.delete(socket)); });
const requestsInFlight = new Set<AbortController>();
let nativeClient: RpcClient | undefined;
let oldCanary = "", oldThread = "";
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: home, USER: "fixture", LANG: "C.UTF-8",
  TMPDIR: temp, CODEX_HOME: home, CODEX_SQLITE_HOME: home, CODEX_CHATGPT_WEB_HOME: appHome,
  OVERNIGHT_LOCAL_FIXTURE_KEY: "dummy-loopback-only", DO_NOT_TRACK: "1" };
function spawnNative(name: string, args: string[]) {
  checked(); assert.equal(children.size, 0, "one live native CLI process; two app-server threads are allowed");
  observations.spawnedNativeProcesses++;
  const child = spawn(codex, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const row = { name, pid: child.pid, args, startedAt: new Date().toISOString(), exit: null as number | null, signal: null as any };
  childRecords.push(row); children.add(child); persist();
  child.on("exit", (code, signal) => { row.exit = code; row.signal = signal; children.delete(child); persist(); });
  return child;
}
function exitPromise(child: ChildProcess): Promise<number | null> {
  return new Promise((res, rej) => { child.once("error", rej); child.once("close", res); });
}
const common = ["--skip-git-repo-check", "--json", "--sandbox", "read-only", "-m", model,
  "-c", 'model_reasoning_effort="low"', "--disable", "apps"];
async function execCase(state: State, resume = false) {
  return deadline(state.name, async () => {
    const prompt = `${state.marker}. Return only the controlled canary. Do not use tools.`;
    const args = resume ? ["exec", "resume", "--skip-git-repo-check", "--json", "-m", model,
      "-c", 'model_reasoning_effort="low"', "--disable", "apps", oldThread, prompt] : ["exec", ...common, prompt];
    const child = spawnNative(state.name, args); child.stdin!.end();
    const exited = exitPromise(child); let stdout = "", stderr = "";
    child.stdout!.on("data", x => { stdout += x; if (stdout.length > 8 * 1024 ** 2) { fail(Error("CLI stdout limit")); killChild(child); } });
    child.stderr!.on("data", x => { stderr += x; if (stderr.length > 8 * 1024 ** 2) { fail(Error("CLI stderr limit")); killChild(child); } });
    const code = await exited;
    writeFileSync(prefix + `-${state.name}.jsonl`, stdout); writeFileSync(prefix + `-${state.name}.stderr`, stderr);
    const events = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const answers = events.filter(e => e.type === "item.completed" && e.item?.type === "agent_message").map(e => e.item.text);
    const thread = events.find(e => e.type === "thread.started")?.thread_id;
    const result = { name: state.name, exit: code, thread, expectedSha256: hash(state.answer), answersSha256: answers.map(hash),
      terminalCompleted: events.filter(e => e.type === "turn.completed").length,
      failures: events.filter(e => ["error", "turn.failed"].includes(e.type)), attempts: state.attempts,
      starts: state.starts, sends: state.sends, submitted: state.submitted, ownerAborted: state.aborted,
      nativeReconnectEvidence: state.kind === "reconnect" ? { faultKind: "accepted_partial_sse_eof",
        httpAttempts: state.attempts, stableIdentity: state.requestIds.every(id => JSON.stringify(id) === JSON.stringify(state.requestIds[0])),
        nativeStreamMessages: events.filter(e => e.type === "error"), completionReceived: events.some(e => e.type === "turn.completed") } : null };
    observations.cases.push(result); persist();
    assert.equal(code, 0); assert.deepEqual(answers, [state.answer]); assert.equal(result.terminalCompleted, 1);
    // Reconnect progress may be emitted as an informational error event by the native CLI.
    assert.equal(result.failures.filter((e: any) => e.type === "turn.failed").length, 0);
    assert.equal(state.starts, 1); assert.equal(state.sends, 1); assert.equal(state.submitted, 1); assert.equal(state.aborted, false);
    assert.equal(state.attempts, state.kind === "reconnect" ? 3 : 1);
    assert.ok(typeof thread === "string");
    if (resume) assert.equal(thread, oldThread);
    const ledgerTurn = ledger.turns.find((turn: any) => turn.name === state.name);
    ledgerTurn.status = "passed"; ledgerTurn.httpAttempts = state.attempts; saveLedger();
    return { thread, result };
  });
}
async function health(stage: string) {
  const response = await fetch(`http://127.0.0.1:${runtimePort}/healthz`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200); const value: any = await response.json();
  const row = { stage, at: new Date().toISOString(), http: value.active_http_turns, browser: value.active_browser_turns,
    rss: process.memoryUsage().rss, nativeChildren: children.size };
  observations.health.push(row); persist(); return row;
}
async function poll(name: string, predicate: () => boolean | Promise<boolean>, maxMs = 5000) {
  const until = Date.now() + maxMs;
  while (!await predicate()) { checked(); assert.ok(Date.now() < until, name + " deadline"); await Bun.sleep(10); }
}
async function idle(stage: string) {
  await poll(stage, async () => { const h = await health(stage); return h.http === 0 && h.browser === 0; });
}
async function clearCase(stage: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => {
      chatGptTurnSessions.clear(); await chatGptTurnSessions.waitForPhysicalSettlement();
      await flushResponseState(); await idle(stage); assert.equal(children.size, 0);
      record({ event: "lifecycle_cleanup", stage, active: chatGptTurnSessions.activeCount(), nativeChildren: children.size });
    })(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { fail(Error(stage + " cleanup exceeded the same logical 45s window")); reject(fatal); },
        Math.max(1, lastLogicalDeadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}
function currentState(body: any) {
  const raw = JSON.stringify(body.input ?? []);
  const found = states.filter(s => raw.includes(s.marker)).sort((a, b) => raw.lastIndexOf(b.marker) - raw.lastIndexOf(a.marker))[0];
  assert.ok(found, "unknown fixture input rejected"); return found;
}
proxy.on("request", async (request, response) => {
  let controller: AbortController | undefined;
  try {
    // Count every physical Responses arrival, including one rejected after another failure.
    if (request.method === "POST" && request.url === "/v1/responses") {
      ledger.responsesHttp++; observations.responsesHttp++; saveLedger();
      assert.ok(ledger.responsesHttp <= limits.responsesHttp);
    }
    checked();
    assert.equal(request.method, "POST", "only Responses POST is allowed; local catalog prevents model fetching");
    assert.equal(request.url, "/v1/responses");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 8 * 1024 ** 2); chunks.push(Buffer.from(chunk)); }
    const wire = Buffer.concat(chunks), encoding = request.headers["content-encoding"];
    assert.ok(!encoding || encoding === "zstd" || encoding === "gzip");
    const decoded = encoding === "zstd" ? zstdDecompressSync(wire) : encoding === "gzip" ? gunzipSync(wire) : wire;
    const body = JSON.parse(decoded.toString("utf8")); assert.equal(body.model, model); assert.equal(body.stream, true);
    const state = currentState(body); state.attempts++;
    const identity = extractCodexTurnIdentityFromBody(body); assert.ok(identity.threadId && identity.turnId);
    if (state.attempts === 1) for (const other of states) if (other !== state) {
      assert.ok(other.requestIds.every(prior => prior.turnId !== identity.turnId), "new logical turns need unique native turn identity");
    }
    state.requestIds.push(identity);
    const historyHasCanary = oldCanary ? JSON.stringify(body.input).includes(oldCanary) : false;
    const row: any = { n: observations.responsesHttp, name: state.name, attempt: state.attempts, identity,
      bodySha256: hash(decoded), inputSha256: hash(JSON.stringify(body.input)), inputBytes: Buffer.byteLength(JSON.stringify(body.input)),
      historyHasCanary, previousResponseId: body.previous_response_id ?? null,
      model: body.model, encoding: encoding ?? null, cut: false, terminalEvents: [] };
    observations.requests.push(row); persist();
    if (state.kind === "resume") assert.ok(historyHasCanary || typeof body.previous_response_id === "string",
      "resume must carry old canary in input or a real history alias; prepare verifies expanded content");
    if (state.kind === "reconnect") {
      assert.ok(state.attempts <= 3); assert.deepEqual(identity, state.requestIds[0], "native retry identity must remain stable");
    } else assert.equal(state.attempts, 1, "no unexpected retry");
    controller = new AbortController(); requestsInFlight.add(controller);
    response.on("close", () => controller?.abort(new DOMException("isolated client connection closed", "AbortError")));
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string" && !["host", "connection", "content-length"].includes(key)) headers.set(key, value);
    const upstream = await fetch(`http://127.0.0.1:${runtimePort}/v1/responses`, { method: "POST", headers, body: wire, signal: controller.signal });
    row.httpStatus = upstream.status;
    const injectPartialEof = state.kind === "reconnect" && state.attempts <= 2;
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache",
      ...(injectPartialEof ? { connection: "close" } : {}) });
    const reader = upstream.body!.getReader(), decoder = new TextDecoder(); let pending = "", sawDelta = false;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const text = decoder.decode(next.value, { stream: true }); pending += text;
        for (let index; (index = pending.indexOf("\n")) >= 0;) {
          const line = pending.slice(0, index); pending = pending.slice(index + 1);
          if (!line.startsWith("data: {")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "response.output_text.delta") sawDelta = true;
          if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) row.terminalEvents.push(event.type);
        }
        if (state.kind === "reconnect" && sawDelta && state.attempts <= 2) {
          assert.equal(state.submitted, 1, "fault must be after actual worker acceptance");
          assert.equal(row.terminalEvents.length, 0, "do not cut an already complete response");
          state.cuts++; row.cut = true; row.cutAfterSubmitted = true; row.cutAt = new Date().toISOString();
          row.faultKind = "accepted_partial_sse_eof"; row.bodyFlushCompleted = false;
          // End this partial SSE body only after its headers/chunk are sent; do not simulate a NIC fault or RST.
          await new Promise<void>(resolve => response.end(next.value, resolve));
          row.bodyFlushCompleted = true; row.bodyFlushedAt = new Date().toISOString();
          controller.abort();
          await reader.cancel().catch(() => {}); record({ event: "accepted_connection_cut", name: state.name, attempt: state.attempts,
            faultKind: row.faultKind, bodyFlushCompleted: row.bodyFlushCompleted });
          return;
        }
        response.write(next.value);
        if (state.kind === "reconnect" && sawDelta && state.attempts === 3) {
          assert.equal(state.cuts, 2); assert.equal(state.aborted, false); state.release();
        }
      }
      response.end(); row.finished = true;
    } finally { reader.releaseLock(); persist(); }
  } catch (error) {
    const isExpectedDisconnect = controller?.signal.aborted && response.destroyed;
    if (!isExpectedDisconnect) { fail(error); record({ event: "proxy_failure", error: String(error) }); }
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    if (!response.destroyed) response.end(JSON.stringify({ error: { code: "offline_fixture_rejected" } }));
  } finally { if (controller) requestsInFlight.delete(controller); persist(); }
});

class RpcClient {
  child = spawnNative("app-server-interrupt", ["app-server"]);
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  notifications: any[] = [];
  stdout = ""; stderr = ""; buffered = "";
  exited = exitPromise(this.child);
  constructor() {
    this.child.stdout!.on("data", data => {
      const text = data.toString(); this.stdout += text; this.buffered += text;
      if (this.stdout.length > 16 * 1024 ** 2) { fail(Error("app-server output limit")); killChild(this.child); return; }
      for (let end; (end = this.buffered.indexOf("\n")) >= 0;) {
        const line = this.buffered.slice(0, end).trim(); this.buffered = this.buffered.slice(end + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (typeof message.id === "number" && !message.method) {
            const waiting = this.pending.get(message.id); this.pending.delete(message.id);
            if (message.error) waiting?.reject(Error(JSON.stringify(message.error))); else waiting?.resolve(message.result);
          } else if (message.method && message.id === undefined) this.notifications.push(message);
          else { fail(Error("unexpected native app-server request; fixture never grants approval")); killChild(this.child); }
        } catch (error) { fail(error); killChild(this.child); }
      }
    });
    this.child.stderr!.on("data", data => { this.stderr += data.toString(); if (this.stderr.length > 8 * 1024 ** 2) { fail(Error("app-server stderr limit")); killChild(this.child); } });
    this.child.on("close", () => { for (const p of this.pending.values()) p.reject(Error("native app-server exited")); this.pending.clear(); });
  }
  notify(method: string, params: any = {}) { this.child.stdin!.write(JSON.stringify({ method, params }) + "\n"); }
  request(method: string, params: any = {}): Promise<any> {
    checked(); const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin!.write(JSON.stringify({ id, method, params }) + "\n"); return result;
  }
  async wait(method: string, predicate: (message: any) => boolean) {
    let result: any;
    await poll(method, () => { result = this.notifications.find(x => x.method === method && predicate(x)); return Boolean(result); }, 10_000);
    return result;
  }
  async close() {
    this.child.stdin!.end(); killChild(this.child);
    await this.exited;
    writeFileSync(prefix + "-app-server.jsonl", this.stdout); writeFileSync(prefix + "-app-server.stderr", this.stderr);
  }
}

try {
  record({ event: "suite_start", root, proxyPid: process.pid, limits });
  runtime = startServer(config, {
    fetchUpstream: async request => { observations.upstreamCalls++; fail(Error("external upstream forbidden: " + new URL(request.url).pathname)); throw fatal; },
    adapterFactory(actualProvider) {
      assert.equal(ChatGptBrowserWorker.forProvider(actualProvider), worker);
      return createChatGptWebAdapter(actualProvider);
    },
  });
  runtimePort = runtime.port!;
  await new Promise<void>((res, rej) => { proxy.once("error", rej); proxy.listen(0, "127.0.0.1", () => res()); });
  proxyPort = (proxy.address() as any).port;
  writeFileSync(prefix + "-ports.json", JSON.stringify({ pid: process.pid, runtimePort, proxyPort, root }, null, 2));
  // Reuse only the old fixture's static native model catalog, never its home or authentication.
  const catalog = join(root, "models.json");
  const catalogBytes = readFileSync(resolve("windows-ci-evidence/overnight-cli-candidate-last-data/models.json"));
  writeFileSync(catalog, catalogBytes); observations.catalogSha256 = hash(catalogBytes);
  const baseConfig = [ `model = ${JSON.stringify(model)}`, 'model_provider = "overnight_fixture"',
    `model_catalog_json = ${JSON.stringify(catalog)}`, 'sandbox_mode = "read-only"', 'approval_policy = "never"',
    '', '[features]', 'multi_agent = false', 'apps = false', '', '[model_providers.overnight_fixture]',
    'name = "Isolated loopback fixture; no built-in provider acceptance claim"',
    `base_url = ${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)}`, 'env_key = "OVERNIGHT_LOCAL_FIXTURE_KEY"',
    'wire_api = "responses"', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 2', '' ].join("\n");
  const configPath = join(home, "config.toml");
  const installed = installCodexInterruptHook(baseConfig, configPath, config);
  verifyCodexInterruptHook(installed.text, installed.installed);
  writeFileSync(configPath, installed.text);
  // Production hook CLI loads this new task configuration and sends its normal authorized admin request.
  saveConfig({ ...config, port: runtimePort });
  observations.hook = { command: installed.installed.command, trustedHash: installed.installed.trustedHash,
    configSha256: hash(installed.text), installedWith: "production installCodexInterruptHook", verifiedWith: "production verifyCodexInterruptHook", nativeTrusted: false };
  await idle("initial");
  if (["all", "exec-resume"].includes(phaseName)) {
  const first = newState("exec"); const initial = await execCase(first); oldThread = initial.thread; oldCanary = first.answer;
  await idle("after-exec");
  const resume = newState("resume", "resume"); await execCase(resume, true); await clearCase("after-resume");
  }
  if (["all", "reconnect"].includes(phaseName)) {
  const reconnect = newState("reconnect", "reconnect"); await execCase(reconnect);
  assert.equal(reconnect.cuts, 2); assert.equal(reconnect.requestIds.length, 3);
  await clearCase("after-reconnect");
  }
  if (["all", "interrupt-peer"].includes(phaseName)) {
  await deadline("native-interrupt-and-peer", async () => {
    const target = newState("interrupt-target", "interrupt"), peer = newState("interrupt-peer", "peer");
    nativeClient = new RpcClient(); const client = nativeClient;
    await client.request("initialize", { clientInfo: { name: "offline-cli-completion", version: "1" }, capabilities: { experimentalApi: true } });
    client.notify("initialized");
    const listed = await client.request("hooks/list", { cwds: [cwd] });
    const hooks = (listed?.data ?? []).flatMap((item: any) => item.hooks ?? []);
    const hook = hooks.find((item: any) => item.command === installed.installed.command);
    assert.ok(hook, "native CLI must discover the production hook");
    assert.equal(hook.currentHash, installed.installed.trustedHash); assert.equal(hook.trustStatus, "trusted");
    observations.hook.nativeTrusted = true; observations.hook.nativeCurrentHash = hook.currentHash; persist();
    async function start(state: State) {
      const started = await client.request("thread/start", { cwd, model, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
      const threadId = started?.thread?.id; assert.ok(typeof threadId === "string");
      const turn = await client.request("turn/start", { threadId, input: [{ type: "text", text: state.marker + ". Wait for this controlled lifecycle test. Do not use tools." }] });
      const turnId = turn?.turn?.id; assert.ok(typeof turnId === "string"); return { threadId, turnId };
    }
    const targetId = await start(target), peerId = await start(peer);
    assert.notEqual(targetId.threadId, peerId.threadId); assert.notEqual(targetId.turnId, peerId.turnId);
    await poll("both workers accepted", () => target.submitted === 1 && peer.submitted === 1);
    const active = await health("both-native-threads-active"); assert.equal(active.browser, 2);
    await client.request("turn/interrupt", targetId);
    await client.wait("turn/completed", m => m.params?.threadId === targetId.threadId && m.params?.turn?.id === targetId.turnId && m.params?.turn?.status === "interrupted");
    await poll("native hook cancelled only target owner", () => target.aborted && target.done);
    assert.equal(peer.aborted, false); assert.equal(peer.done, false);
    const peerHealth = await health("target-interrupted-peer-active"); assert.equal(peerHealth.browser, 1);
    peer.release();
    const completed = await client.wait("turn/completed", m => m.params?.threadId === peerId.threadId && m.params?.turn?.id === peerId.turnId);
    assert.equal(completed.params.turn.status, "completed"); assert.equal(peer.aborted, false);
    await client.close(); nativeClient = undefined;
    const peerWireText = client.notifications.filter(m => m.params?.threadId === peerId.threadId).map(m => JSON.stringify(m)).join("\n");
    assert.ok(peerWireText.includes(peer.answer), "native peer notifications must include its exact answer canary");
    for (const s of [target, peer]) { assert.equal(s.starts, 1); assert.equal(s.sends, 1); assert.equal(s.submitted, 1); assert.equal(s.attempts, 1); }
    observations.cases.push({ name: "native-interrupt-and-peer", target: targetId, peer: peerId,
      hookTrusted: true, targetAborted: target.aborted, targetSettled: target.done, peerAborted: peer.aborted,
      peerCompleted: true, peerAnswerSha256: hash(peer.answer) }); persist();
    for (const state of [target, peer]) ledger.turns.find((turn: any) => turn.name === state.name).status = "passed";
    saveLedger();
  });
  await clearCase("after-interrupt-peer");
  }
  if (["all", "cleanup"].includes(phaseName)) {
  for (let n = 1; n <= 20; n++) {
    const state = newState("cleanup-" + String(n).padStart(2, "0"));
    await execCase(state); await clearCase(state.name); checked();
  }
  }
  const expected: any = { all: [25, 27, 24], "exec-resume": [2, 2, 2], reconnect: [1, 3, 1], "interrupt-peer": [2, 2, 1], cleanup: [20, 20, 20] };
  assert.equal(observations.logicalTurns, expected[phaseName][0]); assert.equal(observations.responsesHttp, expected[phaseName][1]);
  assert.equal(observations.upstreamCalls, 0); assert.deepEqual(observations.unhandledRejections, []);
  assert.equal(observations.cases.length, expected[phaseName][2]);
  checked(); observations.completed = true;
} catch (error) {
  fail(error); observations.failure = { name: fatal!.name, message: fatal!.message, stack: fatal!.stack };
  record({ event: "suite_failed_stop_no_retry", error: fatal!.message });
} finally {
  for (const state of states) state.release();
  for (const controller of requestsInFlight) controller.abort();
  if (nativeClient) await nativeClient.close().catch(error => { observations.cleanup.nativeCloseError = String(error); });
  for (const child of children) killChild(child);
  await Bun.sleep(100);
  for (const child of children) killChild(child, "SIGKILL");
  observations.cleanup.children = childRecords;
  const steps: any[] = [];
  async function cleanup(name: string, op: () => any) { try { await op(); steps.push({ name, ok: true }); } catch (error) { steps.push({ name, ok: false, error: String(error) }); } }
  await cleanup("clear-and-physical-settlement", async () => { chatGptTurnSessions.clear(); await chatGptTurnSessions.waitForPhysicalSettlement(); });
  await cleanup("flush-state", () => flushResponseState());
  if (runtimePort) await cleanup("health-zero-before-stop", async () => { const h = await health("final-cleanup"); assert.equal(h.http, 0); assert.equal(h.browser, 0); });
  await cleanup("proxy-stop", async () => { for (const socket of proxySockets) socket.destroy(); await new Promise<void>(res => proxy.close(() => res())); });
  await cleanup("workers-close", () => closeChatGptBrowserWorkers());
  await cleanup("broker-close", () => TurnBroker.forSocket(config.brokerSocketPath).close());
  if (runtime) await cleanup("runtime-stop", () => runtime!.stop(true));
  worker.run = originalRun;
  for (const [name, port] of [["runtime", runtimePort], ["proxy", proxyPort]] as const) if (port) {
    await cleanup(name + "-port-closed", async () => {
      let closed = false; try { await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }); }
      catch (error: any) { closed = error.code === "ConnectionRefused" || error.cause?.code === "ECONNREFUSED" || error.code === "ECONNREFUSED"; }
      assert.equal(closed, true); observations.cleanup[name + "PortClosed"] = true;
    });
  }
  observations.cleanup.steps = steps; observations.cleanup.liveNativeChildren = children.size;
  observations.cleanup.workerRestored = worker.run === originalRun;
  observations.cleanup.allOk = steps.every(s => s.ok) && children.size === 0;
  for (const turn of ledger.turns) if (turn.prefix === prefix && turn.status === "started") turn.status = "failed-or-aborted";
  ledgerRun.status = observations.completed && observations.cleanup.allOk ? "passed" : "failed-stop";
  ledgerRun.failure = observations.failure; ledgerRun.finishedAt = new Date().toISOString(); saveLedger();
  observations.cumulativeLedger = { logicalTurns: ledger.logicalTurns, responsesHttp: ledger.responsesHttp,
    runs: ledger.runs.length, turns: ledger.turns };
  observations.finalStates = states.map(({ hold, release, signal, ...state }) => ({ ...state, ownerSignalAborted: signal?.aborted }));
  observations.finishedAt = new Date().toISOString(); persist();
  // Keep task-generated homes as bounded evidence. No prior homes, auth or user files were touched.
  console.log(JSON.stringify({ completed: observations.completed, failure: observations.failure,
    responsesHttp: observations.responsesHttp, logicalTurns: observations.logicalTurns,
    physicalModelSubmissions: 0, cleanupOk: observations.cleanup.allOk }));
  if (fatal || !observations.completed || !observations.cleanup.allOk) process.exitCode = 1;
}
