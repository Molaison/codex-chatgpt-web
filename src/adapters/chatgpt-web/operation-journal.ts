import { nativeSubmissionDescendsFrom, nativeSubmissionDigest, parseNativeSubmission, submissionIdentityUnproven, type NativeSubmissionRecord } from "./submission-identity";
import type { NativeOperationScope, NativeResultReady, NativeReleaseReceipt, NativeCancelRequest, NativeCancelIntent, NativeCancelTerminal, NativePreparationCancellation } from "./native-execution";
import { CHATGPT_RECOVERY_TIME_ALLOWANCE_MS } from "./retry-policy";
import type { BrowserObservationCheckpoint } from "./observation-recovery";
import type { ChatGptChartWidget } from "./rich-widget";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir, isWindowsPipeEndpoint } from "../../config";
import type { AdapterEvent, ProviderNotice } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";

export function operationRuntimeDirectory(statePath?: string, socketPath?: string): string {
  return statePath ? dirname(statePath)
    : socketPath && !isWindowsPipeEndpoint(socketPath) ? dirname(socketPath)
    : join(getConfigDir(), "runtime");
}
export const operationDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export interface OperationRound {
  events: AdapterEvent[];
  reasoning: string[];
  completed: boolean;
  failure?: string;
}
export type RecoveryReason = "transport_retry" | "context_recovery" | "observer_reconnect" | "http_retry";
export interface OperationRecoveryBudget {
  version: 1;
  limit: 3;
  used: number;
  startedAt: number;
  deadlineAt?: number;
  attempts: Array<{ at: number; reason: RecoveryReason }>;
  clock?: { allowanceMs: number; spentMs: number; epoch: number;
    active?: { startedAt: number; deadlineAt: number } };
}
export interface OperationRecord {
  nativeSubmissions?: NativeSubmissionRecord[];
  nativeScope?: NativeOperationScope;
  nativePreparationCancel?: NativePreparationCancellation;
  nativeFinal?: NativeResultReady;
  richWidgets?: ChatGptChartWidget[];
  nativeCancelIntent?: NativeCancelIntent;
  nativeCancelTerminal?: NativeCancelTerminal;
  nativeRelease?: NativeReleaseReceipt;
  version: 1;
  operationId: string;
  executionKey: string;
  traceId: string;
  ownerKey?: string;
  threadId?: string;
  turnId?: string;
  requestIds: string[];
  conversationKey?: string;
  physicalSettled?: boolean;
  observation?: BrowserObservationCheckpoint;
  recoveryBudget?: OperationRecoveryBudget;
  recoveryNotices?: Record<string, ProviderNotice>;
  recoveryAttempts?: Array<{ at: number; submission: OperationRecord["submission"]; observation?: BrowserObservationCheckpoint }>;
  observationRound?: { roundKey: string; deliveredToolResults: Record<string, string> };
  noticeSeq?: number;
  forkNoticeEmitted?: true;
  notices?: ProviderNotice[];
  compactionContinuation?: { compactionExecutionKey: string; compactionOperationId: string; summaryHash?: string };
  submission: "prepared" | "send_activated" | "accepted";
  generation: "not_started" | "running" | "final" | "unknown";
  delivery: "attached" | "detached" | "unknown";
  recovery: "none" | "retained";
  seq: number;
  attempt: number;
  updatedAt: number;
  startedAt?: number;
  rounds: Record<string, OperationRound>;
  final?: { answer: string; events: AdapterEvent[]; reasoning: string[] };
  error?: { code?: string; retryable?: boolean; diagnostics?: Record<string, unknown> };
}

export function retainedOperationError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("The original execution is retained and needs reconciliation by its runtime owner; reconnect will not send or dispatch it again.", {
    status: 409, errorType: "server_error", code: "chatgpt_execution_retained", retryable: false,
  });
}

