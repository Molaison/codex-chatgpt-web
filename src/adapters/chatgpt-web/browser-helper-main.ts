import { NativeMetadataAcknowledgement } from "./native-metadata-ack";
import { nativeExecutionDigest, ExplicitNativeCancellation, type NativeExecutionEvent, type NativeExecutionPayload, type NativePreparationCancellation, type NativeOperationScope, type NativeCancelIntent, type NativeResultReady, type NativeReleaseReceipt, type NativeCancelTerminal } from "./native-execution";
import { nativeSubmissionDigest, parseNativeSubmission } from "./submission-identity";
import { CHATGPT_RECOVERY_TIME_ALLOWANCE_MS } from "./retry-policy";
import { BrowserObservationDetached, parseBrowserObservation, type BrowserObservationCheckpoint, type BrowserObservationIdentity } from "./observation-recovery";
import { validateSkillFiles } from "./skill-attachments";
import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import type { CodexProviderConfig } from "../../types";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "./browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, parseChatGptSavedConversationDiagnostics } from "./adapter-error";
import type { ChatGptWebCapabilities } from "./model";
import { createProcessLineWriter } from "./process-line-writer";
import { createBrowserHelperPromptSelection } from "./browser-helper-prompt-selection";
import { isChatGptWebMultipartPartCount, type CompiledChatGptWebPrompt } from "./prompt";
import { ChatGptMirroredTurnProgress } from "./turn-progress";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";

interface RunMessage {
  type: "run";
  id: string;
  config: {
    accountId?: string;
    conversationStoreDirectory?: string;
    imageOutputDirectory?: string;
    downloadDirectory?: string;
    downloadBaseUrl?: string;
    appName: string;
    browserHostDescriptorPath: string;
    browserDiagnosticsPath?: string;
    turnTimeoutMs: number;
    autoApproveToolCalls: boolean;
    standardConcurrencyLimit?: number;
    proConcurrencyLimit?: number;
  };
  turn: {
    traceId: string;
    modelId: string;
    observationIdentity?: BrowserObservationIdentity;
    observation?: BrowserObservationCheckpoint;
    observationToolFence?: BrowserTurn["observationToolFence"];
    observationNotices?: boolean;
    contextRecovery?: boolean;
    recoveryDeadlineAt?: number;
    recoveryState?: BrowserTurn["recoveryState"];
    nativeSubmissionIdentity?: boolean;
    nativeSubmissionRoundKey?: string;
    nativeOperationScope?: NativeOperationScope;
    nativeObservationSubmission?: BrowserTurn["nativeObservationSubmission"];
    project?: BrowserTurn["project"];
    sessionMode?: BrowserTurn["sessionMode"];
    deferTextUntilComplete?: BrowserTurn["deferTextUntilComplete"];
    reasoning?: string;
    modelFamily?: "5.6" | "6";
    proModel?: boolean;
    capabilities: ChatGptWebCapabilities;
    nativeConnector?: boolean;
    resumeAvailable?: boolean;
    retainConversation?: boolean;
    requireRetainedConversation?: boolean;
    conversationKey?: string;
    canonicalHistory?: string[];
    instructionFingerprint?: string;
    compaction?: boolean;
    captureLunaCheckpoint?: boolean;
    externalProgress?: boolean;
    submissionAck?: boolean;
    browserLeaseEvents?: boolean;
  };
}

interface VerifyMessage {
  type: "verify";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
  };
}

interface InspectMessage {
  type: "inspect";
  id: string;
  config: VerifyMessage["config"];
  detectCapabilities: boolean;
}

interface SmokeMessage {
  type: "smoke";
  id: string;
  config: VerifyMessage["config"];
}

interface LimitsMessage {
  type: "limits";
  id: string;
  config: VerifyMessage["config"];
}

type MaintenanceMessage = VerifyMessage | InspectMessage | SmokeMessage | LimitsMessage;
type InputMessage = RunMessage
  | MaintenanceMessage
  | { type: "prepared_selected_ack"; id: string; prepared: CompiledChatGptWebPrompt }
  | { type: "send_activation_ack"; id: string }
  | { type: "native_submission_ack"; id: string; sendId: string; revision: number; digest: string }
  | { type: "native_execution_ack"; id: string; event: NativeExecutionEvent; requestId: number; digest: string }
  | { type: "submission_ack"; id: string }
  | { type: "observation_ready_ack"; id: string; digest?:string }
  | { type: "recovery_fence_ack"; id: string; allowed: boolean; requestId?: number; recoveryState?: BrowserTurn["recoveryState"] }
  | { type: "completion_fence_begin_ack"; id: string; requestId: number; revision: number | null }
  | { type: "completion_fence_commit_ack"; id: string; requestId: number; committed: boolean }
  | { type: "progress"; id: string; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "abort"; id: string; reason?: "compaction_handoff_accepted" | "recovery_budget_retained" | "native_interrupt" | "native_preparation_cancel"; intent?: NativeCancelIntent;preparation?:NativePreparationCancellation }
  | { type: "shutdown" };

