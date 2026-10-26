import { nativeExecutionDigest, ExplicitNativeCancellation, type NativeExecutionEvent, type NativeExecutionPayload, type NativeResultReady, type NativeReleaseReceipt, type NativeCancelTerminal } from "./native-execution";
import { nativeSubmissionDigest, parseNativeSubmission, retainsBrowserExecution, submissionIdentityUnproven, type NativeSubmissionRecord } from "./submission-identity";
import { BrowserObservationDetached, parseBrowserObservation, observationUnavailable, type BrowserObservationCheckpoint } from "./observation-recovery";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { notifyLauncherTurn, readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, parseChatGptSavedConversationDiagnostics, type ChatGptSavedConversationDiagnostics } from "./adapter-error";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { BrowserTurn, ResolvedBrowserConfig } from "./browser-worker";
import { isChatGptChartWidget, type ChatGptChartWidget } from "./rich-widget";
import {
  parseChatGptLunaCheckpoint,
  type ChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

interface PendingTurn {
  turn: BrowserTurn;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
  sent?: boolean;
  prepared?: CompiledChatGptWebPrompt & { release: () => void };
  localFailure?: Error;
  progressForwarding?: AbortController;
  acknowledgedMultipartStage?: number;
  surfaceId?: string;
  submission?: Promise<void>;
  nativeUpdates?: Promise<void>;
  sendActivated?: boolean;
  preparationCancelled?: boolean;
  nativeReady?: NativeResultReady;
  nativeReleased?: NativeReleaseReceipt;
  observation?: BrowserObservationCheckpoint;
  observationUpdate?: Promise<void>;
}

type HelperMessage =
  | { type: "ready"; features?: string[] }
  | { type: "event"; id: string; event: "heartbeat" | "generation_progress" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text"; text?: string; continuation?: boolean }
  | { type: "event"; id: string; event: "rich_widgets"; widgets: ChatGptChartWidget[] }
  | { type: "event"; id: string; event: "tool_batch_observed"; revision: number }
  | { type: "event"; id: string; event: "multipart_stage_acknowledged"; stageIndex: number }
  | { type: "event"; id: string; event: "completion_fence_begin"; requestId: number }
  | { type: "event"; id: string; event: "completion_fence_commit"; requestId: number; revision: number }
  | { type: "event"; id: string; event: "prepared_selected"; reused: boolean }
  | { type: "event"; id: string; event: "browser_lease_acquired"; surfaceId: string }
  | { type: "event"; id: string; event: "luna_checkpoint"; checkpoint: ChatGptLunaCheckpoint; answerHash: string }
  | { type: "event"; id: string; event: "conversation_restored" | "observation_resumed" | "reconnecting" | "conversation_recovered" | "recovery_fence"; reason?: "delivery_loss" | "receipt_only_failure" | "transport_retry" | "recovery_verified"; epoch?: number; requestId?: number; phase?: "connector_waiting" | "connector_refreshing" | "network_waiting" | "saved_conversation_waiting" | "model_selection_restoring" }
  | { type: "event"; id: string; event: "native_submission"; record: NativeSubmissionRecord }
  | { type: "event"; id: string; event: NativeExecutionEvent; payload: NativeExecutionPayload; requestId: number; digest: string }
  | { type: "event"; id: string; event: "observation_ready"; checkpoint: BrowserObservationCheckpoint; digest?:string }
  | { type: "result"; id: string; text: string }
  | {
      type: "error";
      id: string;
      name?: string;
      message: string;
      status?: number;
      errorType?: string;
      code?: string;
      retryable?: boolean;
      diagnostics?: ChatGptSavedConversationDiagnostics;
    };

function parseHelperMessage(line: string): HelperMessage {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser helper message is not an object");
  }
  const message = value as Record<string, unknown>;
  if (message.type === "ready") {
    const features = message.features;
    if (features !== undefined
      && (!Array.isArray(features) || features.some(feature => typeof feature !== "string"))) {
      throw new Error("Launcher browser helper advertised invalid features");
    }
    return { type: "ready", ...(features ? { features: features as string[] } : {}) };
  }
  if (typeof message.id !== "string" || !message.id) {
    throw new Error("Launcher browser helper message has no turn identity");
  }
  if (message.type === "event") {
    const event = message.event;
    if (["native_result_ready", "native_release", "native_cancel_terminal"].includes(event as string)) {
      if (!message.payload || typeof message.payload !== "object" || !Number.isSafeInteger(message.requestId)
        || (message.requestId as number) < 1 || typeof message.digest !== "string"
        || message.digest !== nativeExecutionDigest(message.payload)) throw submissionIdentityUnproven("invalid native execution frame");
      return { type: "event", id: message.id, event: event as NativeExecutionEvent, payload: message.payload as NativeExecutionPayload,
        requestId: message.requestId as number, digest: message.digest };
    }
    if (event === "native_submission") return { type: "event", id: message.id, event, record: parseNativeSubmission(message.record) };
    if (event === "recovery_fence" && (
      message.requestId !== undefined && (!Number.isSafeInteger(message.requestId) || (message.requestId as number) < 1)
      || message.epoch !== undefined && (!Number.isSafeInteger(message.epoch) || (message.epoch as number) < 0))) {
      throw new Error("Invalid recovery fence identity");
    }
    if (event === "conversation_restored" || event === "observation_resumed" || event === "reconnecting" || event === "conversation_recovered" || event === "recovery_fence") return { type: "event", id: message.id, event, ...(event === "reconnecting" && (message.phase === "connector_waiting" || message.phase === "connector_refreshing" || message.phase === "network_waiting" || message.phase === "saved_conversation_waiting" || message.phase === "model_selection_restoring") ? { phase: message.phase } : {}), ...(event === "recovery_fence" ? { epoch: message.epoch as number | undefined, requestId: message.requestId as number | undefined } : {}), ...(event === "recovery_fence" && (message.reason === "delivery_loss" || message.reason === "receipt_only_failure" || message.reason === "transport_retry" || message.reason === "recovery_verified") ? { reason: message.reason } : {}) };
    if (event === "observation_ready") {
      const checkpoint=parseBrowserObservation(message.checkpoint);
      if(message.digest!==undefined && message.digest!==nativeExecutionDigest(checkpoint))throw observationUnavailable("observation checkpoint digest changed");
      return {type:"event",id:message.id,event,checkpoint,...(typeof message.digest==="string"?{digest:message.digest}:{})};
    }
    if (event === "browser_lease_acquired") {
      if (typeof message.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(message.surfaceId)) {
        throw new Error("Launcher browser helper lease is invalid");
      }
      return { type: "event", id: message.id, event, surfaceId: message.surfaceId };
    }
    if (event === "multipart_stage_acknowledged") {
      if (!Number.isSafeInteger(message.stageIndex) || (message.stageIndex as number) <= 0) {
        throw new Error("Launcher browser helper multipart stage index is invalid");
      }
      return { type: "event", id: message.id, event, stageIndex: message.stageIndex as number };
    }
    if (event === "tool_batch_observed") {
      if (!Number.isSafeInteger(message.revision) || (message.revision as number) <= 0) {
        throw new Error("Launcher browser helper tool-boundary revision is invalid");
      }
      return { type: "event", id: message.id, event, revision: message.revision as number };
    }
    if (event === "completion_fence_begin") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0) {
        throw new Error("Launcher browser helper completion fence request id is invalid");
      }
      return { type: "event", id: message.id, event, requestId: message.requestId as number };
    }
    if (event === "completion_fence_commit") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0
        || !Number.isSafeInteger(message.revision) || (message.revision as number) < 0) {
        throw new Error("Launcher browser helper completion fence revision is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        requestId: message.requestId as number,
        revision: message.revision as number,
      };
    }
    if (event === "rich_widgets") {
      if (!Array.isArray(message.widgets) || message.widgets.length > 4
        || message.widgets.some(widget => !isChatGptChartWidget(widget))) {
        throw new Error("Launcher browser helper rich widgets are invalid");
      }
      return { type: "event", id: message.id, event, widgets: message.widgets as ChatGptChartWidget[] };
    }
    if (event === "luna_checkpoint") {
      if (typeof message.answerHash !== "string" || !/^[a-f0-9]{64}$/.test(message.answerHash)) {
        throw new Error("Launcher browser helper Luna checkpoint answer hash is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        checkpoint: parseChatGptLunaCheckpoint(message.checkpoint),
        answerHash: message.answerHash,
      };
    }
    const text = message.text;
    const continuation = message.continuation;
    if (event === "prepared_selected") {
      if (typeof message.reused !== "boolean") {
        throw new Error("Launcher browser helper prompt selection is invalid");
      }
      return { type: "event", id: message.id, event, reused: message.reused };
    }
    if (!["heartbeat", "generation_progress", "send_activated", "submitted", "reasoning", "commentary", "text"].includes(String(event))) {
      throw new Error("Launcher browser helper emitted an unknown event");
    }
    if (text !== undefined && typeof text !== "string") {
      throw new Error("Launcher browser helper event text is invalid");
    }
    if (continuation !== undefined && typeof continuation !== "boolean") {
      throw new Error("Launcher browser helper continuation flag is invalid");
    }
    return {
      type: "event",
      id: message.id,
      event: event as "heartbeat" | "generation_progress" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text",
      ...(text !== undefined ? { text: text as string } : {}),
      ...(continuation !== undefined ? { continuation: continuation as boolean } : {}),
    };
  }
  if (message.type === "result") {
    const text = message.text;
    if (typeof text !== "string") {
      throw new Error("Launcher browser helper result text is invalid");
    }
    return { type: "result", id: message.id, text };
  }
  if (message.type === "error") {
    const errorMessage = message.message;
    const errorName = message.name;
    const status = message.status;
    const errorType = message.errorType;
    const code = message.code;
    const retryable = message.retryable;
    const structured = status !== undefined
      || errorType !== undefined
      || code !== undefined
      || retryable !== undefined;
    if (typeof errorMessage !== "string"
      || (errorName !== undefined && typeof errorName !== "string")
      || (structured && (
        !Number.isInteger(status)
        || (status as number) < 400
        || (status as number) > 599
        || typeof errorType !== "string"
        || !errorType
        || typeof code !== "string"
        || !code
        || typeof retryable !== "boolean"
      ))) {
      throw new Error("Launcher browser helper error payload is invalid");
    }
    return {
      type: "error",
      id: message.id,
      message: errorMessage,
      ...(errorName !== undefined ? { name: errorName as string } : {}),
      ...(structured ? {
        status: status as number,
        errorType: errorType as string,
        code: code as string,
        retryable: retryable as boolean,
        ...(message.diagnostics !== undefined ? { diagnostics: parseChatGptSavedConversationDiagnostics(message.diagnostics) } : {}),
      } : {}),
    };
  }
  throw new Error("Launcher browser helper emitted an unknown message type");
}

