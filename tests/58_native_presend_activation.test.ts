import { tmpdir } from "node:os";
import { afterAll, test, expect } from "bun:test";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { rmSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DurableOperation, OperationJournal, hasNativeExecution, retainedOperationError, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import { ChatGptTurnSession, ChatGptTurnSessions, ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnRoundKey, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { NativeSubmissionCollector, retainsBrowserExecution, submissionIdentityUnproven, type NativeSubmissionRecord } from "../src/adapters/chatgpt-web/submission-identity";
import { BrowserObservationDetached, observationUnavailable } from "../src/adapters/chatgpt-web/observation-recovery";
import { ChatGptWebAdapterError, ChatGptCompactionHandoffAccepted } from "../src/adapters/chatgpt-web/adapter-error";
import type { NativeOperationScope } from "../src/adapters/chatgpt-web/native-execution";
import type { CodexParsedRequest } from "../src/types";
import { retainedForwardWorkerPolicy } from "../src/adapters/chatgpt-web/retained-forward-surface";

const evidence = process.env.Q39_TEST_ROOT ?? mkdtempSync(join(tmpdir(), "native-evidence-"));
afterAll(() => { if (!process.env.Q39_TEST_ROOT) rmSync(evidence, { recursive: true, force: true }); });
mkdirSync(evidence, { recursive: true });
const indexSource = process.env.R38_INDEX_SOURCE ?? resolve(import.meta.dir, "../src/adapters/chatgpt-web/index.ts");
const workerSource = process.env.R38_WORKER_SOURCE ?? resolve(import.meta.dir, "../src/adapters/chatgpt-web/browser-worker.ts");
function extract(file: string, name: string, env: Record<string, unknown>, kind: "method" | "function" | "variable") {
  const text = readFileSync(file, "utf8"), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if ((kind === "method" && ts.isMethodDeclaration(node) || kind === "function" && ts.isFunctionDeclaration(node)
      || kind === "variable" && ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast); if (!found) throw Error("AST declaration unavailable: " + name);
  const declaration = found.getText(ast), code = kind === "method" ? "class Probe { " + declaration + " }"
    : kind === "variable" ? "const " + declaration + ";" : declaration;
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(env), js + ";return " + (kind === "method" ? "Probe" : name))(...Object.values(env));
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error("R38 fixture bounded timeout")), 1200);
  })]); } finally { clearTimeout(timer); }
}
function fixture(threadId: string | undefined = "thread38") {
  const parsed: CodexParsedRequest = { modelId: "chatgpt-web/gpt-5.6", stream: true, options: {},
    context: { messages: [{ role: "user", content: "identical user bytes", timestamp: 0 }] },
    _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...(threadId ? { thread_id: threadId } : {}), turn_id: "turn38" }) },
      input: [{ type: "message", id: "user38", role: "user", content: "identical user bytes",
        internal_chat_message_metadata_passthrough: { turn_id: "turn38" } }] } };
  const scope: NativeOperationScope = { operationId: "operation38", executionKey: chatGptTurnExecutionKey(parsed),
    roundKey: chatGptTurnRoundKey(parsed), traceId: "trace38", ...(threadId ? { threadId } : {}), turnId: "turn38" };
  const record: OperationRecord = { version: 1, ...scope, ownerKey: "owner38", requestIds: [], submission: "prepared",
    generation: "not_started", delivery: "attached", recovery: "none", seq: 0, attempt: 1,
    startedAt: Date.now(), updatedAt: Date.now(), rounds: { [scope.roundKey]: { events: [], reasoning: [], completed: false } } };
  const journal = new OperationJournal(mkdtempSync(join(evidence!, "case-"))), op = new DurableOperation(journal, record);
  op.checkpoint();
  const slot: NativeSubmissionRecord = { version: 1, sendId: randomUUID(), revision: 1, phase: "send_activated",
    initialTurnIdentities: [], binding: { roundKey: scope.roundKey, stage: { kind: "final" }, documentEpoch: null,
      host: { pid: 38, instanceId: "h".repeat(32), profile: "production", partition: "persist:codex-web-gpt-chatgpt" },
      lease: { helperPid: process.pid, surfaceId: "s".repeat(32), targetId: "target38" } } };
  const submission = { phase: "prepared" as "prepared" | "send_activated" | "accepted" };
  const callbacks = (native = true) => extract(indexSource, "submissionLifecycle", {
    nativeSubmissionIdentity: native, nativeOperationScope: native ? scope : undefined,
    hooks: { operation: op }, parsed, submission, recoveryState: {}, chatGptTurnRoundKey, retainedOperationError, observationUnavailable,
  }, "variable");
  return { op, record, journal, scope, slot, submission, callbacks, parsed };
}
function cancellable(run: Promise<string>, op: DurableOperation) {
  return extract(indexSource, "cancellableBrowserTurn", { hasNativeExecution, retainedOperationError, retainsBrowserExecution }, "function")(run, new AbortController(), op);
}

