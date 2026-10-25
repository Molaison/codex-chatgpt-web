import type { BrowserObservationCheckpoint } from "./observation-recovery";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync } from "node:fs";
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
export interface OperationRecord {
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
  rounds: Record<string, OperationRound>;
  final?: { answer: string; events: AdapterEvent[]; reasoning: string[] };
  error?: { code?: string; retryable?: boolean; diagnostics?: Record<string, unknown> };
}

export function retainedOperationError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("The original execution is retained and needs reconciliation by its runtime owner; reconnect will not send or dispatch it again.", {
    status: 409, errorType: "server_error", code: "chatgpt_execution_retained", retryable: false,
  });
}

/** Private checkpoints, not another permission authority. One existing role runtime owns writes. */
export class OperationJournal {
  readonly directory: string;
  readonly metrics = { writes: 0, bytes: 0, maxBytes: 0 };
  constructor(runtimeDirectory: string, kind = "operations") {
    this.directory = join(runtimeDirectory, kind);
  }
  path(key: string): string { return join(this.directory, `${operationDigest(key)}.json`); }
  read<T>(key: string): T | undefined {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    return this.readCheckpoint<T>(path);
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
        && record.generation !== "final" && !record.physicalSettled) return record;
    }
    return undefined;
  }
  write(key: string, record: unknown): void {
    if (!existsSync(this.path(key)) && existsSync(this.directory)
      && readdirSync(this.directory).filter(name => name.endsWith(".json")).length >= 4096) {
      throw new Error("Operation checkpoint capacity exhausted; owner must reconcile retained executions");
    }
    const payload = JSON.stringify(record);
    const data = JSON.stringify({ version: 1, digest: operationDigest(payload), payload });
    const bytes = Buffer.byteLength(data);
    if (bytes > 16 * 1024 * 1024) throw new Error("Operation checkpoint exceeds 16 MiB; execution retained, dispatch blocked");
    atomicWriteFile(this.path(key), data, { durable: true });
    if (process.platform !== "win32") {
      // atomicWriteFile syncs the temporary file, but rename durability also needs its directory.
      const fd = openSync(this.directory, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    this.metrics.writes++;
    this.metrics.bytes += bytes;
    this.metrics.maxBytes = Math.max(this.metrics.maxBytes, bytes);
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
  private readonly noticeObservers = new Set<(notice: ProviderNotice) => void>();
  notice(kind: ProviderNotice["kind"], observedMessage?: string): ProviderNotice {
    const seq = (this.record.noticeSeq ?? 0) + 1;
    const notice: ProviderNotice = { version: 1, id: `notice_${operationDigest(this.record.operationId).slice(0, 32)}_${seq}`,
      execution_id: operationDigest(this.record.executionKey), seq, kind, observed_at: new Date().toISOString(),
      message: observedMessage ?? noticeMessages[kind], source: "chatgpt-web", evidence: "observed" };
    this.record.noticeSeq = seq;
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

  constructor(readonly journal: OperationJournal, readonly record: OperationRecord) {}
  checkpoint(): void {
    this.record.seq++;
    this.record.updatedAt = Date.now();
    this.journal.write(this.record.executionKey, this.record);
  }
  beforeSend(): void {
    // Multipart sends belong to this one live owner; a new runtime never invokes this method.
    this.record.submission = "send_activated";
    this.record.generation = "unknown";
    this.checkpoint();
  }
  accepted(): void {
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