const sameNative = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const nativeUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const nativeSha = /^[a-f0-9]{64}$/;
const nativeTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export function hasNativeExecution(record: OperationRecord): boolean {
  return !!(record.nativeSubmissions?.length || record.nativeFinal || record.nativeCancelIntent || record.nativeRelease
    || record.nativeScope && record.submission !== "prepared");
}
export function nativePreparationCancelledError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("The original turn was explicitly cancelled before Native submission.", {
    status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false,
  });
}
function assertNativeScope(record: OperationRecord, scope: NativeOperationScope): void {
  if (!scope || !record.nativeScope || !sameNative(scope, record.nativeScope)
    || ![scope.operationId, scope.executionKey, scope.roundKey, scope.turnId, scope.traceId]
      .every(value => typeof value === "string" && value.length > 0)
    || Object.hasOwn(scope, "threadId") && (typeof scope.threadId !== "string" || !scope.threadId)
    || scope.operationId !== record.operationId || scope.executionKey !== record.executionKey
    || scope.threadId !== record.threadId || scope.turnId !== record.turnId || scope.traceId !== record.traceId
    || !Object.hasOwn(record.rounds, scope.roundKey)) throw submissionIdentityUnproven("result scope differs from the original Native round");
}
function currentNativeSlot(record: OperationRecord): NativeSubmissionRecord {
  const raw = record.nativeSubmissions?.at(-1);
  if (!raw) throw submissionIdentityUnproven("original physical slot is unavailable");
  const slot = parseNativeSubmission(raw);
  assertNativeScope(record, record.nativeScope!);
  if (!slot.binding || slot.binding.stage.kind !== "final" || slot.binding.roundKey !== record.nativeScope!.roundKey
    || slot.phase === "conflict") throw submissionIdentityUnproven("current physical slot is not the original final");
  return slot;
}
function assertNativeReady(record: OperationRecord, ready: NativeResultReady): void {
  assertNativeScope(record, ready?.scope);
  const slot = currentNativeSlot(record);
  if (ready.version !== 1 || ready.sendId !== slot.sendId || slot.phase !== "completed"
    || ready.completedDigest !== nativeSubmissionDigest(slot) || !nativeSha.test(ready.completedDigest)
    || typeof ready.answer !== "string" || ready.answerSha256 !== operationDigest(ready.answer)
    || !nativeTime(ready.readyAt) || ready.readyAt < slot.completion!.observedAt) {
    throw submissionIdentityUnproven("final answer lacks the exact durable completed submission");
  }
  const round = record.rounds[ready.scope.roundKey]!;
  const prefix = round.events.filter(event => event.type === "text_delta" && event.phase === "final_answer")
    .map(event => (event as { text: string }).text).join("");
  if (round.events.some(event => event.type === "tool_call_start") || !ready.answer.startsWith(prefix)) {
    throw submissionIdentityUnproven("the current round is not a prefix of its original final answer");
  }
}
function assertCancelIntent(record: OperationRecord, intent: NativeCancelIntent): void {
  assertNativeScope(record, intent?.scope);
  const slot = currentNativeSlot(record);
  if (intent.version !== 1 || intent.source !== "native_interrupt" || !nativeUuid.test(intent.cancelId)
    || typeof intent.threadId !== "string" || !intent.threadId || !intent.scope.threadId
    || intent.scope.threadId !== intent.threadId || typeof intent.turnId !== "string" || !intent.turnId
    || intent.threadId !== record.threadId || intent.turnId !== record.turnId || !nativeTime(intent.requestedAt)
    || intent.sendId !== slot.sendId || !slot.binding?.documentEpoch || !slot.hostWatch
    || !sameNative(intent.binding, slot.binding)) throw submissionIdentityUnproven("cancellation has no exact original physical owner");
}
function assertCancelTerminal(record: OperationRecord, terminal: NativeCancelTerminal): void {
  const intent = record.nativeCancelIntent;
  if (!intent) throw submissionIdentityUnproven("terminal cancellation has no durable intent");
  assertCancelIntent(record, intent);
  const slot = currentNativeSlot(record), watch = slot.hostWatch!;
  if (!terminal || terminal.cancelId !== intent.cancelId || terminal.sendId !== slot.sendId
    || terminal.sessionEpoch !== watch.sessionEpoch || !Number.isSafeInteger(terminal.watchSeq) || terminal.watchSeq < watch.seq
    || !nativeTime(terminal.observedAt) || terminal.observedAt < intent.requestedAt) {
    throw submissionIdentityUnproven("cancellation terminal differs from the original watch");
  }
  if (terminal.proof === "not_dispatched") {
    // The authenticated original dispatcher must additionally prove it never attempted click.
    // A zero-POST observation alone is never used here to create a cancellation intent.
    if (terminal.dispatchAttempted !== false || slot.phase !== "watch_ready" || slot.post || watch.postCount !== 0 || terminal.assistantIdentity !== undefined) {
      throw submissionIdentityUnproven("not-dispatched proof conflicts with the original Send");
    }
  } else if (terminal.proof === "same-bound-generation-stopped" || terminal.proof === "same-bound-generation-completed") {
    if (terminal.dispatchAttempted !== true || !slot.post || terminal.assistantIdentity !== `group:assistant:${slot.post.userMessageId}`
      || terminal.proof === "same-bound-generation-completed" && slot.phase !== "completed"
      || terminal.proof === "same-bound-generation-stopped" && (slot.phase !== "accepted"
        || slot.dom?.assistantIdentity !== terminal.assistantIdentity)) {
      throw submissionIdentityUnproven("cancellation terminal is not the original generation");
    }
  } else throw submissionIdentityUnproven("unknown cancellation terminal proof");
}
function assertNativeRelease(record: OperationRecord, release: NativeReleaseReceipt): void {
  const slot = currentNativeSlot(record), binding = slot.binding!, watch = slot.hostWatch;
  if (!release || release.version !== 1 || !nativeUuid.test(release.releaseId) || release.sendId !== slot.sendId
    || release.roundKey !== binding.roundKey || !watch || release.sessionEpoch !== watch.sessionEpoch
    || !sameNative(release.host, binding.host) || !sameNative(release.lease, binding.lease)
    || release.documentEpoch !== binding.documentEpoch || !nativeSha.test(release.terminalDigest)) {
    throw submissionIdentityUnproven("Host release differs from the original physical owner");
  }
  if (release.outcome === "completed") {
    if (!record.nativeFinal) throw submissionIdentityUnproven("Host completed before durable result-ready");
    assertNativeReady(record, record.nativeFinal);
    if (release.terminalDigest !== record.nativeFinal.completedDigest) throw submissionIdentityUnproven("Host completion digest changed");
  } else if (release.outcome === "cancelled") {
    const terminal = record.nativeCancelTerminal;
    if (!terminal) throw submissionIdentityUnproven("Host cancellation has no durable terminal");
    assertCancelTerminal(record, terminal);
    if (terminal.proof === "same-bound-generation-completed" || release.terminalDigest !== operationDigest(JSON.stringify(terminal))) {
      throw submissionIdentityUnproven("Host cancellation digest changed");
    }
  } else throw submissionIdentityUnproven("unknown Host release outcome");
}
/** Stored booleans and logical finals cannot stand in for a Native Host release receipt. */
export function nativeOperationReleased(record: OperationRecord): boolean {
  if (!hasNativeExecution(record)) return record.physicalSettled === true;
  try { assertNativeRelease(record, record.nativeRelease!); return true; } catch { return false; }
}

