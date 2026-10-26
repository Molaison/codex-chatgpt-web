import { createHash } from "node:crypto";
import type { NativeSubmissionBinding } from "./submission-identity";

export interface NativeOperationScope {
  operationId: string; executionKey: string; roundKey: string;
  threadId?: string; turnId: string; traceId: string;
}
export interface NativeCancelRequest {
  version: 1; cancelId: string; source: "native_interrupt";
  threadId: string; turnId: string; requestedAt: number;
}
/** Created only by an authenticated explicit user cancellation entry. */
export class ExplicitNativeCancellation extends DOMException {
  constructor(readonly request: NativeCancelRequest, readonly intent?: NativeCancelIntent, readonly preparation?: NativePreparationCancellation) {
    super("Explicit cancellation of the original Native turn", "AbortError");
  }
}
export interface NativePreparationCancellation { version:1;scope:NativeOperationScope;request:NativeCancelRequest; }
export interface NativeCancelIntent extends NativeCancelRequest {
  scope: NativeOperationScope; sendId: string; binding: NativeSubmissionBinding;
}
export interface NativeCancelTerminal {
  cancelId: string; sendId: string; sessionEpoch: string; watchSeq: number;
  proof: "same-bound-generation-stopped" | "same-bound-generation-completed" | "not_dispatched";
  assistantIdentity?: string; observedAt: number; dispatchAttempted: boolean;
}
export interface NativeResultReady {
  version: 1; scope: NativeOperationScope; sendId: string;
  completedDigest: string; answer: string; answerSha256: string; readyAt: number;
}
export interface NativeReleaseReceipt {
  version: 1; releaseId: string; sendId: string; roundKey: string; sessionEpoch: string;
  host: NativeSubmissionBinding["host"]; lease: NativeSubmissionBinding["lease"];
  documentEpoch: string; outcome: "completed" | "cancelled"; terminalDigest: string;
}

export const nativeExecutionDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type NativeExecutionEvent = "native_result_ready" | "native_release" | "native_cancel_terminal";
export type NativeExecutionPayload = NativeResultReady | NativeReleaseReceipt | NativeCancelTerminal;