test("actual runExclusive post-parent handshake heartbeat failure has zero slot/click and permits successor after end", async () => {
  const f = fixture();
  // A prepared scope alone was valid in33 too; retaining it distinguishes this from a missing-identity fixture.
  f.record.nativeScope = f.scope; f.op.checkpoint();
  let preparedAck = false, clicks = 0, collectors = 0;
  const controls: Array<Record<string, unknown>> = [], Noop = class extends Error {};
  const env = { retainedForwardWorkerPolicy, persistentConversationContext: () => undefined,
    notifyLauncherTurn: async (_path: unknown, request: Record<string, unknown>) => {
      controls.push(request);
      if (request.phase === "start") return { surfaceId: "s".repeat(32) };
      if (request.phase === "heartbeat" && !request.progress && preparedAck) throw Error("R38 post-parent awaited heartbeat failed");
      return {};
    },
    readLauncherBrowserHostDescriptor: () => ({ pid: 38, observationInstanceId: "h".repeat(32), profile: "production",
      partition: "persist:codex-web-gpt-chatgpt", surfaceTargets: { ["s".repeat(32)]: "target38" } }),
    browserOperationDeadline: () => undefined, LAUNCHER_TURN_START_TIMEOUT_MS: 2000,
    LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS: 2000, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS: 100000,
    LauncherBrowserWriterConflictError: Noop, LauncherBrowserTurnCancelledError: Noop, LauncherRetainedConversationUnavailableError: Noop,
    ChatGptWebAdapterError, ChatGptCompactionHandoffAccepted, BrowserObservationDetached, retainsBrowserExecution,
    submissionIdentityUnproven, isRecoverableBrowserFailure: () => false, isRecoverableBrowserNetworkFailure: () => false, process };
  const Probe = extract(workerSource, "runExclusive", env, "method"), worker = new Probe();
  worker.config = { browserHost: "launcher", browserHostDescriptorPath: "fixture-no-transport" };
  worker.runBrowserTurn = async (turn: any) => { await turn.onSendActivated(); collectors++; clicks++; throw Error("unexpected dispatch"); };
  const callbacks = f.callbacks();
  const run = worker.runExclusive({ ...callbacks, traceId: f.scope.traceId, capabilities: {}, onTextDelta() {},
    onSendActivated: async () => { await callbacks.onSendActivated(); preparedAck = true; } });
  const registry = new ChatGptTurnSessions();
  const session = registry.getOrCreate("original", () => ({ ...cancellable(run, f.op), operation: f.op,
    mode: "read-only", trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), submission: f.submission }),
    f.scope.traceId, f.record.ownerKey);
  await bounded(session.browserOutcome);
  let settlement = "resolved";
  try { await bounded(session.waitForPhysicalSettlement()); } catch (error) { settlement = String(error); }
  const result = { clicks, collectors, nativeSlots: f.record.nativeSubmissions?.length ?? 0,
    submission: f.record.submission, hasNativeExecution: hasNativeExecution(f.record),
    physicalSettled: f.record.physicalSettled, unresolvedOwner: !!f.journal.unresolvedOwner(f.record.ownerKey!, "next"),
    controls: controls.map(({ phase, status }) => ({ phase, status })), settlement };
  writeFileSync(join(evidence!, "heartbeat_result.json"), JSON.stringify(result, null, 2));
  expect(controls.at(-1)).toMatchObject({ phase: "end", status: "failed" });
  expect(clicks).toBe(0); expect(collectors).toBe(0); expect(result.nativeSlots).toBe(0);
  expect(f.record.submission).toBe("prepared"); expect(result.hasNativeExecution).toBe(false);
  expect(result.physicalSettled).toBe(true); expect(result.unresolvedOwner).toBe(false);
  let starts = 0;
  await bounded(registry.getOrCreateAfterOwnerRetirement("next", f.record.ownerKey!, () => {
    starts++; return { mode: "read-only", browser: Promise.resolve("next"), physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} };
  }));
  expect(starts).toBe(1);
});

