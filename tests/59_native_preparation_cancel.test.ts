import { tmpdir } from "node:os";
import { afterAll, test, expect } from "bun:test";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { rmSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DurableOperation, OperationJournal, hasNativeExecution, retainedOperationError,
  nativePreparationCancelledError, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import { ChatGptTurnSession, ChatGptTurnSessions, ChatGptTextFeed, ChatGptTraceFeed,
  chatGptTurnRoundKey, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { retainsBrowserExecution, submissionIdentityUnproven, type NativeSubmissionRecord } from "../src/adapters/chatgpt-web/submission-identity";
import { ExplicitNativeCancellation, type NativeOperationScope, type NativeCancelRequest } from "../src/adapters/chatgpt-web/native-execution";
import { BrowserObservationDetached, observationUnavailable } from "../src/adapters/chatgpt-web/observation-recovery";
import { ChatGptWebAdapterError, ChatGptCompactionHandoffAccepted } from "../src/adapters/chatgpt-web/adapter-error";
import type { CodexParsedRequest } from "../src/types";
import { retainedForwardWorkerPolicy } from "../src/adapters/chatgpt-web/retained-forward-surface";

const evidence = process.env.Q39_TEST_ROOT ?? mkdtempSync(join(tmpdir(), "native-evidence-"));
afterAll(() => { if (!process.env.Q39_TEST_ROOT) rmSync(evidence, { recursive: true, force: true }); });
mkdirSync(evidence, { recursive: true });
const indexSource = resolve(import.meta.dir, "../src/adapters/chatgpt-web/index.ts");
const workerSource = process.env.R38B_WORKER_SOURCE ?? resolve(import.meta.dir, "../src/adapters/chatgpt-web/browser-worker.ts");
function extract(file: string, name: string, env: Record<string, unknown>, kind: "variable" | "function" | "method") {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  function visit(n: ts.Node) {
    if ((kind === "variable" && ts.isVariableDeclaration(n) || kind === "function" && ts.isFunctionDeclaration(n)
      || kind === "method" && ts.isMethodDeclaration(n)) && n.name?.getText(ast) === name) found = n;
    ts.forEachChild(n, visit);
  }
  visit(ast); if (!found) throw Error("missing AST " + name);
  const declaration = found.getText(ast), code = kind === "variable" ? "const " + declaration + ";"
    : kind === "method" ? "class Probe { " + declaration + " }" : declaration;
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js + ";return " + (kind === "method" ? "Probe" : name))(...Object.values(env));
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("38b bounded timeout")), 1200); })]); }
  finally { clearTimeout(timer); }
}
function fixture(thread = "thread38b") {
  const parsed: CodexParsedRequest = { modelId: "chatgpt-web/gpt-5.6", stream: true, options: {},
    context: { messages: [{ role: "user", content: "original bytes", timestamp: 0 }] },
    _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...(thread ? { thread_id: thread } : {}), turn_id: "turn38b" }) },
      input: [{ type: "message", role: "user", id: "user38b", content: "original bytes",
        internal_chat_message_metadata_passthrough: { turn_id: "turn38b" } }] } };
  const scope: NativeOperationScope = { operationId: "op38b", executionKey: chatGptTurnExecutionKey(parsed), roundKey: chatGptTurnRoundKey(parsed),
    traceId: "trace38b", turnId: "turn38b", ...(thread ? { threadId: thread } : {}) };
  const record: OperationRecord = { version: 1, ...scope, ownerKey: "owner38b", requestIds: [], submission: "prepared", generation: "not_started",
    delivery: "attached", recovery: "none", seq: 0, attempt: 1, startedAt: Date.now(), updatedAt: Date.now(),
    rounds: { [scope.roundKey]: { events: [], reasoning: [], completed: false } } };
  const journal = new OperationJournal(mkdtempSync(join(evidence!, "case-"))), op = new DurableOperation(journal, record); op.checkpoint();
  const request: NativeCancelRequest = { version: 1, cancelId: randomUUID(), source: "native_interrupt",
    threadId: thread || "invented", turnId: scope.turnId, requestedAt: Date.now() };
  const slot: NativeSubmissionRecord = { version: 1, sendId: randomUUID(), revision: 1, phase: "send_activated", initialTurnIdentities: [],
    binding: { roundKey: scope.roundKey, stage: { kind: "final" }, documentEpoch: null,
      host: { pid: 38, instanceId: "h".repeat(32), profile: "production", partition: "persist:codex-web-gpt-chatgpt" },
      lease: { helperPid: process.pid, surfaceId: "s".repeat(32), targetId: "target38b" } } };
  const submission = { phase: "prepared" as const };
  const callbacks = extract(indexSource, "submissionLifecycle", { nativeSubmissionIdentity: true, nativeOperationScope: scope,
    hooks: { operation: op }, parsed, submission, recoveryState: {}, chatGptTurnRoundKey, retainedOperationError, observationUnavailable }, "variable");
  return { op, record, journal, scope, request, slot, submission, callbacks };
}
function runtime(f: ReturnType<typeof fixture>, run: Promise<string>) {
  const wrapped = extract(indexSource, "cancellableBrowserTurn", { hasNativeExecution, retainedOperationError, retainsBrowserExecution }, "function")(run, new AbortController(), f.op);
  return { ...wrapped, operation: f.op, mode: "read-only" as const, text: new ChatGptTextFeed(), trace: new ChatGptTraceFeed(), submission: f.submission };
}