function canArchiveOperation(record: OperationRecord): boolean {
  const terminal = record.generation === "final" && record.final
    || record.nativeRelease?.outcome === "cancelled" || record.nativePreparationCancel
    || record.error?.code === "client_cancelled";
  return !!terminal && record.physicalSettled === true && nativeOperationReleased(record);
}

/** Private checkpoints, not another permission authority. One existing role runtime owns writes. */
export class OperationJournal {
  readonly directory: string;
  readonly metrics = { writes: 0, bytes: 0, maxBytes: 0 };
  constructor(runtimeDirectory: string, private readonly kind = "operations") {
    this.directory = join(runtimeDirectory, kind);
  }
  path(key: string): string {
    const name = `${operationDigest(key)}.json`;
    const active = join(this.directory, name);
    const archived = join(this.directory, "archive", name);
    return existsSync(active) || !existsSync(archived) ? active : archived;
  }
  read<T>(key: string): T | undefined {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    return this.readCheckpoint<T>(path);
  }
  *readAll<T>(): Generator<T> {
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory)) {
      if (name.endsWith(".json")) yield this.readCheckpoint<T>(join(this.directory, name));
    }
    const archive = join(this.directory, "archive");
    if (existsSync(archive)) for (const name of readdirSync(archive)) {
      if (name.endsWith(".json")) yield this.readCheckpoint<T>(join(archive, name));
    }
  }
  private readCheckpoint<T>(path: string): T {
    // Invalid/truncated state is never equivalent to absence.
    const data = readFileSync(path, "utf8");
    try {
      const envelope = JSON.parse(data);
      if (envelope.version !== 1 || typeof envelope.payload !== "string"
        || operationDigest(envelope.payload) !== envelope.digest) throw new Error("invalid envelope");
      return JSON.parse(envelope.payload) as T;
    } catch {
      // JSON parser excerpts may contain prompts, tool output or credentials. Do not expose
      // checkpoint bytes or attach that parser error as a printable cause.
      throw new Error("Operation checkpoint is corrupt; retain state and reconcile before dispatch");
    }
  }
  unresolvedOwner(ownerKey: string, except: string): OperationRecord | undefined {
    if (!existsSync(this.directory)) return undefined;
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const record = this.readCheckpoint<OperationRecord>(join(this.directory, name));
      if (record.ownerKey === ownerKey && record.executionKey !== except
        && (hasNativeExecution(record) ? !nativeOperationReleased(record)
          : record.generation !== "final" && !record.physicalSettled)) return record;
    }
    return undefined;
  }
  write(key: string, record: unknown): void {
    const path = this.path(key);
    if (!existsSync(path) && existsSync(this.directory)
      && readdirSync(this.directory).filter(name => name.endsWith(".json")).length >= 4096) {
      // Older runtimes left terminal operations in active inventory. Reclaim only their proven
      // releases, once capacity is reached; tool channels require an actual live retirement.
      if (this.kind === "operations") for (const name of readdirSync(this.directory)) {
        if (!name.endsWith(".json")) continue;
        const previous = this.readCheckpoint<OperationRecord>(join(this.directory, name));
        if (previous?.version === 1 && typeof previous.executionKey === "string"
          && `${operationDigest(previous.executionKey)}.json` === name && canArchiveOperation(previous)) {
          this.archive(previous.executionKey);
        }
      }
      if (readdirSync(this.directory).filter(name => name.endsWith(".json")).length >= 4096) {
        throw new Error("Operation checkpoint capacity exhausted; owner must reconcile retained executions");
      }
    }
    const payload = JSON.stringify(record);
    const data = JSON.stringify({ version: 1, digest: operationDigest(payload), payload });
    const bytes = Buffer.byteLength(data);
    if (bytes > 16 * 1024 * 1024) throw new Error("Operation checkpoint exceeds 16 MiB; execution retained, dispatch blocked");
    atomicWriteFile(path, data, { durable: true });
    if (process.platform !== "win32") {
      // atomicWriteFile syncs the temporary file, but rename durability also needs its directory.
      const fd = openSync(dirname(path), "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    this.metrics.writes++;
    this.metrics.bytes += bytes;
    this.metrics.maxBytes = Math.max(this.metrics.maxBytes, bytes);
  }

  /** Retain the exact replay identity while removing a proven terminal owner from active admission. */
  archive(key: string): void {
    const name = `${operationDigest(key)}.json`;
    const active = join(this.directory, name);
    if (!existsSync(active)) return;
    const directory = join(this.directory, "archive");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = join(directory, name);
      if (existsSync(destination)) throw new Error("Duplicate archived operation identity");
      // Same-filesystem rename keeps either the complete active checkpoint or its complete
      // archived form readable. Archival never deletes an execution/receipt tombstone.
      renameSync(active, destination);
      if (process.platform !== "win32") for (const parent of [directory, this.directory]) {
        const fd = openSync(parent, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    } catch {
      // The durable checkpoint already exists. An optional archive failure cannot invalidate a
      // completed answer or grant dispatch; leave its current location for the next attempt.
      console.error("[chatgpt-web] terminal checkpoint archival deferred; replay identity retained");
    }
  }
}

const noticeMessages: Record<ProviderNotice["kind"], string> = {
  account_pinned: "当前执行已绑定原 ChatGPT 账号与 profile，恢复不会切换账号。",
  account_changed: "已观察到 ChatGPT 账号变更。",
  conversation_restored: "已核对并接回原 ChatGPT 会话。",
  conversation_forked: "已观察到独立的新会话分支。",
  observer_detached: "结果连接已断开，原执行仍保留，不会自动重发。",
  reconnecting: "正在只读接回原会话，不重新发送消息或工具。",
  resumed: "已只读接回原执行，继续观察原生成。",
  tool_waiting: "正在等待原工具执行结果，不会再次派发。",
  needs_reconcile: "原执行仍有未确认状态，保留现场并停止自动重发。",
};

export class DurableOperation {
  private nativeSubmissionWriteFailed = false;
  private readonly nativeReleaseWaiters = new Set<() => void>();
  private readonly nativeResultWaiters = new Set<(ready: NativeResultReady) => void>();
  private readonly noticeObservers = new Set<(notice: ProviderNotice) => void>();
  notice(kind: ProviderNotice["kind"], observedMessage?: string): ProviderNotice {
    const message = observedMessage ?? noticeMessages[kind];
    const epoch = this.record.recoveryBudget?.clock?.epoch ?? 0;
    const recoveryKey = kind === "reconnecting" || kind === "resumed"
      ? `${epoch}:${kind}:${operationDigest(message)}` : undefined;
    if (recoveryKey) {
      // Reconnecting an observer reuses the exact notice; another recovery stage or episode
      // must remain visible even when it shares the same public kind.
      const legacy = epoch === 0 ? this.record.recoveryNotices?.[kind]
        ?? this.record.notices?.find(notice => notice.kind === kind && notice.message === message) : undefined;
      const previous = this.record.recoveryNotices?.[recoveryKey]
        ?? (legacy?.message === message ? legacy : undefined);
      if (previous) return previous;
    }
    const seq = (this.record.noticeSeq ?? 0) + 1;
    const notice: ProviderNotice = { version: 1, id: `notice_${operationDigest(this.record.operationId).slice(0, 32)}_${seq}`,
      execution_id: operationDigest(this.record.executionKey), seq, kind, observed_at: new Date().toISOString(),
      message, source: "chatgpt-web", evidence: "observed" };
    this.record.noticeSeq = seq;
    if (recoveryKey) {
      this.record.recoveryNotices = { ...this.record.recoveryNotices, [recoveryKey]: notice };
    }
    this.record.notices = [...(this.record.notices ?? []), notice].slice(-32);
    this.checkpoint();
    for (const publish of this.noticeObservers) publish(notice);
    return notice;
  }
  observeNotices(publish: (notice: ProviderNotice) => void): () => void {
    this.noticeObservers.add(publish);
    for (const notice of this.record.notices ?? []) publish(notice);
    return () => { this.noticeObservers.delete(publish); };
  }

  constructor(readonly journal: OperationJournal, readonly record: OperationRecord) {
    if (hasNativeExecution(record) && !nativeOperationReleased(record)) record.physicalSettled = false;
  }
  private commitNative(update: Partial<OperationRecord>): void {
    if (this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("original identity persistence is unresolved");
    const before = structuredClone(this.record);
    Object.assign(this.record, structuredClone(update));
    try { this.checkpoint(); }
    catch {
      for (const key of Object.keys(this.record)) delete (this.record as unknown as Record<string, unknown>)[key];
      Object.assign(this.record, before);
      this.nativeSubmissionWriteFailed = true;
      throw submissionIdentityUnproven("Native execution checkpoint could not be acknowledged");
    }
  }
  nativeResultReady(value: NativeResultReady): void {
    assertNativeReady(this.record, value);
    if (this.record.nativeFinal) {
      if (!sameNative(this.record.nativeFinal, value)) throw submissionIdentityUnproven("durable final answer changed");
      if (this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("Native result persistence is unresolved");
      return;
    }
    this.commitNative({ nativeFinal: value, physicalSettled: false });
    for (const resolve of this.nativeResultWaiters) resolve(structuredClone(value));
    this.nativeResultWaiters.clear();
  }
  /** Only the original parent converts an authenticated request into physical cancellation authority. */
  nativeCancelIntent(request: NativeCancelRequest): NativeCancelIntent {
    const slot = currentNativeSlot(this.record);
    const intent: NativeCancelIntent = { ...request, scope: this.record.nativeScope!, sendId: slot.sendId, binding: slot.binding! };
    assertCancelIntent(this.record, intent);
    if (this.record.nativeCancelIntent) {
      if (!sameNative(this.record.nativeCancelIntent, intent)) throw submissionIdentityUnproven("another cancellation already owns the original Send");
      if (this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("Native cancellation persistence is unresolved");
      return structuredClone(this.record.nativeCancelIntent);
    }
    if (this.record.nativeRelease) throw submissionIdentityUnproven("the original Native owner has already released");
    this.commitNative({ nativeCancelIntent: intent, physicalSettled: false });
    return structuredClone(intent);
  }
  /** Caller must first prove this paired helper has received no Native identity frame. */
  nativePreparationCancellation(request: NativeCancelRequest, scope: NativeOperationScope): NativePreparationCancellation {
    if (this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("original identity persistence is unresolved");
    if (this.record.submission !== "prepared" || hasNativeExecution(this.record)
      || this.record.nativeSubmissions?.length || this.record.nativeScope && !sameNative(this.record.nativeScope, scope)) {
      throw submissionIdentityUnproven("preparation cancellation cannot replace an original Native execution");
    }
    assertNativeScope({ ...this.record, nativeScope: scope }, scope);
    if (!request || request.version !== 1 || request.source !== "native_interrupt"
      || !nativeUuid.test(request.cancelId) || !nativeTime(request.requestedAt)
      || !scope.threadId || request.threadId !== scope.threadId || request.turnId !== scope.turnId) {
      throw submissionIdentityUnproven("preparation cancellation lacks the original explicit request identity");
    }
    const value: NativePreparationCancellation = { version: 1, scope: structuredClone(scope), request: structuredClone(request) };
    if (this.record.nativePreparationCancel) {
      if (!sameNative(this.record.nativePreparationCancel, value)) throw submissionIdentityUnproven("original preparation cancellation changed");
      return structuredClone(this.record.nativePreparationCancel);
    }
    // This records cancellation intent, not physical release. Only the paired helper's
    // never-attempted ordinary end can settle this prepared execution.
    Object.assign(this.record, { nativePreparationCancel: value,
      error: { code: "client_cancelled", retryable: false }, physicalSettled: false });
    try { this.checkpoint(); }
    catch {
      // An uncertain write grants no cancellation ACK. Keep the attempted cancellation
      // as a local activation fence; do not roll it back and accept a late first slot.
      this.nativeSubmissionWriteFailed = true;
      this.record.recovery = "retained";
      throw submissionIdentityUnproven("preparation cancellation persistence is unresolved");
    }
    return structuredClone(value);
  }
  nativeCancelTerminal(value: NativeCancelTerminal): void {
    assertCancelTerminal(this.record, value);
    if (this.record.nativeCancelTerminal && !sameNative(this.record.nativeCancelTerminal, value)) {
      throw submissionIdentityUnproven("durable cancellation terminal changed");
    }
    if (this.record.nativeCancelTerminal && !this.nativeSubmissionWriteFailed) return;
    this.commitNative({ nativeCancelTerminal: value });
  }
  /** Caller verifies this receipt through the exact Host metadata-only API before invoking us. */
  nativeRelease(value: NativeReleaseReceipt): void {
    assertNativeRelease(this.record, value);
    if (this.record.nativeRelease && !sameNative(this.record.nativeRelease, value)) {
      throw submissionIdentityUnproven("original Host release receipt changed");
    }
    if (!this.record.nativeRelease || this.nativeSubmissionWriteFailed) this.commitNative({ nativeRelease: value, physicalSettled: true });
    for (const resolve of this.nativeReleaseWaiters) resolve();
    this.nativeReleaseWaiters.clear();
  }
  validateNativeRelease(value: NativeReleaseReceipt): void {
    if (this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("original release persistence is unresolved");
    assertNativeRelease(this.record, value);
  }
  nativeReleaseQueryContext(): { scope: NativeOperationScope; slot: NativeSubmissionRecord;
    authorization: { resultReadyDigest: string } | { cancelId: string; terminalDigest: string; intentDigest: string } } {
    if (this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("original metadata persistence is unresolved");
    const slot = currentNativeSlot(this.record);
    if (this.record.nativeFinal) {
      assertNativeReady(this.record, this.record.nativeFinal);
      return { scope: structuredClone(this.record.nativeScope!), slot,
        authorization: { resultReadyDigest: operationDigest(JSON.stringify(this.record.nativeFinal)) } };
    }
    if (this.record.nativeCancelTerminal) {
      assertCancelTerminal(this.record, this.record.nativeCancelTerminal);
      return { scope: structuredClone(this.record.nativeScope!), slot,
        authorization: { cancelId: this.record.nativeCancelIntent!.cancelId,
          terminalDigest: operationDigest(JSON.stringify(this.record.nativeCancelTerminal)),
          intentDigest: operationDigest(JSON.stringify(this.record.nativeCancelIntent)) } };
    }
    throw submissionIdentityUnproven("no durable credential for original release metadata");
  }
  hasNativeRelease(): boolean {
    return !this.nativeSubmissionWriteFailed && hasNativeExecution(this.record) && nativeOperationReleased(this.record);
  }
  waitForNativeRelease(): Promise<void> {
    if (this.hasNativeRelease()) return Promise.resolve();
    return new Promise(resolve => this.nativeReleaseWaiters.add(resolve));
  }
  waitForNativeResultReady(): Promise<NativeResultReady> {
    if (this.record.nativeFinal) {
      try { return Promise.resolve(this.nativeFinalFor(this.record.nativeScope!)); }
      catch (error) { return Promise.reject(error); }
    }
    return new Promise(resolve => this.nativeResultWaiters.add(resolve));
  }
  nativeFinalFor(scope: NativeOperationScope): NativeResultReady {
    assertNativeScope(this.record, scope);
    const ready = this.record.nativeFinal;
    if (!ready || this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("the original scoped final is not durably ready");
    assertNativeReady(this.record, ready);
    return structuredClone(ready);
  }
  checkpoint(): void {
    if (this.record.nativePreparationCancel) {
      // A later generic helper error must not turn an explicit cancellation into a
      // retryable prepared failure. Physical settlement remains independently proven.
      this.record.error = { ...this.record.error, code: "client_cancelled", retryable: false };
    }
    this.record.seq++;
    this.record.updatedAt = Date.now();
    this.journal.write(this.record.executionKey, this.record);
    if (!this.nativeSubmissionWriteFailed && canArchiveOperation(this.record)) {
      this.journal.archive(this.record.executionKey);
    }
  }
  freezeRecoveryBudget(timeoutMs?: number): void {
    if (this.record.recoveryBudget) {
      const budget = this.record.recoveryBudget;
      if (!budget.clock && budget.used === 0) {
        budget.clock = { allowanceMs: CHATGPT_RECOVERY_TIME_ALLOWANCE_MS, spentMs: 0, epoch: 0 };
        this.checkpoint();
      }
      return;
    }
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("Operation timeout must be positive and finite");
    }
    const startedAt = this.record.startedAt;
    if (startedAt === undefined || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
      throw new ChatGptWebAdapterError("The original operation start is unproven; retain execution without granting a new recovery deadline.", {
        status: 409, errorType: "server_error", code: "chatgpt_recovery_budget_missing", retryable: false,
      });
    }
    this.record.recoveryBudget = {
      version: 1, limit: 3, used: Math.max(0, this.record.attempt - 1), startedAt, attempts: [],
      clock: { allowanceMs: CHATGPT_RECOVERY_TIME_ALLOWANCE_MS, spentMs: 0, epoch: 0 },
      ...(timeoutMs !== undefined ? { deadlineAt: Math.floor(startedAt + timeoutMs) } : {}),
    };
    this.checkpoint();
  }
  recoveryAvailable(now = Date.now()): boolean {
    const budget = this.record.recoveryBudget;
    const clock = budget?.clock;
    const retryablePreSend = this.record.submission === "prepared"
      && this.record.error?.retryable === true && !hasNativeExecution(this.record);
    return !!clock && clock.allowanceMs === CHATGPT_RECOVERY_TIME_ALLOWANCE_MS
      && Number.isSafeInteger(clock.spentMs) && clock.spentMs >= 0 && clock.spentMs < clock.allowanceMs
      && Number.isSafeInteger(clock.epoch) && clock.epoch >= 0
      && (!clock.active || Number.isSafeInteger(clock.active.startedAt) && Number.isSafeInteger(clock.active.deadlineAt)
        && clock.active.deadlineAt === clock.active.startedAt + clock.allowanceMs - clock.spentMs
        && now < clock.active.deadlineAt)
      && !!budget && budget.version === 1 && budget.limit === 3
      && Number.isSafeInteger(budget.used) && budget.used >= 0 && budget.used < budget.limit
      && Number.isSafeInteger(budget.startedAt) && budget.startedAt > 0
      && (budget.deadlineAt === undefined || Number.isSafeInteger(budget.deadlineAt)
        && budget.deadlineAt > budget.startedAt && now < budget.deadlineAt)
      && Array.isArray(budget.attempts) && budget.attempts.length <= budget.used
      && this.record.generation !== "final" && (!this.record.physicalSettled || retryablePreSend)
      && this.record.error?.code !== "client_cancelled";
  }
  reserveRecovery(reason: RecoveryReason, now = Date.now()): void {
    if (!this.recoveryAvailable(now)) throw new ChatGptWebAdapterError(
      "The original operation's shared recovery budget is exhausted; execution and receipts remain retained.",
      { status: 503, errorType: "server_error", code: "chatgpt_recovery_budget_exhausted", retryable: false },
    );
    const budget = this.record.recoveryBudget!;
    const clock = budget.clock!;
    if (!clock.active) {
      clock.epoch++;
      clock.active = { startedAt: now, deadlineAt: now + clock.allowanceMs - clock.spentMs };
    }
    budget.used++;
    budget.attempts.push({ at: now, reason });
    this.checkpoint();
  }
  recoveryState(): { epoch: number; deadlineAt?: number } {
    const clock = this.record.recoveryBudget?.clock;
    return { epoch: clock?.epoch ?? 0, ...(clock?.active ? { deadlineAt: clock.active.deadlineAt } : {}) };
  }
  confirmRecovery(epoch: number, now = Date.now()): void {
    const budget = this.record.recoveryBudget;
    const clock = budget?.clock;
    if (!clock?.active || clock.epoch !== epoch || now < clock.active.startedAt
      || now >= clock.active.deadlineAt || (budget?.deadlineAt !== undefined && now >= budget.deadlineAt)
      || this.record.error?.code === "client_cancelled") {
      throw new ChatGptWebAdapterError("Recovery completion has no current unexpired identity-bound episode; execution remains retained.", {
        status: 409, errorType: "server_error", code: "chatgpt_recovery_budget_exhausted", retryable: false,
      });
    }
    clock.spentMs += now - clock.active.startedAt;
    delete clock.active;
    this.checkpoint();
  }
  assertNativeObservation(checkpoint: BrowserObservationCheckpoint): void {
    if (checkpoint.version !== 2) return;
    const native = parseNativeSubmission(checkpoint.submission.native);
    const original = this.record.nativeSubmissions?.at(-1);
    if (!original || original.sendId !== native.sendId || !nativeSubmissionDescendsFrom(native, original)) {
      throw submissionIdentityUnproven("checkpoint differs from the current durable physical Send");
    }
  }
  /** Native preparation grants no dispatch and writes no execution state. */
  prepareNativeSubmission(scope: NativeOperationScope): void {
    if (this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("original identity persistence is unresolved");
    if (this.record.nativePreparationCancel) throw nativePreparationCancelledError();
    if (this.record.submission !== "prepared" || hasNativeExecution(this.record)
      || this.record.nativeScope && !sameNative(this.record.nativeScope, scope)) {
      throw submissionIdentityUnproven("the original Native execution cannot be prepared again");
    }
    assertNativeScope({ ...this.record, nativeScope: scope }, scope);
    this.assertSendDeadline();
  }
  nativeSubmission(value: NativeSubmissionRecord, scope?: NativeOperationScope): void {
    if (this.nativeSubmissionWriteFailed) throw submissionIdentityUnproven("original identity persistence is unresolved");
    if (this.record.nativePreparationCancel) throw nativePreparationCancelledError();
    const next = parseNativeSubmission(value);
    if (scope) {
      if (this.record.nativeScope && !sameNative(this.record.nativeScope, scope)) throw submissionIdentityUnproven("Native submission scope changed");
      assertNativeScope({ ...this.record, nativeScope: scope }, scope);
      if (!next.binding || next.binding.stage.kind !== "final" || next.binding.roundKey !== scope.roundKey) {
        throw submissionIdentityUnproven("Native submission is not the original final round");
      }
    }
    if (this.record.nativeRelease || this.record.nativeCancelTerminal
      && this.record.nativeCancelTerminal.proof !== "same-bound-generation-completed") {
      if (sameNative(this.record.nativeSubmissions?.at(-1), next)) return;
      throw submissionIdentityUnproven("the original physical slot is already terminal");
    }
    const slots = structuredClone(this.record.nativeSubmissions ?? []);
    const index = slots.findIndex(slot => slot.sendId === next.sendId);
    if (index < 0) {
      if (scope) {
        this.prepareNativeSubmission(scope);
        if (slots.length || next.phase !== "send_activated" || next.revision !== 1) {
          throw submissionIdentityUnproven("Native activation requires the original first slot");
        }
        // The paired helper cannot click until this exact slot is durably ACKed. Do not
        // leave a separate activated checkpoint without its original identity.
        Object.assign(this.record, { nativeScope: structuredClone(scope), nativeSubmissions: [next],
          submission: "send_activated", generation: "unknown", physicalSettled: false });
        try { this.checkpoint(); }
        catch {
          // A write may have committed before fsync/return failed. Preserve the attempted
          // slot and poison ACKs; rolling back to prepared would invent retry authority.
          this.nativeSubmissionWriteFailed = true;
          this.record.recovery = "retained";
          throw submissionIdentityUnproven("durable Native activation write is unresolved");
        }
        return;
      }
      const previous = slots.at(-1);
      if (next.phase !== "send_activated" || next.revision !== 1 || this.record.submission !== "send_activated"
        || previous && !(previous.phase === "completed" && next.binding && previous.binding
          && next.binding.roundKey !== previous.binding.roundKey)) {
        throw submissionIdentityUnproven("unowned physical Send or unresolved previous stage");
      }
      slots.push(next);
    } else {
      const previous = slots[index]!;
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      const expected = previous.phase === "send_activated" ? previous.binding ? "watch_ready" : "post_observed"
        : previous.phase === "watch_ready" ? "post_observed"
        : previous.phase === "post_observed" ? "accepted"
        : previous.phase === "accepted" ? previous.binding?.stage.kind === "final" ? "completed" : "stage_acknowledged" : undefined;
      const previousBinding = previous.binding && { ...previous.binding,
        documentEpoch: previous.phase === "send_activated" ? next.binding?.documentEpoch : previous.binding.documentEpoch };
      if (index !== slots.length - 1 || next.revision !== previous.revision + 1
        || (next.phase !== expected && next.phase !== "conflict")
        || JSON.stringify(previousBinding) !== JSON.stringify(next.binding)
        || previous.expectedConversationId !== next.expectedConversationId
        || previous.hostWatch && (!next.hostWatch || previous.hostWatch.sessionEpoch !== next.hostWatch.sessionEpoch
          || previous.hostWatch.seq > next.hostWatch.seq)
        || JSON.stringify(previous.initialTurnIdentities) !== JSON.stringify(next.initialTurnIdentities)
        || previous.post && JSON.stringify(previous.post) !== JSON.stringify(next.post)
        || previous.dom && JSON.stringify(previous.dom) !== JSON.stringify(next.dom)) {
        throw submissionIdentityUnproven("durable physical Send identity changed");
      }
      slots[index] = next;
    }
    const previous = this.record.nativeSubmissions;
    this.record.nativeSubmissions = slots;
    try { this.checkpoint(); }
    catch {
      this.record.nativeSubmissions = previous;
      this.nativeSubmissionWriteFailed = true;
      throw submissionIdentityUnproven("durable original identity write failed");
    }
  }
  private assertSendDeadline(): void {
    const budget = this.record.recoveryBudget;
    const deadline = Math.min(budget?.deadlineAt ?? Infinity, budget?.clock?.active?.deadlineAt ?? Infinity);
    if (deadline !== undefined && Date.now() >= deadline) throw new ChatGptWebAdapterError(
      "The original operation deadline is exhausted before Send; execution remains retained.",
      { status: 503, errorType: "server_error", code: "chatgpt_recovery_budget_exhausted", retryable: false },
    );
  }
  beforeSend(): void {
    if (this.record.nativePreparationCancel) throw nativePreparationCancelledError();
    this.assertSendDeadline();
    // Multipart sends belong to this one live owner; a new runtime never invokes this method.
    this.record.submission = "send_activated";
    this.record.generation = "unknown";
    this.checkpoint();
  }
  accepted(): void {
    if (this.record.nativePreparationCancel) throw nativePreparationCancelledError();
    this.record.submission = "accepted";
    this.record.generation = "running";
    this.checkpoint();
  }
  receipt(): Record<string, unknown> {
    const r = this.record;
    return { version: r.version, operationId: r.operationId, executionId: operationDigest(r.executionKey),
      traceId: r.traceId, threadId: r.threadId && operationDigest(r.threadId),
      turnId: r.turnId && operationDigest(r.turnId), requestIds: r.requestIds,
      submission: r.submission, generation: r.generation, delivery: r.delivery,
      recovery: r.recovery, seq: r.seq, attempt: r.attempt,
      ...(r.error ? { error: r.error } : {}) };
  }
}