test("Native preparation writes nothing; first identity callback atomically persists scope/slot/activation once", () => {
  const f = fixture(), observed: OperationRecord[] = [], write = f.journal.write.bind(f.journal);
  f.journal.write = (key, record) => { observed.push(structuredClone(record as OperationRecord)); write(key, record); };
  const callbacks = f.callbacks(); callbacks.onSendActivated();
  expect(observed).toHaveLength(0); expect(f.submission.phase).toBe("prepared"); expect(f.record.nativeScope).toBeUndefined();
  callbacks.onNativeSubmission(f.slot);
  expect(observed).toHaveLength(1); expect(observed[0]).toMatchObject({ nativeScope: f.scope,
    nativeSubmissions: [f.slot], submission: "send_activated", generation: "unknown", physicalSettled: false });
  expect(f.submission.phase).toBe("send_activated");
  callbacks.onNativeSubmission(f.slot); expect(observed).toHaveLength(1);
  expect(f.journal.read<OperationRecord>(f.scope.executionKey)!.nativeSubmissions).toEqual([f.slot]);
  expect(() => callbacks.onSendActivated()).toThrow(); expect(() => callbacks.onNativeSubmission({ ...f.slot, sendId: randomUUID() })).toThrow();
});

for (const afterWrite of [false, true]) test("uncertain first activation write retains exact attempted slot and refuses retry: afterWrite=" + afterWrite, async () => {
  const f = fixture(), write = f.journal.write.bind(f.journal);
  f.journal.write = (key, record) => { if (afterWrite) write(key, record); throw Error("injected first activation write failure"); };
  const collector = new NativeSubmissionCollector(record => f.callbacks().onNativeSubmission(record), {
    binding: f.slot.binding!, watch: async () => { throw Error("Host must not start before parent ACK"); },
  } as any);
  let error: unknown, clicks = 0;
  try { await collector.activate(new EventEmitter() as any, []); collector.arm(); collector.dispatching(); clicks++; } catch (caught) { error = caught; }
  expect(retainsBrowserExecution(error)).toBe(true); expect(clicks).toBe(0); expect(collector.acknowledgedSnapshot()).toBeUndefined();
  expect(f.record.submission).toBe("send_activated"); expect(f.record.nativeSubmissions).toHaveLength(1);
  expect(hasNativeExecution(f.record)).toBe(true); expect(f.op.hasNativeRelease()).toBe(false);
  expect(() => f.op.nativeSubmission(f.record.nativeSubmissions![0], f.scope)).toThrow("persistence");
  const stored = f.journal.read<OperationRecord>(f.scope.executionKey)!;
  expect(stored.submission).toBe(afterWrite ? "send_activated" : "prepared");
  f.journal.write = write;
  const registry = new ChatGptTurnSessions();
  const session = registry.getOrCreate("original", () => ({ ...cancellable(Promise.reject(error), f.op),
    mode: "read-only", operation: f.op, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), submission: f.submission }),
    f.scope.traceId, f.record.ownerKey);
  await bounded(session.browserOutcome); await expect(bounded(session.waitForPhysicalSettlement())).rejects.toThrow("retained");
  expect(f.journal.unresolvedOwner(f.record.ownerKey!, "next")).toBeDefined();
  let starts = 0; await expect(bounded(registry.getOrCreateAfterOwnerRetirement("next", f.record.ownerKey!, () => {
    starts++; throw Error("unexpected successor");
  }))).rejects.toThrow("retained"); expect(starts).toBe(0); collector.dispose();
});

test("old activated UNKNOWN with no slot stays fenced; no prepared migration or new slot is allowed", () => {
  const f = fixture(); f.record.nativeScope = f.scope; f.op.beforeSend();
  const writes = f.journal.metrics.writes;
  expect(() => f.op.prepareNativeSubmission(f.scope)).toThrow(); expect(() => f.op.nativeSubmission(f.slot, f.scope)).toThrow();
  expect(f.journal.metrics.writes).toBe(writes); expect(f.record.nativeSubmissions).toBeUndefined();
  expect(hasNativeExecution(f.record)).toBe(true); expect(f.journal.unresolvedOwner(f.record.ownerKey!, "next")).toBeDefined();
});