test("preparation cancel callback durably binds original request, grants no execution/release, and is idempotent", async () => {
  const f = fixture(), writes = f.journal.metrics.writes;
  const payload = await f.callbacks.onNativePreparationCancel(f.request);
  expect(payload).toEqual({ version: 1, scope: f.scope, request: f.request });
  expect(f.journal.metrics.writes).toBe(writes + 1);
  expect(f.journal.read<OperationRecord>(f.scope.executionKey)!.nativePreparationCancel).toEqual(payload);
  expect(f.record.error).toMatchObject({ code: "client_cancelled", retryable: false });
  expect(hasNativeExecution(f.record)).toBe(false); expect(f.record.nativeSubmissions).toBeUndefined();
  expect(f.record.nativeRelease).toBeUndefined(); expect(f.record.physicalSettled).toBe(false);
  expect(f.journal.unresolvedOwner(f.record.ownerKey!, "next")).toBeDefined();
  expect(await f.callbacks.onNativePreparationCancel(f.request)).toEqual(payload);
  expect(f.journal.metrics.writes).toBe(writes + 1);
  payload.request.threadId = "tampered"; expect(f.record.nativePreparationCancel!.request.threadId).toBe("thread38b");
  await expect(f.callbacks.onNativePreparationCancel({ ...f.request, cancelId: randomUUID() })).rejects.toThrow();
});

test("late Native activation and generic retryable errors cannot undo a durable preparation cancel", async () => {
  const f = fixture(); await f.callbacks.onNativePreparationCancel(f.request);
  const writes = f.journal.metrics.writes;
  expect(() => f.callbacks.onNativeSubmission(f.slot)).toThrow("cancelled");
  expect(() => f.callbacks.onSendActivated()).toThrow("cancelled");
  expect(() => f.op.beforeSend()).toThrow("cancelled"); expect(() => f.op.accepted()).toThrow("cancelled");
  expect(f.journal.metrics.writes).toBe(writes); expect(f.record.nativeSubmissions).toBeUndefined();
  f.record.error = { code: "some_transport_error", retryable: true };
  expect(extract(indexSource, "safeRetry", { saved: f.record }, "variable")).toBe(false);
  f.op.checkpoint(); expect(f.record.error).toMatchObject({ code: "client_cancelled", retryable: false });
  const loaded = new DurableOperation(f.journal, f.journal.read<OperationRecord>(f.scope.executionKey)!);
  expect(() => loaded.prepareNativeSubmission(f.scope)).toThrow("cancelled"); expect(loaded.hasNativeRelease()).toBe(false);
});