let outputFailure: Error | undefined;
const handleOutputFailure = (error: Error): void => {
  if (outputFailure) return;
  outputFailure = error;
  void requestShutdown(true);
};
const protocolOutput = createProcessLineWriter(stdout, handleOutputFailure);
const diagnosticOutput = createProcessLineWriter(stderr, handleOutputFailure);

const writeProtocol = (message: unknown): boolean => protocolOutput.write(JSON.stringify(message));

const diagnostic = (...values: unknown[]): void => {
  diagnosticOutput.write(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
};
console.info = diagnostic;
console.warn = diagnostic;
console.error = diagnostic;

const abortControllers = new Map<string, AbortController>();
const turnProgress = new Map<string, ChatGptMirroredTurnProgress>();
const preparedSelections = new Map<string, ReturnType<typeof createBrowserHelperPromptSelection>>();
const sendActivationWaiters = new Map<string, {
  nativeRevision?: number;
  nativeSendId?: string;
  nativeDigest?: string;
  resolve: () => void;
  reject: (error: Error) => void;
}>();
const submissionWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
const completionFenceBeginWaiters = new Map<string, {
  requestId: number;
  resolve: (revision: number | undefined) => void;
  reject: (error: Error) => void;
}>();
const completionFenceCommitWaiters = new Map<string, {
  requestId: number;
  resolve: (committed: boolean) => void;
  reject: (error: Error) => void;
}>();
const recoveryWaiters = new Map<string, { requestId: number; resolve(value: { allowed: boolean; recoveryState?: BrowserTurn["recoveryState"] }): void; reject(error: Error): void }>();
let recoveryFenceRequestId = 0;
let completionFenceRequestId = 0;
const observationWaiters = new Map<string, { digest?:string;resolve(): boolean; reject(error: Error): void }>();
const durableObservations = new Set<string>();
const recoverableAccepted = new Set<string>();
const nativeTurns = new Set<string>();
const nativeScopes = new Map<string, NativeOperationScope>();
const nativeExecutionWaiters = new Map<string, {event:NativeExecutionEvent;requestId:number;digest:string;resolve():void;reject(error:Error):void}>();
let nativeExecutionRequestId = 0;
function persistNativeExecution(id:string,event:NativeExecutionEvent,payload:NativeExecutionPayload):Promise<void> {
  if(nativeExecutionWaiters.has(id))return Promise.reject(new Error("Native execution acknowledgement already pending"));
  const requestId=++nativeExecutionRequestId,digest=nativeExecutionDigest(payload);
  const ack=new NativeMetadataAcknowledgement({type:"event",id,event,payload,requestId,digest},frame=>writeProtocol(frame));
  nativeExecutionWaiters.set(id,{event,requestId,digest,resolve:()=>ack.resolve(),reject:error=>ack.reject(error)});
  return ack.promise.finally(()=>{if(nativeExecutionWaiters.get(id)?.requestId===requestId)nativeExecutionWaiters.delete(id);});
}
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

function requestShutdown(observerLost = false): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  let completeShutdown!: () => void;
  shutdownPromise = new Promise<void>(resolveShutdown => {
    completeShutdown = resolveShutdown;
  });
  shuttingDown = true;
  protocolOutput.close();
  diagnosticOutput.close();
  for (const [id, controller] of abortControllers) controller.abort(
    (nativeTurns.has(id) || observerLost && recoverableAccepted.has(id)) ? new BrowserObservationDetached("Runtime observation pipe closed or helper teardown") : undefined);
  for (const waiter of nativeExecutionWaiters.values()) waiter.reject(new Error("Native execution pipe closed before ACK"));
  nativeExecutionWaiters.clear();
  for (const waiter of observationWaiters.values()) waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  observationWaiters.clear();
  for (const selection of preparedSelections.values()) selection.cancel();
  preparedSelections.clear();
  for (const waiter of sendActivationWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  sendActivationWaiters.clear();
  for (const waiter of submissionWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  submissionWaiters.clear();
  for (const waiter of completionFenceBeginWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  completionFenceBeginWaiters.clear();
  for (const waiter of completionFenceCommitWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  completionFenceCommitWaiters.clear();
  for (const waiter of recoveryWaiters.values()) waiter.reject(new Error("Browser helper shut down during recovery"));
  recoveryWaiters.clear();
  input.close();
  void closeChatGptBrowserWorkers().then(
    () => {
      completeShutdown();
      process.exit(0);
    },
    error => {
      diagnostic(`Browser helper shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      completeShutdown();
      process.exit(1);
    },
  );
  return shutdownPromise;
}

async function run(message: RunMessage): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id) || message.id !== message.turn.traceId) {
    throw new Error("Browser helper turn identity is invalid");
  }
  if (abortControllers.has(message.id)) throw new Error(`Browser helper turn already exists: ${message.id}`);
  if (message.turn.recoveryDeadlineAt !== undefined && (!Number.isSafeInteger(message.turn.recoveryDeadlineAt) || message.turn.recoveryDeadlineAt <= 0)) {
    throw new Error("Browser helper recovery deadline is invalid");
  }
  const recoveryState = message.turn.recoveryState;
  if (recoveryState && (!Number.isSafeInteger(recoveryState.epoch) || recoveryState.epoch < 0
    || recoveryState.deadlineAt !== undefined && (!Number.isSafeInteger(recoveryState.deadlineAt) || recoveryState.deadlineAt <= 0))) {
    throw new Error("Invalid recovery clock state");
  }
  if (message.turn.resumeAvailable !== undefined && typeof message.turn.resumeAvailable !== "boolean") {
    throw new Error("Browser helper resume availability is invalid");
  }
  if (message.turn.canonicalHistory !== undefined && (!Array.isArray(message.turn.canonicalHistory)
    || !message.turn.canonicalHistory.length || message.turn.canonicalHistory.some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)))) {
    throw new Error("Browser helper canonical history witness is invalid");
  }
  if (message.turn.instructionFingerprint !== undefined && (typeof message.turn.instructionFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(message.turn.instructionFingerprint))) {
    throw new Error("Browser helper instruction fingerprint is invalid");
  }
  if (message.turn.nativeConnector !== undefined && typeof message.turn.nativeConnector !== "boolean") {
    throw new Error("Browser helper native connector flag is invalid");
  }
  if (message.turn.retainConversation !== undefined && typeof message.turn.retainConversation !== "boolean") {
    throw new Error("Browser helper conversation retention flag is invalid");
  }
  if (message.turn.requireRetainedConversation !== undefined
    && typeof message.turn.requireRetainedConversation !== "boolean") {
    throw new Error("Browser helper retained-conversation requirement is invalid");
  }
  if (message.turn.conversationKey !== undefined && !/^[a-f0-9]{64}$/.test(message.turn.conversationKey)) {
    throw new Error("Browser helper conversation key is invalid");
  }
  if (message.turn.compaction !== undefined && typeof message.turn.compaction !== "boolean") {
    throw new Error("Browser helper compaction flag is invalid");
  }
  if (message.turn.captureLunaCheckpoint !== undefined && typeof message.turn.captureLunaCheckpoint !== "boolean") {
    throw new Error("Browser helper Luna checkpoint flag is invalid");
  }
  if (message.turn.externalProgress !== undefined && typeof message.turn.externalProgress !== "boolean") {
    throw new Error("Browser helper external progress flag is invalid");
  }
  if ([message.turn.submissionAck, message.turn.browserLeaseEvents].some(flag => flag !== undefined && typeof flag !== "boolean")) {
    throw new Error("Browser helper lifecycle acknowledgement flags are invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      appName: message.config.appName,
      browserHost: "launcher",
      accountId: message.config.accountId,
      conversationStoreDirectory: message.config.conversationStoreDirectory,
      imageOutputDirectory: message.config.imageOutputDirectory,
      downloadDirectory: message.config.downloadDirectory,
      downloadBaseUrl: message.config.downloadBaseUrl,
      browserHostDescriptorPath: message.config.browserHostDescriptorPath,
      browserDiagnosticsPath: message.config.browserDiagnosticsPath,
      turnTimeoutMs: message.config.turnTimeoutMs,
      autoApproveToolCalls: message.config.autoApproveToolCalls,
      standardConcurrencyLimit: message.config.standardConcurrencyLimit,
      proConcurrencyLimit: message.config.proConcurrencyLimit,
    },
  };
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  // The Codex MCP broker runs in the daemon process, so this mirror is the only way the worker can
  // observe that a turn is still executing while its ChatGPT DOM is unavailable. Trace ids are
  // derived deterministically and can repeat, so each run starts a fresh mirror rather than
  // inheriting revisions recorded for an earlier turn that happened to share the id.
  const progress = message.turn.externalProgress
    ? new ChatGptMirroredTurnProgress(revision => {
      if (!writeProtocol({ type: "event", id: message.id, event: "tool_batch_observed", revision })) {
        throw new Error("Browser helper could not acknowledge the observed Codex tool boundary");
      }
    })
    : undefined;
  if (progress) turnProgress.set(message.id, progress);
  let promptSelection = createBrowserHelperPromptSelection();
  preparedSelections.set(message.id, promptSelection);
  const prepareSelected = async () => ({ ...await promptSelection.wait(), release: () => {} });
  if (message.turn.nativeSubmissionIdentity) {
    nativeTurns.add(message.id);
    if(message.turn.nativeOperationScope)nativeScopes.set(message.id,message.turn.nativeOperationScope);
  }
  const turn: BrowserTurn = {
    traceId: message.turn.traceId,
    modelId: message.turn.modelId,
    recoveryDeadlineAt: message.turn.recoveryDeadlineAt,
    recoveryState: message.turn.recoveryState,
    nativeSubmissionIdentity: message.turn.nativeSubmissionIdentity,
    nativeSubmissionRoundKey: message.turn.nativeSubmissionRoundKey,
    nativeOperationScope: message.turn.nativeOperationScope,
    nativeObservationSubmission: message.turn.nativeObservationSubmission,
    ...(message.turn.observation ? { observation: parseBrowserObservation(message.turn.observation),
      observationToolFence: message.turn.observationToolFence } : {}),
    ...(message.turn.observationIdentity ? { observationIdentity: message.turn.observationIdentity,
      onObservationReady: (checkpoint: BrowserObservationCheckpoint) => {
        const digest=message.turn.nativeSubmissionIdentity?nativeExecutionDigest(checkpoint):undefined;
        const ack=new NativeMetadataAcknowledgement({type:"event",id:message.id,event:"observation_ready",checkpoint,...(digest?{digest}:{})},frame=>writeProtocol(frame));
        const waiter={digest,resolve:()=>ack.resolve(),reject:(error:Error)=>ack.reject(error)};
        observationWaiters.set(message.id,waiter);
        return ack.promise.finally(()=>{if(observationWaiters.get(message.id)===waiter)observationWaiters.delete(message.id);});
      },
    } : {}),
    ...(message.turn.project ? { project: message.turn.project } : {}),
    ...(message.turn.sessionMode ? { sessionMode: message.turn.sessionMode } : {}),
    ...(message.turn.deferTextUntilComplete ? { deferTextUntilComplete: true } : {}),
    reasoning: message.turn.reasoning,
    ...(message.turn.modelFamily ? { modelFamily: message.turn.modelFamily } : {}),
    ...(message.turn.proModel ? { proModel: true } : {}),
    capabilities: message.turn.capabilities,
    ...(message.turn.nativeConnector ? { nativeConnector: true } : {}),
    prepare: prepareSelected,
    ...(message.turn.resumeAvailable ? { prepareResume: prepareSelected } : {}),
    ...(message.turn.retainConversation ? { retainConversation: true } : {}),
    ...(message.turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
    ...(message.turn.conversationKey ? { conversationKey: message.turn.conversationKey } : {}),
    ...(message.turn.canonicalHistory ? { canonicalHistory: message.turn.canonicalHistory } : {}),
    ...(message.turn.instructionFingerprint ? { instructionFingerprint: message.turn.instructionFingerprint } : {}),
    abortSignal: abortController.signal,
    ...(message.turn.compaction ? { compaction: true } : {}),
    ...(progress ? {
      externalProgress: progress,
      completionFence: {
        begin: () => new Promise<number | undefined>((resolve, reject) => {
          if (completionFenceBeginWaiters.has(message.id)) {
            reject(new Error("Browser helper completion fence already awaits a begin result"));
            return;
          }
          completionFenceRequestId += 1;
          const requestId = completionFenceRequestId;
          completionFenceBeginWaiters.set(message.id, { requestId, resolve, reject });
          if (!writeProtocol({ type: "event", id: message.id, event: "completion_fence_begin", requestId })) {
            completionFenceBeginWaiters.delete(message.id);
            reject(new Error("Browser helper could not begin the broker completion fence"));
          }
        }),
        commit: revision => new Promise<boolean>((resolve, reject) => {
          if (completionFenceCommitWaiters.has(message.id)) {
            reject(new Error("Browser helper completion fence already awaits a commit result"));
            return;
          }
          completionFenceRequestId += 1;
          const requestId = completionFenceRequestId;
          completionFenceCommitWaiters.set(message.id, { requestId, resolve, reject });
          if (!writeProtocol({ type: "event", id: message.id, event: "completion_fence_commit", requestId, revision })) {
            completionFenceCommitWaiters.delete(message.id);
            reject(new Error("Browser helper could not commit the broker completion fence"));
          }
        }),
      },
    } : {}),
    ...(message.turn.contextRecovery ? {
      authorizeRecovery: async (reason, epoch) => {
        recoveryFenceRequestId++;
        const requestId = recoveryFenceRequestId;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const grant = await new Promise<{ allowed: boolean; recoveryState?: BrowserTurn["recoveryState"] }>((resolve, reject) => {
          if (recoveryWaiters.has(message.id)) { reject(new Error("Recovery already pending")); return; }
          recoveryWaiters.set(message.id, { requestId, resolve, reject });
          const remaining = Math.min(CHATGPT_RECOVERY_TIME_ALLOWANCE_MS,
            (turn.recoveryState?.deadlineAt ?? Infinity) - Date.now(),
            (turn.recoveryDeadlineAt ?? Infinity) - Date.now());
          timeout = setTimeout(() => {
            if (recoveryWaiters.get(message.id)?.requestId !== requestId) return;
            recoveryWaiters.delete(message.id);
            reject(new ChatGptWebAdapterError("Recovery acknowledgement exceeded the original recovery allowance; retain execution", {
              status: 503, errorType: "server_error", code: "chatgpt_recovery_budget_exhausted", retryable: false,
            }));
          }, Math.max(0, remaining));
          if (!writeProtocol({ type: "event", id: message.id, event: "recovery_fence", requestId, ...(reason ? { reason } : {}), ...(epoch !== undefined ? { epoch } : {}) })) {
            recoveryWaiters.delete(message.id); reject(new Error("Recovery fence transport failed"));
          }
        }).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
        const allowed = grant.allowed;
        if (allowed && turn.recoveryState) {
          const state = grant.recoveryState;
          if (!state || !Number.isSafeInteger(state.epoch) || state.epoch < 0
            || (state.deadlineAt !== undefined && (!Number.isSafeInteger(state.deadlineAt) || state.deadlineAt <= 0))) {
            throw new Error("Invalid durable recovery clock acknowledgement");
          }
          turn.recoveryState.deadlineAt = undefined;
          Object.assign(turn.recoveryState, state);
        }
        if (allowed && reason !== "transport_retry" && reason !== "recovery_verified") {
          promptSelection = createBrowserHelperPromptSelection();
          preparedSelections.set(message.id, promptSelection);
          durableObservations.delete(message.id);
          recoverableAccepted.delete(message.id);
        }
        return allowed;
      },
    } : {}),
    ...(message.turn.observationNotices ? {
      onConversationRecovered: () => { writeProtocol({ type: "event", id: message.id, event: "conversation_recovered" }); },
      onRecovering: phase => { writeProtocol({ type: "event", id: message.id, event: "reconnecting", ...(phase ? { phase } : {}) }); },
      onConversationRestored: () => { writeProtocol({ type: "event", id: message.id, event: "conversation_restored" }); },
      onObservationResumed: () => { writeProtocol({ type: "event", id: message.id, event: "observation_resumed" }); },
    } : {}),
    onHeartbeat: () => writeProtocol({ type: "event", id: message.id, event: "heartbeat" }),
    onGenerationProgress: () => writeProtocol({ type: "event", id: message.id, event: "generation_progress" }),
    onPreparedSelected: (reused, includeInstructions) => {
      if (!writeProtocol({ type: "event", id: message.id, event: "prepared_selected", reused, includeInstructions })) {
        throw new Error("Browser helper could not request prompt selection");
      }
      return promptSelection.wait().then(() => undefined);
    },
    ...(message.turn.browserLeaseEvents ? { onBrowserLeaseAcquired: (surfaceId: string) => {
      if (!writeProtocol({ type: "event", id: message.id, event: "browser_lease_acquired", surfaceId })) {
        throw new Error("Browser helper could not retain its browser lease");
      }
    } } : {}),
    ...(message.turn.nativeSubmissionIdentity ? {
      onNativeResultReady: (ready:NativeResultReady)=>persistNativeExecution(message.id,"native_result_ready",ready),
      onNativeRelease: (receipt:NativeReleaseReceipt)=>persistNativeExecution(message.id,"native_release",receipt),
      onNativeCancelTerminal: (terminal:NativeCancelTerminal)=>persistNativeExecution(message.id,"native_cancel_terminal",terminal),
      onNativeSubmission: (value: import("./submission-identity").NativeSubmissionRecord) => {
      const record = parseNativeSubmission(value);
      if (sendActivationWaiters.has(message.id)) return Promise.reject(new Error("Submission acknowledgement already pending"));
      const ack=new NativeMetadataAcknowledgement({type:"event",id:message.id,event:"native_submission",record},frame=>writeProtocol(frame));
      const waiter={nativeRevision:record.revision,nativeSendId:record.sendId,nativeDigest:nativeSubmissionDigest(record),resolve:()=>ack.resolve(),reject:(error:Error)=>ack.reject(error)};
      sendActivationWaiters.set(message.id,waiter);
      return ack.promise.finally(()=>{if(sendActivationWaiters.get(message.id)===waiter)sendActivationWaiters.delete(message.id);});
    } } : {}),
    onSendActivated: () => new Promise<void>((resolve, reject) => {
      if (sendActivationWaiters.has(message.id)) {
        reject(new Error("Browser helper Send activation already awaits acknowledgement"));
        return;
      }
      sendActivationWaiters.set(message.id, { resolve, reject });
      if (!writeProtocol({ type: "event", id: message.id, event: "send_activated" })) {
        sendActivationWaiters.delete(message.id);
        reject(new Error("Browser helper could not request the Send activation boundary"));
      }
    }),
    onSubmitted: () => {
      // The host registered this exact lease after the durable checkpoint ACK. An EOF can
      // race the final submission_ack, so preservation cannot depend on receiving that ACK.
      if (durableObservations.has(message.id)) recoverableAccepted.add(message.id);
      if (message.turn.submissionAck) {
        const acknowledgement = new Promise<void>((resolve, reject) => {
          if (submissionWaiters.has(message.id)) {
            reject(new Error("Browser helper submission already awaits acknowledgement"));
            return;
          }
          submissionWaiters.set(message.id, { resolve, reject });
          if (!writeProtocol({ type: "event", id: message.id, event: "submitted" })) {
            submissionWaiters.delete(message.id);
            reject(new Error("Browser helper could not persist ChatGPT submission evidence"));
          }
        });
        // Older callers can treat this hook as an observer. Abort still reaches the turn;
        // awaited callers keep the rejection without a second unhandled promise on shutdown.
        void acknowledgement.catch(() => {});
        return acknowledgement;
      }
      if (!writeProtocol({ type: "event", id: message.id, event: "submitted" })) {
        throw new Error("Browser helper could not persist ChatGPT submission evidence");
      }
    },
    onMultipartStageAcknowledged: stageIndex => {
      if (!writeProtocol({ type: "event", id: message.id, event: "multipart_stage_acknowledged", stageIndex })) {
        throw new Error("Browser helper could not persist multipart acknowledgement evidence");
      }
    },
    onReasoningSummary: (text, continuation) => writeProtocol({
      type: "event",
      id: message.id,
      event: "reasoning",
      text,
      ...(continuation ? { continuation: true } : {}),
    }),
    onCommentary: (text, continuation) => writeProtocol({ type: "event", id: message.id, event: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
    onTextDelta: text => writeProtocol({ type: "event", id: message.id, event: "text", text }),
    onRichWidgets: widgets => { if (widgets.length) writeProtocol({ type: "event", id: message.id, event: "rich_widgets", widgets }); },
    ...(message.turn.captureLunaCheckpoint ? {
      captureLunaCheckpoint: true,
      onLunaCheckpoint: captured => writeProtocol({
        type: "event",
        id: message.id,
        event: "luna_checkpoint",
        ...captured,
      }),
    } : {}),
  };
  try {
    const text = await ChatGptBrowserWorker.forProvider(provider).run(turn);
    writeProtocol({ type: "result", id: message.id, text });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ChatGptWebAdapterError ? {
        status: error.status,
        errorType: error.errorType,
        code: error.code,
        retryable: error.retryable,
        ...(error.diagnostics ? { diagnostics: parseChatGptSavedConversationDiagnostics(error.diagnostics) } : {}),
      } : {}),
    });
  } finally {
    preparedSelections.get(message.id)?.cancel();
    recoveryWaiters.get(message.id)?.reject(new Error("Browser turn ended during recovery"));
    recoveryWaiters.delete(message.id);
    preparedSelections.delete(message.id);
    durableObservations.delete(message.id);
    recoverableAccepted.delete(message.id);
    nativeTurns.delete(message.id);
    nativeScopes.delete(message.id);
    nativeExecutionWaiters.get(message.id)?.reject(new Error("Native execution ended before its acknowledgement"));
    nativeExecutionWaiters.delete(message.id);
    observationWaiters.get(message.id)?.reject(new DOMException("Observation ended", "AbortError"));
    observationWaiters.delete(message.id);
    const sendWaiter = sendActivationWaiters.get(message.id);
    sendActivationWaiters.delete(message.id);
    sendWaiter?.reject(new DOMException("Browser helper turn ended before Send acknowledgement", "AbortError"));
    const submissionWaiter = submissionWaiters.get(message.id);
    submissionWaiters.delete(message.id);
    submissionWaiter?.reject(new DOMException("Browser helper turn ended before submission acknowledgement", "AbortError"));
    const beginWaiter = completionFenceBeginWaiters.get(message.id);
    completionFenceBeginWaiters.delete(message.id);
    beginWaiter?.reject(new DOMException("Browser helper turn ended before completion-fence begin", "AbortError"));
    const commitWaiter = completionFenceCommitWaiters.get(message.id);
    completionFenceCommitWaiters.delete(message.id);
    commitWaiter?.reject(new DOMException("Browser helper turn ended before completion-fence commit", "AbortError"));
    abortControllers.delete(message.id);
    turnProgress.delete(message.id);
  }
}

async function verify(message: VerifyMessage): Promise<void> {
  try {
    const selected = await maintenanceWorker(message).verifyConnector(message.id);
    writeProtocol({ type: "result", id: message.id, text: selected });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function maintenanceWorker(message: MaintenanceMessage): ChatGptBrowserWorker {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(message.id)) {
    throw new Error("Browser helper maintenance identity is invalid");
  }
  const appName = message.config.appName?.trim();
  const browserHostDescriptorPath = message.config.browserHostDescriptorPath?.trim();
  if (!appName || appName.length > 80 || !browserHostDescriptorPath) {
    throw new Error("Browser helper maintenance config is invalid");
  }
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: { appName, browserHost: "launcher", browserHostDescriptorPath },
  };
  return ChatGptBrowserWorker.forProvider(provider);
}

async function maintain(message: InspectMessage | SmokeMessage | LimitsMessage): Promise<void> {
  if (abortControllers.has(message.id)) throw new Error(`Browser helper maintenance operation already exists: ${message.id}`);
  const abortController = new AbortController();
  abortControllers.set(message.id, abortController);
  try {
    const worker = maintenanceWorker(message);
    const value = message.type === "inspect"
      ? await worker.inspectSession(message.detectCapabilities)
      : message.type === "limits" ? await worker.inspectLimitsPlan()
      : await worker.smokeTest(abortController.signal);
    writeProtocol({ type: "result", id: message.id, value });
  } catch (error) {
    writeProtocol({
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

const input = createInterface({ input: stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (shuttingDown) return;
  let message: InputMessage;
  try { message = JSON.parse(line) as InputMessage; }
  catch {
    writeProtocol({ type: "error", id: "protocol", message: "Browser helper received invalid JSON" });
    return;
  }
  if (message.type === "prepared_selected_ack") {
    const prepared = message.prepared;
    if (!prepared || typeof prepared.text !== "string" || !Array.isArray(prepared.images)) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper prompt selection is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    try { validateSkillFiles(prepared.skillFiles); }
    catch (error) {
      writeProtocol({ type: "error", id: message.id, message: error instanceof Error ? error.message : String(error) });
      abortControllers.get(message.id)?.abort();
      return;
    }
    if (prepared.multipart !== undefined) {
      const multipart = prepared.multipart;
      if (!multipart || !Array.isArray(multipart.parts)
        || !isChatGptWebMultipartPartCount(multipart.parts.length)
        || multipart.parts.some(part => typeof part !== "string")
        || typeof multipart.commit !== "string") {
        writeProtocol({ type: "error", id: message.id, message: "Browser helper multipart prompt is invalid" });
        abortControllers.get(message.id)?.abort();
        return;
      }
    }
    const selection = preparedSelections.get(message.id);
    if (!selection) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper has no pending prompt selection" });
      return;
    }
    selection.select(prepared);
  } else if (message.type === "observation_ready_ack") {
    const waiter = observationWaiters.get(message.id);
    if (!waiter || waiter.digest!==message.digest) return;
    observationWaiters.delete(message.id);
    if (waiter.resolve()) durableObservations.add(message.id);
  } else if (message.type === "native_submission_ack") {
    const waiter = sendActivationWaiters.get(message.id);
    if (!waiter || waiter.nativeRevision !== message.revision || waiter.nativeSendId !== message.sendId || waiter.nativeDigest !== message.digest) return;
    sendActivationWaiters.delete(message.id);
    waiter.resolve();
  } else if (message.type === "send_activation_ack") {
    const waiter = sendActivationWaiters.get(message.id);
    if (waiter?.nativeRevision !== undefined) return;
    if (!waiter) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper has no pending Send activation" });
      return;
    }
    sendActivationWaiters.delete(message.id);
    waiter.resolve();
  } else if (message.type === "submission_ack") {
    const waiter = submissionWaiters.get(message.id);
    if (!waiter) return;
    submissionWaiters.delete(message.id);
    if (durableObservations.has(message.id)) recoverableAccepted.add(message.id);
    waiter.resolve();
  } else if (message.type === "completion_fence_begin_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0
      || (message.revision !== null && (!Number.isSafeInteger(message.revision) || message.revision < 0))) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper completion fence revision is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    const waiter = completionFenceBeginWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    completionFenceBeginWaiters.delete(message.id);
    waiter.resolve(message.revision ?? undefined);
  } else if (message.type === "completion_fence_commit_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0
      || typeof message.committed !== "boolean") {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper completion fence result is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    const waiter = completionFenceCommitWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    completionFenceCommitWaiters.delete(message.id);
    waiter.resolve(message.committed);
  } else if (message.type === "recovery_fence_ack") {
    const waiter = recoveryWaiters.get(message.id);
    if (!waiter) return;
    if (waiter.requestId !== message.requestId) return;
    recoveryWaiters.delete(message.id);
    if (typeof message.allowed !== "boolean") waiter.reject(new Error("Invalid recovery fence acknowledgement"));
    else waiter.resolve({ allowed: message.allowed, recoveryState: message.recoveryState });
  } else if (message.type === "progress") {
    // Progress is meaningful only for a turn this helper is currently running. Ignore every other
    // id so the mirror map remains owned by active turn lifecycles.
    if (!abortControllers.has(message.id)) return;
    const progress = turnProgress.get(message.id) ?? new ChatGptMirroredTurnProgress();
    turnProgress.set(message.id, progress);
    try {
      progress.apply(message.snapshot);
    } catch (error) {
      // Progress carries liveness and tool-boundary state, never response content. Invalid progress
      // cannot determine the outcome of the active ChatGPT turn, so it is logged and ignored.
      diagnostic(
        `[chatgpt-web] discarded an invalid MCP progress frame for ${message.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (message.type === "native_execution_ack") {
    const waiter=nativeExecutionWaiters.get(message.id);
    if(waiter && waiter.event===message.event && waiter.requestId===message.requestId && waiter.digest===message.digest){
      nativeExecutionWaiters.delete(message.id);waiter.resolve();
    }
  } else if (message.type === "abort") {
    const explicit = message.reason === "native_interrupt" ? message.intent : undefined;
    const preparation=message.reason==="native_preparation_cancel"?message.preparation:undefined;
    if(message.reason==="native_preparation_cancel" && (!preparation || preparation.version!==1
      || JSON.stringify(preparation.scope)!==JSON.stringify(nativeScopes.get(message.id))
      || preparation.request.threadId!==preparation.scope.threadId || preparation.request.turnId!==preparation.scope.turnId)){
      abortControllers.get(message.id)?.abort(new BrowserObservationDetached("Preparation cancellation identity changed"));return;
    }
    if(message.reason === "native_interrupt" && (!explicit || explicit.version!==1 || explicit.source!=="native_interrupt"
      || JSON.stringify(explicit.scope)!==JSON.stringify(nativeScopes.get(message.id))
      || explicit.threadId!==explicit.scope.threadId || explicit.turnId!==explicit.scope.turnId)) {
      abortControllers.get(message.id)?.abort(new BrowserObservationDetached("Cancellation authority did not match the original turn"));
      return;
    }
    abortControllers.get(message.id)?.abort(preparation ? new ExplicitNativeCancellation(preparation.request,undefined,preparation) : explicit
      ? new ExplicitNativeCancellation(explicit, explicit)
      : message.reason === "compaction_handoff_accepted" ? new ChatGptCompactionHandoffAccepted()
      : message.reason === "recovery_budget_retained" || nativeTurns.has(message.id) ? new BrowserObservationDetached() : undefined);
    preparedSelections.get(message.id)?.cancel();
    const observationWaiter=observationWaiters.get(message.id);
    observationWaiters.delete(message.id);
    observationWaiter?.reject(explicit ? new DOMException("Explicit original cancellation interrupted observation readiness","AbortError")
      : new BrowserObservationDetached("Original observation readiness detached"));
    if(!explicit){
      const executionWaiter=nativeExecutionWaiters.get(message.id);nativeExecutionWaiters.delete(message.id);
      executionWaiter?.reject(new ChatGptWebAdapterError("Original execution metadata was not acknowledged; owner retained",{status:503,errorType:"server_error",code:"chatgpt_execution_retained",retryable:false}));
    }
    const waiter = sendActivationWaiters.get(message.id);
    if (!explicit || waiter?.nativeRevision === undefined) {
      sendActivationWaiters.delete(message.id);
      waiter?.reject(new DOMException("Browser helper turn aborted before Send acknowledgement", "AbortError"));
    }
    const submissionWaiter = submissionWaiters.get(message.id);
    submissionWaiters.delete(message.id);
    submissionWaiter?.reject(new DOMException("Browser helper turn aborted before submission acknowledgement", "AbortError"));
    const beginWaiter = completionFenceBeginWaiters.get(message.id);
    completionFenceBeginWaiters.delete(message.id);
    beginWaiter?.reject(new DOMException("Browser helper turn aborted before completion-fence begin", "AbortError"));
    const commitWaiter = completionFenceCommitWaiters.get(message.id);
    completionFenceCommitWaiters.delete(message.id);
    commitWaiter?.reject(new DOMException("Browser helper turn aborted before completion-fence commit", "AbortError"));
  }
  else if (message.type === "shutdown") {
    void requestShutdown();
  } else if (message.type === "verify") {
    void verify(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "inspect" || message.type === "smoke" || message.type === "limits") {
    void maintain(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else if (message.type === "run") {
    void run(message).catch(error => writeProtocol({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  } else {
    // Never treat an unrecognised frame as a run; unsupported protocol data fails explicitly.
    writeProtocol({
      type: "error",
      id: (message as { id?: string }).id ?? "unknown",
      message: `Browser helper received an unsupported message type: ${String((message as { type?: unknown }).type)}`,
    });
  }
});
input.on("close", () => {
  void requestShutdown(true);
});
process.once("SIGINT", () => {
  void requestShutdown();
});
process.once("SIGTERM", () => {
  void requestShutdown();
});

// Advertise the optional frames this helper understands so the daemon can negotiate them explicitly.
writeProtocol({ type: "ready", features: ["progress", "tool-boundary-ack", "completion-fence", "multipart-stage-ack", "skill-attachments", "send-activation-ack", "submission-ack", "browser-lease-events", "durable-observation", "context-recovery", "recovery-clock", "native-submission-v1", "native-execution-v1", "instruction-dedup-v1"] });