test("first slot rechecks original deadline after preparation without persisting activation", () => {
  const f = fixture(); f.op.freezeRecoveryBudget(10000); f.op.prepareNativeSubmission(f.scope);
  f.record.recoveryBudget!.deadlineAt = Date.now() - 1; const writes = f.journal.metrics.writes;
  expect(() => f.op.nativeSubmission(f.slot, f.scope)).toThrow("deadline");
  expect(f.journal.metrics.writes).toBe(writes); expect(f.record.submission).toBe("prepared"); expect(f.record.nativeSubmissions).toBeUndefined();
});

test("foreign scope, wrong final round and missing bound identity fail before any activation write", () => {
  for (const kind of ["scope", "round", "stage", "binding"]) {
    const f = fixture(), slot = structuredClone(f.slot), scope = structuredClone(f.scope), writes = f.journal.metrics.writes;
    if (kind === "scope") scope.traceId = "foreign";
    if (kind === "round") slot.binding!.roundKey = "foreign";
    if (kind === "stage") slot.binding!.stage = { kind: "part", index: 1, total: 2 };
    if (kind === "binding") delete slot.binding;
    expect(() => f.op.nativeSubmission(slot, scope)).toThrow(); expect(f.journal.metrics.writes).toBe(writes);
    expect(hasNativeExecution(f.record)).toBe(false);
  }
});

test("legacy onSendActivated still checkpoints before Send and does not use Native scope", () => {
  const f = fixture(), writes = f.journal.metrics.writes; f.callbacks(false).onSendActivated();
  expect(f.journal.metrics.writes).toBe(writes + 1); expect(f.record.submission).toBe("send_activated");
  expect(f.record.nativeScope).toBeUndefined(); expect(f.submission.phase).toBe("send_activated");
});

test("first slot freezes actual scope without aliasing caller mutations and preserves turn-only absence", () => {
  const f = fixture(""); f.callbacks().onSendActivated(); f.callbacks().onNativeSubmission(f.slot);
  expect(Object.hasOwn(f.record.nativeScope!, "threadId")).toBe(false);
  expect(Object.hasOwn(f.journal.read<OperationRecord>(f.scope.executionKey)!.nativeScope!, "threadId")).toBe(false);
  f.scope.threadId = "invented";
  expect(Object.hasOwn(f.record.nativeScope!, "threadId")).toBe(false);
  expect(() => f.op.nativeSubmission(f.slot, f.scope)).toThrow("scope");
  expect(() => f.op.nativeCancelIntent({ version: 1, source: "native_interrupt", cancelId: randomUUID(),
    threadId: "invented", turnId: f.scope.turnId, requestedAt: Date.now() })).toThrow();
});

test("lost first slot ACK cannot authorize physical settlement even though dispatcher never clicked", async () => {
  const f = fixture(); let clicks = 0, watchStarts = 0;
  const collector = new NativeSubmissionCollector(record => { f.callbacks().onNativeSubmission(record); throw Error("lost durable ACK transport"); },
    { binding: f.slot.binding!, watch: async () => { watchStarts++; throw Error("must not start"); } } as any);
  let failure: unknown;
  try { await collector.activate(new EventEmitter() as any, []); collector.arm(); collector.dispatching(); clicks++; } catch (error) { failure = error; }
  expect(clicks).toBe(0); expect(watchStarts).toBe(0); expect(collector.acknowledgedSnapshot()).toBeUndefined();
  expect(f.record.nativeSubmissions).toHaveLength(1); expect(hasNativeExecution(f.record)).toBe(true);
  const session = new ChatGptTurnSession({ ...cancellable(Promise.reject(failure), f.op), operation: f.op,
    mode: "read-only", trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), submission: f.submission });
  await bounded(session.browserOutcome);
  await expect(bounded(session.waitForPhysicalSettlement())).rejects.toThrow("retained");
  expect(f.record.physicalSettled).toBe(false); expect(f.journal.unresolvedOwner(f.record.ownerKey!, "next")).toBeDefined();
  collector.dispose();
});