test("original raw helper lifecycle alone settles preparation cancellation; the durable intent alone never opens owner", async () => {
  const f = fixture(), helper = deferred<string>(), registry = new ChatGptTurnSessions();
  const session = registry.getOrCreate("original", () => runtime(f, helper.promise), f.scope.traceId, f.record.ownerKey);
  await f.callbacks.onNativePreparationCancel(f.request);
  let starts = 0;
  const next = registry.getOrCreateAfterOwnerRetirement("next", f.record.ownerKey!, () => {
    starts++; return { mode: "read-only", browser: Promise.resolve("next"), physicalSettlement: Promise.resolve(),
      text: new ChatGptTextFeed(), trace: new ChatGptTraceFeed(), cancel() {} };
  });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(starts).toBe(0); expect(session.isPhysicallySettled()).toBe(false);
  helper.reject(new DOMException("original never-dispatched helper ended", "AbortError"));
  await bounded(session.browserOutcome); await bounded(session.waitForPhysicalSettlement()); await bounded(next);
  expect(starts).toBe(1); expect(f.record.error).toMatchObject({ code: "client_cancelled", retryable: false });
  expect(f.record.physicalSettled).toBe(true); expect(f.record.nativeRelease).toBeUndefined();
  expect(f.journal.unresolvedOwner(f.record.ownerKey!, "next")).toBeUndefined();
  await f.callbacks.onNativePreparationCancel(f.request); expect(f.record.physicalSettled).toBe(true);
});

for (const afterWrite of [false, true]) test("preparation cancel write failure provides no ACK and retains its activation fence: afterWrite=" + afterWrite, async () => {
  const f = fixture(), write = f.journal.write.bind(f.journal);
  f.journal.write = (key, value) => { if (afterWrite) write(key, value); throw Error("injected cancellation fsync failure"); };
  let failure: unknown;
  try { await f.callbacks.onNativePreparationCancel(f.request); } catch (error) { failure = error; }
  expect(retainsBrowserExecution(failure)).toBe(true); expect(f.record.nativePreparationCancel).toBeDefined();
  expect(hasNativeExecution(f.record)).toBe(false); expect(f.record.physicalSettled).toBe(false);
  expect(() => f.op.nativeSubmission(f.slot, f.scope)).toThrow("persistence");
  await expect(f.callbacks.onNativePreparationCancel(f.request)).rejects.toThrow("persistence");
  expect(!!f.journal.read<OperationRecord>(f.scope.executionKey)!.nativePreparationCancel).toBe(afterWrite);
  f.journal.write = write;
  const session = new ChatGptTurnSession(runtime(f, Promise.reject(failure)));
  await bounded(session.browserOutcome); await expect(bounded(session.waitForPhysicalSettlement())).rejects.toThrow();
  expect(session.isPhysicallySettled()).toBe(false); expect(f.journal.unresolvedOwner(f.record.ownerKey!, "next")).toBeDefined();
});

test("first Native frame/activation including write-unknown and old activated UNKNOWN are never preparation cancellation", async () => {
  for (const state of ["allocated", "write_unknown", "old_unknown"]) {
    const f = fixture();
    if (state === "old_unknown") { f.record.nativeScope = f.scope; f.op.beforeSend(); }
    else {
      const write = f.journal.write.bind(f.journal);
      if (state === "write_unknown") f.journal.write = () => { throw Error("unknown activation"); };
      try { f.op.nativeSubmission(f.slot, f.scope); } catch { /* actual uncertain activation */ }
      f.journal.write = write;
    }
    await expect(f.callbacks.onNativePreparationCancel(f.request)).rejects.toThrow();
    expect(f.record.nativePreparationCancel).toBeUndefined(); expect(hasNativeExecution(f.record)).toBe(true);
    expect(f.op.hasNativeRelease()).toBe(false);
  }
});

test("request/scope identity stays exact; turn-only does not gain cancellation authority", async () => {
  for (const kind of ["thread", "turn", "source", "scope", "absent_thread"]) {
    const f = fixture(kind === "absent_thread" ? "" : "thread38b"), request = { ...f.request }, scope = { ...f.scope };
    if (kind === "thread") request.threadId = "foreign";
    if (kind === "turn") request.turnId = "foreign";
    if (kind === "source") (request as any).source = "internal_abort";
    if (kind === "scope") scope.roundKey = "foreign";
    expect(() => f.op.nativePreparationCancellation(request, scope)).toThrow(); expect(f.record.nativePreparationCancel).toBeUndefined();
  }
});