export class LauncherBrowserHelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly pending = new Map<string, PendingTurn>();
  private helperFeatures = new Set<string>();

  constructor(private readonly config: ResolvedBrowserConfig) {}

  /**
   * The helper that shipped with this daemon, when one sits beside its own entrypoint.
   *
   * The launcher advertises the helper inside its application bundle while the daemon runs from a
   * versioned runtime directory, so the two sides update independently and can disagree about the
   * protocol. Preferring the sibling keeps daemon and helper on the same build by construction;
   * anything else — a source checkout, an unbundled entrypoint — falls back to the advertised path.
   */
  private bundledHelperScript(): string | undefined {
    const entrypoint = process.argv[1];
    // Only the packaged runtime layout is claimed: the bundle builder emits cli.js and
    // browser-helper.cjs into one directory. Matching on that entrypoint name keeps a source
    // checkout, or any other launch shape, on the launcher-advertised helper rather than adopting
    // an unrelated sibling that merely shares a filename.
    if (typeof entrypoint !== "string" || basename(entrypoint) !== "cli.js") return undefined;
    const sibling = join(dirname(entrypoint), "browser-helper.cjs");
    return existsSync(sibling) ? sibling : undefined;
  }

  private async rejectAbortedPreparation(turn: BrowserTurn): Promise<void> {
    if (!turn.abortSignal?.aborted) return;
    const reason = turn.abortSignal.reason;
    if (turn.nativeSubmissionIdentity && reason instanceof ExplicitNativeCancellation) {
      if (!turn.onNativePreparationCancel) throw submissionIdentityUnproven("no durable preparation cancellation owner");
      try { await turn.onNativePreparationCancel(reason.request); }
      catch { throw submissionIdentityUnproven("explicit preparation cancellation persistence is unresolved"); }
      throw new ChatGptWebAdapterError("The original turn was explicitly cancelled before helper dispatch", {
        status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false,
      });
    }
    throw new DOMException("ChatGPT web turn aborted", "AbortError");
  }

  private async ensureChildForTurn(turn: BrowserTurn): Promise<void> {
    await this.rejectAbortedPreparation(turn);
    const signal = turn.abortSignal;
    if (!signal) return this.ensureChild();
    // A request may cancel while a shared helper is booting. Own this request's
    // durable cancellation without cancelling that bootstrap or dispatching its run.
    await new Promise<void>((resolve, reject) => {
      let settled = false, aborting = false;
      const settle = (accepted: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (accepted) resolve(); else reject(error);
      };
      const onAbort = () => {
        if (settled || aborting) return;
        aborting = true;
        void this.rejectAbortedPreparation(turn).then(
          () => settle(false, new DOMException("ChatGPT web turn aborted", "AbortError")),
          error => settle(false, error),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      void this.ensureChild().then(
        () => { if (!aborting) { if (signal.aborted) onAbort(); else settle(true); } },
        error => { if (!aborting) { if (signal.aborted) onAbort(); else settle(false, error); } },
      );
    });
    await this.rejectAbortedPreparation(turn);
  }

  async run(turn: BrowserTurn): Promise<string> {
    await this.ensureChildForTurn(turn);
    if ((turn.observationIdentity || turn.observation) && !this.helperFeatures.has("durable-observation")) {
      throw observationUnavailable("the browser helper does not support durable observation");
    }
    if (turn.onSendActivated && !this.helperFeatures.has("send-activation-ack")) {
      throw new ChatGptWebAdapterError(
        "The browser helper has not proven its Send acknowledgement boundary. No prompt was sent; update the helper with the runtime before resuming.",
        { status: 409, errorType: "server_error", code: "browser_helper_send_approval_unavailable", retryable: false },
      );
    }
    if (turn.onMultipartStageAcknowledged && !this.helperFeatures.has("multipart-stage-ack")) {
      throw new Error(
        "Launcher browser helper does not support multipart acknowledgement forwarding; update or restart the launcher",
      );
    }
    if (turn.externalProgress && !this.helperFeatures.has("tool-boundary-ack")) {
      throw new Error(
        "Launcher browser helper does not support causal Codex tool-boundary acknowledgement; update or restart the launcher",
      );
    }
    if (turn.externalProgress && !this.helperFeatures.has("completion-fence")) {
      throw new Error(
        "Launcher browser helper does not support the MCP completion fence; update or restart the launcher",
      );
    }
    if (turn.nativeSubmissionIdentity && (!turn.onNativeSubmission || !turn.onNativeResultReady || !turn.onNativeRelease
      || !turn.onNativeCancelIntent || !turn.onNativePreparationCancel || !turn.onNativeCancelTerminal || !turn.nativeOperationScope
      || !this.helperFeatures.has("native-submission-v1") || !this.helperFeatures.has("native-execution-v1"))) {
      throw new Error("Paired native-submission helper and durable owner are required before Send");
    }
    if (turn.recoveryState && !this.helperFeatures.has("recovery-clock")) {
      throw new Error("The browser helper does not support the durable recovery clock; keep its original owner and use a paired helper");
    }
    return await new Promise<string>((resolveResult, rejectResult) => {
        if (this.pending.has(turn.traceId)) {
          rejectResult(new Error(`Duplicate launcher browser turn: ${turn.traceId}`));
          return;
        }
        const pending: PendingTurn = { turn, resolve: resolveResult, reject: rejectResult };
        this.pending.set(turn.traceId, pending);
        if (turn.abortSignal) {
          const abortListener = () => {
            if (turn.nativeSubmissionIdentity && turn.abortSignal?.reason instanceof ExplicitNativeCancellation) {
              const request = turn.abortSignal.reason.request;
              void this.flushNativeUpdates(pending).then(async () => {
                if(!pending.nativeUpdates){
                  pending.preparationCancelled=true;
                  if(!turn.onNativePreparationCancel)throw submissionIdentityUnproven("no durable preparation cancellation owner");
                  const preparation=await turn.onNativePreparationCancel(request);
                  if(!pending.sent){this.finishWithError(turn.traceId,new DOMException("Original preparation cancelled","AbortError"));return;}
                  await this.send({type:"abort",id:turn.traceId,reason:"native_preparation_cancel",preparation});return;
                }
                if (!turn.onNativeCancelIntent) throw submissionIdentityUnproven("no durable original cancellation authority");
                const intent = await turn.onNativeCancelIntent(request);
                await this.send({ type: "abort", id: turn.traceId, reason: "native_interrupt", intent });
              }).catch(() => this.abortWithLocalFailure(turn.traceId, submissionIdentityUnproven("explicit cancellation authority could not be durably acknowledged"), pending));
              return;
            }
            if (!pending.sent) {
              this.finishWithError(turn.traceId,new DOMException("ChatGPT web turn aborted","AbortError"));return;
            }
            void this.send({
              type: "abort",
              id: turn.traceId,
              ...(turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted
                ? { reason: "compaction_handoff_accepted" }
                : turn.abortSignal?.reason instanceof BrowserObservationDetached || retainsBrowserExecution(turn.abortSignal?.reason)
                  ? { reason: "recovery_budget_retained" } : {}),
            }).catch(error => {
              this.finishWithError(
                turn.traceId,
                error instanceof Error ? error : new Error(String(error)),
              );
            });
          };
          pending.abortListener = abortListener;
          turn.abortSignal.addEventListener("abort", abortListener, { once: true });
          if (turn.abortSignal.aborted) {
            abortListener();
            return;
          }
        }
        // Setting this before the synchronous write call makes an abort either prevent dispatch or
        // queue an `abort` after the `run` frame; it can never overtake the run frame in the pipe.
        pending.sent = true;
        const progressForwarding = new AbortController();
        pending.progressForwarding = progressForwarding;
        void this.send({
          type: "run",
          id: turn.traceId,
          config: {
            appName: this.config.appName,
            browserHostDescriptorPath: this.config.browserHostDescriptorPath!,
            browserDiagnosticsPath: this.config.browserDiagnosticsPath,
            turnTimeoutMs: this.config.turnTimeoutMs,
            autoApproveToolCalls: this.config.autoApproveToolCalls,
            standardConcurrencyLimit: this.config.standardConcurrencyLimit,
            proConcurrencyLimit: this.config.proConcurrencyLimit,
            accountId: this.config.accountId,
            conversationStoreDirectory: this.config.conversationStoreDirectory,
            imageOutputDirectory: this.config.imageOutputDirectory,
            downloadDirectory: this.config.downloadDirectory,
            downloadBaseUrl: this.config.downloadBaseUrl,
          },
          turn: {
            traceId: turn.traceId,
            modelId: turn.modelId,
            ...(turn.observationIdentity ? { observationIdentity: turn.observationIdentity } : {}),
            ...(turn.observation ? { observation: turn.observation } : {}),
            ...(turn.observationToolFence ? { observationToolFence: turn.observationToolFence } : {}),
            ...(this.helperFeatures.has("durable-observation") && (turn.onConversationRestored || turn.onObservationResumed || turn.onRecovering || turn.onConversationRecovered)
              ? { observationNotices: true } : {}),
            ...(this.helperFeatures.has("context-recovery") && turn.authorizeRecovery ? { contextRecovery: true } : {}),
            recoveryDeadlineAt: turn.recoveryDeadlineAt,
            recoveryState: turn.recoveryState,
            nativeSubmissionIdentity: turn.nativeSubmissionIdentity,
            nativeSubmissionRoundKey: turn.nativeSubmissionRoundKey,
            nativeOperationScope: turn.nativeOperationScope,
            nativeObservationSubmission: turn.nativeObservationSubmission,
            ...(turn.project ? { project: turn.project } : {}),
            ...(turn.sessionMode ? { sessionMode: turn.sessionMode } : {}),
            ...(turn.deferTextUntilComplete ? { deferTextUntilComplete: true } : {}),
            reasoning: turn.reasoning,
            ...(turn.modelFamily ? { modelFamily: turn.modelFamily } : {}),
            ...(turn.proModel ? { proModel: true } : {}),
            capabilities: turn.capabilities,
            ...(turn.nativeConnector ? { nativeConnector: true } : {}),
            ...(turn.prepareResume ? { resumeAvailable: true } : {}),
            ...(turn.retainConversation ? { retainConversation: true } : {}),
            ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
            ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
            ...(turn.canonicalHistory ? { canonicalHistory: turn.canonicalHistory } : {}),
            ...(turn.compaction ? { compaction: true } : {}),
            ...(turn.captureLunaCheckpoint ? { captureLunaCheckpoint: true } : {}),
            ...(turn.externalProgress ? { externalProgress: true } : {}),
            ...(this.helperFeatures.has("submission-ack") ? { submissionAck: true } : {}),
            ...(this.helperFeatures.has("browser-lease-events") ? { browserLeaseEvents: true } : {}),
          },
        })
          // Only mirror once the run frame is on the wire, so the helper never sees progress for a
          // turn it has not been told about and cannot accumulate state for unknown ids.
          .then(() => {
            if (!progressForwarding.signal.aborted) this.forwardProgress(turn, progressForwarding.signal);
          })
          .catch(error => this.finishWithError(turn.traceId, error instanceof Error ? error : new Error(String(error))));
      });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const id of [...this.pending.keys()]) {
      this.finishWithError(id, new DOMException("Launcher browser helper is closing", "AbortError"));
    }
    if (!child) return;
    await this.sendTo(child, { type: "shutdown" }).catch(() => {});
    await this.terminateChild(child, 2_000);
  }

  private async ensureChild(): Promise<void> {
    if (this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.ready) {
      return this.ready;
    }
    const descriptor = readLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!);
    const child = spawn(
      descriptor.helper.executable,
      [this.config.browserHelperScriptPath ?? this.bundledHelperScript() ?? descriptor.helper.script],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    const output = createInterface({ input: child.stdout });
    output.on("line", line => this.handleLine(child, line));
    const errors = createInterface({ input: child.stderr });
    errors.on("line", line => console.info(`[chatgpt-web-helper] ${line}`));
    const failChild = (error: Error) => {
      const owned = this.child === child;
      this.handleExit(child, error);
      if (owned && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
        void this.terminateChild(child, 0).catch(cleanupError => {
          console.error(
            `[chatgpt-web-helper] process-error cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
      }
    };
    child.once("error", failChild);
    child.stdin.once("error", error => failChild(new Error(
      `Launcher browser helper input failed: ${error instanceof Error ? error.message : String(error)}`,
    )));
    child.once("exit", (code, signal) => this.handleExit(child, new Error(
      `Launcher browser helper exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}`,
    )));
    const timer = setTimeout(() => {
      if (this.child === child) this.readyReject?.(new Error("Launcher browser helper did not become ready"));
    }, 15_000);
    try {
      await this.ready;
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        this.readyResolve = undefined;
        this.readyReject = undefined;
      }
      try {
        await this.terminateChild(child, 500);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; launcher browser helper cleanup failed: ${cleanup}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: HelperMessage;
    try { message = parseHelperMessage(line); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleExit(child, new Error(`Launcher browser helper emitted invalid protocol data: ${detail}`));
      void this.terminateChild(child, 0).catch(error => {
        console.error(`[chatgpt-web-helper] invalid-protocol cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (message.type === "ready") {
      // Optional frames are sent only when the helper advertises support for them.
      this.helperFeatures = new Set(message.features ?? []);
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      if (["native_result_ready", "native_release", "native_cancel_terminal"].includes(message.event)) {
        const frame = message as Extract<HelperMessage, { event: NativeExecutionEvent }>;
        const update = (pending.nativeUpdates ?? Promise.resolve()).then(async () => {
          if (!pending.turn.nativeSubmissionIdentity) throw submissionIdentityUnproven("unexpected native execution state");
          if (frame.event === "native_result_ready") {
            if (pending.localFailure) throw pending.localFailure;
            if (!pending.turn.onNativeResultReady) throw submissionIdentityUnproven("no durable original result owner");
            await pending.turn.onNativeResultReady(frame.payload as NativeResultReady);
            pending.nativeReady=frame.payload as NativeResultReady;
          } else if (frame.event === "native_release") {
            if (!pending.turn.onNativeRelease) throw submissionIdentityUnproven("no durable original release owner");
            await pending.turn.onNativeRelease(frame.payload as NativeReleaseReceipt);
            pending.nativeReleased=frame.payload as NativeReleaseReceipt;
          } else {
            if (!pending.turn.onNativeCancelTerminal) throw submissionIdentityUnproven("no durable original cancellation owner");
            await pending.turn.onNativeCancelTerminal(frame.payload as NativeCancelTerminal);
          }
          if (this.pending.get(message.id) !== pending || pending.localFailure) throw submissionIdentityUnproven("original execution owner was lost before its ACK");
          await this.send({ type:"native_execution_ack", id:message.id, event:frame.event,
            requestId:frame.requestId, digest:frame.digest });
        });
        pending.nativeUpdates = update;
        void update.catch(() => this.abortWithLocalFailure(message.id, submissionIdentityUnproven("native execution persistence or ACK failed"), pending));
      }
      else if (message.event === "native_submission") {
        if(pending.preparationCancelled)return; // Its durable preparation cancellation precedes any slot ACK.
        const update = (pending.nativeUpdates ?? Promise.resolve()).then(async () => {
          if (!pending.turn.nativeSubmissionIdentity || !pending.turn.onNativeSubmission) throw submissionIdentityUnproven("unexpected native identity");
          try { await pending.turn.onNativeSubmission(message.record); }
          catch { throw submissionIdentityUnproven("durable parent identity acknowledgement failed"); }
          if (message.record.phase === "conflict") throw submissionIdentityUnproven("the physical Send has conflicting POSTs");
        });
        pending.nativeUpdates = update;
        void update.then(() => {
          if (this.pending.get(message.id) !== pending || pending.localFailure) return;
          return this.send({ type: "native_submission_ack", id: message.id, sendId: message.record.sendId, revision: message.record.revision, digest: nativeSubmissionDigest(message.record) });
        }).catch(() => this.abortWithLocalFailure(message.id, submissionIdentityUnproven("native identity persistence or ACK transport failed"), pending));
      }
      else if (message.event === "recovery_fence") {
        void Promise.resolve().then(() => pending.turn.authorizeRecovery?.(message.reason, message.epoch) ?? false).then(allowed => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({ type: "recovery_fence_ack", id: message.id, allowed,
            requestId: message.requestId, recoveryState: pending.turn.recoveryState });
        }).catch(error => this.abortWithLocalFailure(message.id, error instanceof Error ? error : new Error(String(error)), pending));
      }
      else if (message.event === "conversation_recovered") pending.turn.onConversationRecovered?.();
      else if (message.event === "conversation_restored") pending.turn.onConversationRestored?.();
      else if (message.event === "observation_resumed") pending.turn.onObservationResumed?.();
      else if (message.event === "reconnecting") pending.turn.onRecovering?.(message.phase);
      else if (message.event === "observation_ready") {
        if (pending.turn.nativeSubmissionIdentity && message.digest!==nativeExecutionDigest(message.checkpoint)
          || !pending.turn.onObservationReady || !pending.turn.observationIdentity
          || JSON.stringify(message.checkpoint.identity) !== JSON.stringify(pending.turn.observationIdentity)
          || message.checkpoint.traceId !== pending.turn.traceId || message.checkpoint.modelId !== pending.turn.modelId
          || message.checkpoint.accountId !== this.config.accountId || message.checkpoint.appName !== this.config.appName) {
          this.abortWithLocalFailure(message.id, observationUnavailable("helper checkpoint identity mismatch"), pending);
          return;
        }
        pending.observationUpdate = this.flushNativeUpdates(pending).then(async () => {
          await pending.turn.onObservationReady!(message.checkpoint);
          pending.observation = message.checkpoint;
        });
        void pending.observationUpdate.then(() => {
          if (this.pending.get(message.id) !== pending || pending.localFailure) return;
          return this.send({ type: "observation_ready_ack", id: message.id, ...(message.digest?{digest:message.digest}:{}) });
        }).catch(error => this.abortWithLocalFailure(message.id, error instanceof Error ? error : new Error(String(error)), pending));
      }
      else if (message.event === "browser_lease_acquired") pending.surfaceId = message.surfaceId;
      else if (message.event === "heartbeat") pending.turn.onHeartbeat?.();
      else if (message.event === "generation_progress") pending.turn.onGenerationProgress?.();
      else if (message.event === "tool_batch_observed") {
        const progress = pending.turn.externalProgress;
        if (!progress) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper observed a tool boundary for a turn without progress transport"),
            pending,
          );
          return;
        }
        void progress.acknowledgeToolBatch(message.revision).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "completion_fence_begin") {
        const fence = pending.turn.completionFence;
        if (!fence) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested a completion fence for an unfenced turn"),
            pending,
          );
          return;
        }
        void fence.begin().then(revision => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "completion_fence_begin_ack",
            id: message.id,
            requestId: message.requestId,
            revision: revision ?? null,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "completion_fence_commit") {
        const fence = pending.turn.completionFence;
        if (!fence) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested a completion fence for an unfenced turn"),
            pending,
          );
          return;
        }
        void fence.commit(message.revision).then(committed => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "completion_fence_commit_ack",
            id: message.id,
            requestId: message.requestId,
            committed,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "send_activated") {
        if(!pending.turn.nativeSubmissionIdentity)pending.sendActivated = true;
        void Promise.resolve().then(() => pending.turn.onSendActivated?.()).then(() => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({ type: "send_activation_ack", id: message.id });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "submitted") {
        const submission = (pending.submission ?? Promise.resolve()).then(() => this.flushNativeUpdates(pending)).then(() => pending.turn.onSubmitted?.());
        pending.submission = submission;
        void submission.then(() => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          if (this.helperFeatures.has("submission-ack")) return this.send({ type: "submission_ack", id: message.id });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "multipart_stage_acknowledged") {
        const multipart = pending.prepared?.multipart;
        if (!multipart
          || message.stageIndex >= multipart.parts.length
          || message.stageIndex !== (pending.acknowledgedMultipartStage ?? 0) + 1) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper acknowledged an unexpected multipart stage"),
            pending,
          );
          return;
        }
        pending.acknowledgedMultipartStage = message.stageIndex;
        void Promise.resolve().then(() => pending.turn.onMultipartStageAcknowledged?.(message.stageIndex))
          .catch(error => this.abortWithLocalFailure(
            message.id,
            error instanceof Error ? error : new Error(String(error)),
            pending,
          ));
      }
      else if (message.event === "prepared_selected") {
        const prepare = message.reused ? pending.turn.prepareResume : pending.turn.prepare;
        void Promise.resolve().then(() => prepare?.()).then(prepared => {
          if (!prepared) throw new Error("Launcher browser helper selected an unavailable continuation prompt");
          if (this.pending.get(message.id) !== pending) {
            prepared.release();
            return;
          }
          pending.prepared?.release();
          pending.prepared = prepared;
          if (prepared.skillFiles?.length && !this.helperFeatures.has("skill-attachments")) {
            throw new Error("Launcher browser helper does not support skill attachments; update or restart the launcher");
          }
          return Promise.resolve(pending.turn.onPreparedSelected?.(message.reused)).then(() => {
            if (this.pending.get(message.id) !== pending) return;
            return this.send({
              type: "prepared_selected_ack",
              id: message.id,
              prepared: {
                text: prepared.text,
                images: prepared.images,
                ...(prepared.files ? { files: prepared.files } : {}),
                ...(prepared.turnToken ? { turnToken: prepared.turnToken } : {}),
                ...(prepared.skillFiles ? { skillFiles: prepared.skillFiles } : {}),
                ...(prepared.multipart ? { multipart: prepared.multipart } : {}),
                ...(prepared.contextTokenBreakdown ? { contextTokenBreakdown: prepared.contextTokenBreakdown } : {}),
                ...(prepared.trimmedCompactionMessages !== undefined
                  ? { trimmedCompactionMessages: prepared.trimmedCompactionMessages }
                  : {}),
              } satisfies CompiledChatGptWebPrompt,
            });
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "luna_checkpoint") {
        if (!pending.turn.captureLunaCheckpoint || !pending.turn.onLunaCheckpoint) {
          this.finishWithError(message.id, new Error("Launcher browser helper emitted an unexpected Luna checkpoint"));
          return;
        }
        pending.turn.onLunaCheckpoint({ checkpoint: message.checkpoint, answerHash: message.answerHash });
      }
      else if (message.event === "reasoning" && message.text) {
        pending.turn.onReasoningSummary?.(message.text, message.continuation === true);
      }
      else if (message.event === "commentary" && message.text) pending.turn.onCommentary?.(message.text, message.continuation === true);
      else if (message.event === "text" && message.text) pending.turn.onTextDelta(message.text);
      else if (message.event === "rich_widgets") {
        try { pending.turn.onRichWidgets?.(message.widgets); }
        catch (error) {
          this.abortWithLocalFailure(message.id, error instanceof Error ? error : new Error(String(error)), pending);
        }
      }
      return;
    }
    if (message.type === "result") {
      void (pending.submission ?? Promise.resolve()).then(() => this.flushNativeUpdates(pending)).then(() => {
        if (this.pending.get(message.id) !== pending) return;
        this.finish(message.id);
        if (pending.localFailure) pending.reject(pending.localFailure);
        else if(pending.turn.nativeSubmissionIdentity && (!pending.nativeReady || !pending.nativeReleased
          || pending.nativeReleased.outcome!=="completed" || pending.nativeReady.answer!==message.text)) {
          pending.reject(submissionIdentityUnproven("helper final lacks its exact durable result and physical release"));
        } else pending.resolve(message.text);
      }, error => this.finishWithError(message.id, error instanceof Error ? error : new Error(String(error))));
    } else if (message.type === "error") {
      const error = message.status !== undefined
        ? new ChatGptWebAdapterError(message.message, {
          status: message.status,
          errorType: message.errorType!,
          code: message.code!,
          retryable: message.retryable!,
          ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
        })
        : message.name === "AbortError"
          ? new DOMException(message.message, "AbortError")
          : new Error(message.message);
      // An ACK timeout can reach this frame while the parent's durable checkpoint
      // is still being saved. Recovery must observe that result before deciding
      // whether the original execution can be resumed or remains retained.
      void Promise.allSettled([pending.submission, pending.observationUpdate, this.flushNativeUpdates(pending)]).then(() => {
        if (this.pending.get(message.id) !== pending) return;
        this.finish(message.id);
        pending.reject(pending.localFailure ?? (pending.turn.nativeSubmissionIdentity && (pending.sendActivated || pending.nativeUpdates)
          && !pending.nativeReleased && !retainsBrowserExecution(error)
          ? submissionIdentityUnproven("helper ended before original physical release was proved") : error));
      });
    }
  }

  private async flushNativeUpdates(pending: PendingTurn): Promise<void> {
    for (;;) {
      const queued = pending.nativeUpdates;
      await queued;
      if (queued === pending.nativeUpdates) return;
    }
  }
  private abortWithLocalFailure(id: string, error: Error, pending: PendingTurn): void {
    if (this.pending.get(id) !== pending || pending.localFailure) return;
    if (pending.turn.nativeSubmissionIdentity && (pending.sendActivated || pending.nativeUpdates) && !retainsBrowserExecution(error)) {
      error = submissionIdentityUnproven("native protocol failed while physical ownership is unresolved");
    }
    pending.localFailure = error;
    void this.send({ type: "abort", id,
      ...(retainsBrowserExecution(error)
        ? { reason: "recovery_budget_retained" } : {}),
    }).catch(sendError => {
      if (this.pending.get(id) !== pending) return;
      this.finishWithError(id, retainsBrowserExecution(error)
        ? submissionIdentityUnproven("retained helper control transport failed; original execution is unresolved")
        : new AggregateError([error, sendError instanceof Error ? sendError : new Error(String(sendError))],
          "Launcher browser helper could not abort after a local protocol failure"));
    });
  }

  /**
   * Mirrors daemon-recorded MCP progress into the helper process for the life of the turn.
   *
   * The browser worker runs out of process, so without this the worker sees no external progress
   * and cancels turns whose tool calls are still completing.
   */
  private forwardProgress(turn: BrowserTurn, stop: AbortSignal): void {
    const progress = turn.externalProgress;
    if (!progress) return;
    if (!this.helperFeatures.has("progress")) {
      console.warn(
        `[chatgpt-web] browser turn ${turn.traceId} runs without an MCP progress mirror:`
        + " the launcher browser helper predates the progress frame",
      );
      return;
    }
    void (async () => {
      let revision = 0;
      while (!stop.aborted) {
        const snapshot = await progress.waitForChange(revision, stop);
        revision = snapshot.revision;
        if (stop.aborted) return;
        await this.send({ type: "progress", id: turn.traceId, snapshot });
      }
    })().catch(error => {
      // Ending, aborting, or losing the helper stops the mirror by design and is not a fault.
      // Anything else leaves the worker on DOM-only health without saying so, which is exactly the
      // silent degradation this transport exists to remove, so it is surfaced rather than dropped.
      if (stop.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      console.warn(
        `[chatgpt-web] browser turn ${turn.traceId} lost its MCP progress mirror:`
        + ` ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.abortListener && pending.turn.abortSignal) {
      pending.turn.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    pending.progressForwarding?.abort();
    pending.progressForwarding = undefined;
    pending.prepared?.release();
    pending.prepared = undefined;
    this.pending.delete(id);
  }

  private finishWithError(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.finish(id);
    pending.reject(error);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    this.ready = undefined;
    this.child = undefined;
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      if (pending.turn.observation || pending.observation || pending.observationUpdate
        || pending.turn.nativeSubmissionIdentity && (pending.sendActivated || pending.nativeUpdates)) {
        void Promise.allSettled([pending.observationUpdate, this.flushNativeUpdates(pending)]).then(() => {
          if (this.pending.get(id) !== pending) return;
          this.finishWithError(id, retainsBrowserExecution(pending.localFailure) ? pending.localFailure!
            : submissionIdentityUnproven("helper exited while original browser ownership is unresolved"));
        });
        continue;
      }
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "end",
        traceId: id,
        helperPid: child.pid!,
        ...(pending.surfaceId ? { surfaceId: pending.surfaceId } : {}),
        status: "failed",
        message: "Launcher browser helper exited before completing the turn",
      }).then(
        () => { if (this.pending.get(id) === pending) this.finishWithError(id, pending.localFailure ?? error); },
        controlError => {
          if (this.pending.get(id) !== pending) return;
          this.finishWithError(id, new AggregateError(
            [pending.localFailure ?? error, controlError instanceof Error ? controlError : new Error(String(controlError))],
            `Launcher browser helper exited and failed to release turn ${id}`,
          ));
        },
      );
    }
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>(resolveExit => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
    });
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams, gracefulTimeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    if (await this.waitForExit(child, gracefulTimeoutMs)) return;
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused termination");
    }
    if (await this.waitForExit(child, 2_000)) return;
    if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused forced termination");
    }
    if (!await this.waitForExit(child, 2_000)) {
      throw new Error("Launcher browser helper did not exit after forced termination");
    }
  }

  private send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child
      || child.killed
      || child.exitCode !== null
      || child.signalCode !== null) {
      return Promise.reject(new Error("Launcher browser helper is not running"));
    }
    return this.sendTo(child, message);
  }

  private async sendTo(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("Launcher browser helper input is closed");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(encoded, error => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  }
}