test("preparation cancellation does not extend generation and remains available after its deadline", async () => {
  const f = fixture(); f.op.freezeRecoveryBudget(1000); f.record.recoveryBudget!.deadlineAt = Date.now() - 1;
  const deadline = f.record.recoveryBudget!.deadlineAt;
  await f.callbacks.onNativePreparationCancel(f.request); expect(f.record.recoveryBudget!.deadlineAt).toBe(deadline);
  expect(() => f.op.nativeCancelIntent(f.request)).toThrow(); expect(f.record.nativeCancelIntent).toBeUndefined();
});

for (const endFails of [false, true]) test("actual runExclusive releases empty lease only after explicit preparation cancellation end ACK: endFails=" + endFails, async () => {
  const f = fixture(), abort = new AbortController(), controls: Array<Record<string, unknown>> = [], Noop = class extends Error {};
  const env = { retainedForwardWorkerPolicy, persistentConversationContext: () => undefined,
    notifyLauncherTurn: async (_path: unknown, request: Record<string, unknown>) => {
      controls.push(request); if (request.phase === "start") return { surfaceId: "s".repeat(32) };
      if (request.phase === "end" && endFails) throw Error("original empty lease end ACK lost");
      return {};
    },
    readLauncherBrowserHostDescriptor: () => ({ pid: 38, observationInstanceId: "h".repeat(32), profile: "production",
      partition: "persist:codex-web-gpt-chatgpt", surfaceTargets: { ["s".repeat(32)]: "target38b" } }),
    browserOperationDeadline: () => undefined, LAUNCHER_TURN_START_TIMEOUT_MS: 2000,
    LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS: 2000, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS: 100000,
    LauncherBrowserWriterConflictError: Noop, LauncherBrowserTurnCancelledError: Noop, LauncherRetainedConversationUnavailableError: Noop,
    ChatGptWebAdapterError, ChatGptCompactionHandoffAccepted, BrowserObservationDetached, retainsBrowserExecution,
    submissionIdentityUnproven, isRecoverableBrowserFailure: () => false, isRecoverableBrowserNetworkFailure: () => false, process };
  const Probe = extract(workerSource, "runExclusive", env, "method"), worker = new Probe();
  worker.config = { browserHost: "launcher", browserHostDescriptorPath: "fixture-only" };
  worker.runBrowserTurn = async (turn: any) => {
    await turn.onSendActivated();
    const preparation = await f.callbacks.onNativePreparationCancel(f.request);
    const reason = new ExplicitNativeCancellation(f.request, undefined, preparation); abort.abort(reason); throw reason;
  };
  const run = worker.runExclusive({ ...f.callbacks, traceId: f.scope.traceId, capabilities: {}, onTextDelta() {}, abortSignal: abort.signal });
  const session = new ChatGptTurnSession(runtime(f, run));
  await bounded(session.browserOutcome);
  if (endFails) await expect(bounded(session.waitForPhysicalSettlement())).rejects.toThrow("release");
  else await bounded(session.waitForPhysicalSettlement());
  expect(controls.at(-1)).toMatchObject({ phase: "end", status: "aborted" });
  expect(controls.some(value => value.nativeRelease)).toBe(false);
  expect(f.record.nativeRelease).toBeUndefined(); expect(f.record.nativeSubmissions).toBeUndefined();
  expect(hasNativeExecution(f.record)).toBe(false); expect(session.isPhysicallySettled()).toBe(!endFails);
  expect(!!f.journal.unresolvedOwner(f.record.ownerKey!, "next")).toBe(endFails);
  expect(f.record.error).toMatchObject({ code: "client_cancelled", retryable: false });
  writeFileSync(join(evidence!, endFails ? "end_failure.json" : "end_success.json"),
    JSON.stringify({ controls, physicalSettled: session.isPhysicallySettled(), record: f.record }, null, 2));
});
