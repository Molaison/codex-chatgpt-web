import { observationSuffix, observationUnavailable, parseBrowserObservation } from "./observation-recovery";
import { DurableOperation, OperationJournal, operationRuntimeDirectory, operationDigest, retainedOperationError, type OperationRecord } from "./operation-journal";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  releaseLauncherRetainedConversation,
  readLauncherBrowserHostDescriptor,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import { ChatGptWebAdapterError, chatGptToolTimeoutError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import { chatGptEnvironmentDiagnostic, extractChatGptTurnEnvironment, extractChatGptTurnIdentity, MissingTrustedCodexEnvironmentError, priorChatGptAbortedTurnIds } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import type { ChatGptChartWidget } from "./rich-widget";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "./compaction-handoff";
import {
  chatGptConversationKey,
  chatGptQuestionAnswerNamespace,
  forkedFromThreadId,
  canonicalConversationHistory,
  retainedConversationResumeRequest,
} from "./conversation-key";

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

class ChatGptObserverDisconnected extends DOMException {
  constructor(readonly cause: unknown) {
    super("The Codex response stream disconnected", "AbortError");
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRejected = false;
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser: Promise.race([run, cancellation]),
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !cancellationRejected) {
        cancellationRejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function safeManualAdapterError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408,
      errorType: "invalid_request_error",
      code: "manual_handoff_timeout",
      retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502,
      errorType: "server_error",
      code: "manual_launcher_failed",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeManualTerminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  if (status === "cancelled") {
    return new ChatGptWebAdapterError("The Zero Risk browser turn was cancelled in the Launcher", {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  return new ChatGptWebAdapterError("The Zero Risk browser tab failed before ChatGPT completed the turn", {
    status: 502,
    errorType: "server_error",
    code: "manual_launcher_failed",
    retryable: false,
  });
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  const namespace = chatGptWebExecutionNamespace(provider);
  // The logical response key survives compaction so a final answer that won the handoff race
  // can still be replayed. A new physical browser owner must instead belong to the new context
  // epoch; otherwise Zero Risk correctly rejects it against the previous owner's completion.
  const questionAnswer = provider.chatgptWeb?.localToolsEnabled !== true;
  const conversation = parsed._compactionRequest ? undefined : chatGptConversationKey(parsed,
    questionAnswer ? chatGptQuestionAnswerNamespace(provider.chatgptWeb?.accountId) : namespace,
    { questionAnswer });
  return createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .update(conversation ? `:${conversation}` : "")
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "file") {
      const file = parseDataUrl(part.fileData);
      return { type: "resource", resource: {
        uri: "attachment:///" + encodeURIComponent(part.filename),
        mimeType: file?.mediaType ?? "application/octet-stream", blob: file?.base64 ?? part.fileData,
      } };
    }
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  if (!capabilities.localToolsEnabled) return;
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function resumesCommittedCompaction(parsed: CodexParsedRequest, summaryHash: string): boolean {
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return false;
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "compaction" && typeof record.encrypted_content === "string") {
      const summary = decodeCompactionSummary(record.encrypted_content);
      return summary !== null && operationDigest(summary) === summaryHash;
    }
    if (record.role !== "user") continue;
    const content = typeof record.content === "string" ? record.content : Array.isArray(record.content)
      ? record.content.map(block => block && typeof block === "object" && typeof block.text === "string" ? block.text : "").join("\n") : "";
    if (isReadableCompactionSummaryText(content)) return operationDigest(content.slice(SUMMARY_PREFIX.length + 1)) === summaryHash;
  }
  return false;
}

function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  // A typed transient failure is not proof that Send failed to reach ChatGPT.
  // Preserve specific terminal errors, but fence retryable failures with the
  // same submission evidence as unclassified transport failures.
  if (normalized instanceof ChatGptWebAdapterError && !normalized.retryable) return normalized;
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
  } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalSkillAttachments = provider.chatgptWeb?.experimentalSkillAttachments;
  if (experimentalSkillAttachments !== undefined && typeof experimentalSkillAttachments !== "boolean") {
    throw new Error("ChatGPT skill attachments preference must be a boolean");
  }
  if (experimentalSkillAttachments && provider.chatgptWeb?.browserInteractionMode === "manual") {
    throw new Error("Skills as files is unavailable in Zero Risk mode");
  }
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const freshConversationPerTurn = provider.chatgptWeb?.experimentalFreshConversationPerTurn === true;
  if (provider.chatgptWeb?.experimentalFreshConversationPerTurn !== undefined
    && typeof provider.chatgptWeb.experimentalFreshConversationPerTurn !== "boolean") {
    throw new Error("ChatGPT fresh conversation preference must be a boolean");
  }
  if (freshConversationPerTurn && manualInteraction) {
    throw new Error("Fresh browser conversations per turn is available only in automatic mode");
  }
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const questionAnswerNamespace = chatGptQuestionAnswerNamespace(provider.chatgptWeb?.accountId);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const operationJournal = new OperationJournal(operationRuntimeDirectory(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath)) : undefined,
    brokerSocketPath(provider),
  ));
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !experimentalBiggerContext && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: { onCompactionProgress?: () => void; operation?: DurableOperation } = {},
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !experimentalBiggerContext
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const conversationKey = !parsed._compactionRequest
      && parsed._chatgptSessionMode !== "temporary"
      && !freshConversationPerTurn
      && (parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID || experimentalBiggerContext)
      && retainedLauncherDescriptor
      ? chatGptConversationKey(checkpointInput.parsed,
        mode.localTools ? executionNamespace : questionAnswerNamespace,
        { questionAnswer: !mode.localTools })
      : undefined;
    const resumeInput = conversationKey
      ? retainedConversationResumeRequest(checkpointInput.parsed, {
        questionAnswer: !mode.localTools,
        ...(!mode.localTools ? {
          previousRequest: chatGptTurnSessions.findConversationHead(conversationKey)?.runtime.usageInput,
        } : {}),
      })
      : undefined;
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const compileOptionsFor = (input: CodexParsedRequest) => {
      if (manualRequest) return {};
      const experimentalMultipartParts = experimentalBiggerContext
        ? resolveBiggerContextMultipartParts(input, turnCapabilities, experimentalSkillAttachments)
        : undefined;
      return {
        importCodexPrompt: mode.localTools,
        captureLunaCheckpoint,
        experimentalSkillAttachments,
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
      };
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const richWidgets: ChatGptChartWidget[] = [];
    let lastGenerationNotice = 0;
    const onGenerationProgress = (): void => {
      trace.recordProgress();
      hooks.onCompactionProgress?.();
      if (hooks.operation && Date.now() - lastGenerationNotice >= 30_000) {
        lastGenerationNotice = Date.now();
        hooks.operation.notice("resumed", "已观察到ChatGPT网页仍有生成进展，继续等待当前回合；没有重新发送请求。");
      }
    };
    const observedCapabilityTokens = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      void broker.waitForRetirement(turnToken).then(
        failure => {
          const retirement = failure
            ? chatGptToolTimeoutError(failure.tool, failure.timeoutMs)
            : new Error("Codex Native retired the turn binding before its tool work completed");
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        error => {
          const failure = new Error("ChatGPT could not observe Codex Native turn retirement", {
            cause: error,
          });
          externalProgress.retire(failure);
          if (!browserAbort.signal.aborted) browserAbort.abort(failure);
        },
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    let recoveringContext = false;
    let contextRecoveries = 0;
    let conversationPreparation: "unobserved" | "fresh" | "restored" = "unobserved";
    async function observedPreparation<T>(kind: "fresh" | "restored", prepare: () => Promise<T>): Promise<T> {
      const prepared = await prepare();
      conversationPreparation = kind;
      return prepared;
    }
    // A canonical compaction request is side-effect free and remains safe to rebuild after an
    // ambiguous browser send. Normal task prompts must never be replayed after Send activation.
    const submissionLifecycle = {
      onConversationRecovered: () => { hooks.operation?.notice("conversation_forked"); },
      onRecovering: (phase?: "connector_waiting" | "connector_refreshing" | "network_waiting" | "saved_conversation_waiting" | "model_selection_restoring") => {
        hooks.operation?.notice("reconnecting", phase === "connector_refreshing"
          ? "正在刷新ChatGPT连接器目录；本条消息尚未发送，不会重放旧工具。"
          : phase === "connector_waiting"
            ? "正在等待ChatGPT连接器目录加载；仍在原账号，本条消息尚未发送。"
            : phase === "model_selection_restoring"
              ? "ChatGPT模型控件发生变化，正在重新核对原型号和档位；本条消息尚未发送。"
            : phase === "saved_conversation_waiting"
              ? "ChatGPT已接收本条消息，正在等待原保存会话就绪；不会再次发送或重复执行工具。"
            : phase === "network_waiting"
              ? "已观察到浏览器网络中断，正在服务端等待恢复；保持原账号和上下文，不会重复执行工具。" : undefined);
      },
      onConversationRestored: () => {
        conversationPreparation = "restored";
        hooks.operation?.notice("conversation_restored");
      },
      onSendActivated: () => {
        hooks.operation?.beforeSend();
        if (!parsed._compactionRequest) submission.phase = "send_activated";
      },
      onSubmitted: () => {
        hooks.operation?.accepted();
        if (!parsed._compactionRequest) submission.phase = "accepted";
        const operation = hooks.operation;
        const observation = operation?.record.observation;
        const parent = forkedFromThreadId(parsed);
        if (operation && !parsed._compactionRequest && !recoveringContext && conversationPreparation === "fresh"
          && parent?.trim() && parent !== identity.threadId && observation
          && observation.identity.operationId === operation.record.operationId
          && observation.identity.executionKey === operation.record.executionKey
          && observation.identity.roundKey === chatGptTurnRoundKey(parsed)
          && observation.identity.threadId === identity.threadId && observation.identity.turnId === identity.turnId
          && observation.conversation.key === conversationKey
          && !operation.record.forkNoticeEmitted) {
          operation.record.forkNoticeEmitted = true;
          operation.notice("conversation_forked");
        }
        hooks.onCompactionProgress?.();
      },
    };
    const multipartProgressLifecycle = hooks.onCompactionProgress
      ? { onMultipartStageAcknowledged: hooks.onCompactionProgress }
      : {};
    if (manualRequest) {
      if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
      if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
      const token = deferred<string>();
      const externalProgress = new ChatGptExternalTurnProgress();
      const surfaceNonce = randomBytes(32).toString("base64url");
      const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
      let tokenSettled = false;
      let activeToken: string | undefined;
      let launcherStarted = false;
      let launcherEnded = false;
      const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
        if (!launcherStarted || launcherEnded) return;
        await zeroRiskManualControl.end(retainedLauncherDescriptor, {
          ...owner,
          status,
          ...(status === "completed" && retainConversation ? { retain: true } : {}),
        });
        launcherEnded = true;
      };
      const runManual = async (): Promise<string> => {
        try {
          activeToken = await broker.registerSafe(environment, surfaceNonce, undefined, traceId);
          observeCapabilityRetirement(activeToken, externalProgress);
          const compiled = compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            activeToken,
            { manualControl: true },
          );
          const resumeCompiled = resumeInput
            ? compileChatGptWebPrompt(
              resumeInput,
              turnCapabilities,
              activeToken,
              { manualControl: true },
            )
            : undefined;
          for (const candidate of [compiled, resumeCompiled]) {
            if (!candidate) continue;
            if (candidate.multipart) {
              throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
                status: 409,
                errorType: "invalid_request_error",
                code: "manual_multipart_unsupported",
                retryable: false,
              });
            }
          }
          tokenSettled = true;
          token.resolve(activeToken);
          if (!parsed._compactionRequest) {
            trace.push({
              kind: "commentary",
              text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the plugin shown in the launcher and the model you want, send the prompt, then confirm it was sent in the launcher.",
            });
          }
          hooks.operation?.beforeSend();
          await zeroRiskManualControl.start(retainedLauncherDescriptor, {
            ...owner,
            prompt: compiled.text,
            ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
            ...(conversationKey ? { conversationKey } : {}),
            ...(parsed._compactionRequest ? { compaction: true as const } : {}),
          });
          launcherStarted = true;
          await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
            abortSignal: browserAbort.signal,
          });
          await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
          hooks.operation?.accepted();
          submission.phase = "accepted";
          if (!parsed._compactionRequest) trace.push({
            kind: "commentary",
            text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for the selected ChatGPT plugin to connect.",
          });
          const terminalAbort = new AbortController();
          const abortTerminal = () => terminalAbort.abort();
          browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
          const terminalFailure = zeroRiskManualControl.waitTerminal(
            retainedLauncherDescriptor,
            owner,
            { abortSignal: terminalAbort.signal },
          ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
            .catch(error => terminalAbort.signal.aborted
              ? new Promise<never>(() => {})
              : Promise.reject(error));
          let answer: string;
          try {
            await Promise.race([
              broker.waitForSafeStart(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
            await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Zero Risk connected**\n>\n> The Zero Risk plugin is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
            });
            answer = await Promise.race([
              broker.waitForSafeCompletion(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
          } finally {
            terminalAbort.abort();
            browserAbort.signal.removeEventListener("abort", abortTerminal);
          }
          text.push(answer);
          try {
            await finishLauncher("completed");
          } catch (controlError) {
            // The broker result is already authoritative. A launcher acknowledgement failure may
            // leave UI cleanup pending, but it must not replace a completed Codex answer with an
            // error or trigger a contradictory failed terminal mutation.
            console.error(
              `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          return answer;
        } catch (error) {
          const normalized = safeManualAdapterError(error);
          // Capture the causal state before our own cleanup revokes the broker capability. The
          // retirement observer also aborts browserAbort, but that self-induced abort must not turn
          // an ordinary launcher/runtime failure into a user cancellation.
          const externallyAborted = browserAbort.signal.aborted;
          if (activeToken) await Promise.resolve(broker.revoke(activeToken, normalized, { source: "runtime.failure", reason: externallyAborted ? "cancelled" : "failure" })).catch(() => {});
          try {
            await finishLauncher(externallyAborted ? "aborted" : "failed");
          } catch (controlError) {
            console.error(
              `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          throw normalized;
        }
      };
      const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runManual()), browserAbort);
      void browserTurn.browser.catch(error => {
        if (tokenSettled) return;
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        mode: "tools",
        token: token.promise,
        externalProgress,
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        richWidgets,
        usageInput: checkpointInput.parsed,
        manualControl: { surfaceNonce },
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        retireCapability: async () => {
          if (activeToken) await broker.revoke(activeToken, undefined, { source: "runtime.retire", reason: "cleanup" });
        },
        submission,
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (activeToken) {
            void Promise.resolve(broker.revoke(activeToken, reason, { source: "runtime.cancel", reason: "cancelled" })).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      };
    }
    const checkpointRecovery = (): void => {
      recoveringContext = true;
      contextRecoveries++;
      submission.phase = "prepared";
      const operation = hooks.operation;
      if (!operation) return;
      operation.record.recoveryAttempts = [...(operation.record.recoveryAttempts ?? []), {
        at: Date.now(), submission: operation.record.submission, ...(operation.record.observation ? { observation: operation.record.observation } : {}),
      }];
      delete operation.record.observation;
      delete operation.record.observationRound;
      operation.record.attempt++;
      operation.record.submission = "prepared";
      operation.record.generation = "not_started";
      operation.checkpoint();
    };
    if (!mode.localTools) {
      const prepareQuestion = async (input: CodexParsedRequest, fresh = false) => {
        if (fresh && input._chatgptSavedConversationContinuation && !recoveringContext) {
          throw new ChatGptWebAdapterError("The verified previous response requires its saved ChatGPT conversation; a fresh chat was not created", {
            status: 409, errorType: "invalid_request_error", code: "saved_conversation_not_restored", retryable: false,
          });
        }
        const options = compileOptionsFor(input);
        const compiled = compileChatGptWebPrompt(input, turnCapabilities, undefined, options);
        if (fresh && !input._compactionRequest && forkedFromThreadId(input)) {
          // Use the actual QA compiler so runtime envelopes, skills and tool traffic
          // cannot masquerade as inherited history. A restored child uses prepareResume
          // and already has its baseline in the saved chat, so it skips this cold-start check.
          for (let index = input.context.messages.length - 1; index >= 0; index--) {
            const message = input.context.messages[index]!;
            if (message.role !== "user") continue;
            let question: ReturnType<typeof compileChatGptWebPrompt>;
            try {
              question = compileChatGptWebPrompt({ ...input,
                context: { ...input.context, messages: [message] },
              }, turnCapabilities, undefined, options);
            } catch (error) {
              if (error instanceof ChatGptWebAdapterError && error.code === "question_missing") continue;
              throw error;
            }
            if (compiled.text === question.text && JSON.stringify(compiled.images) === JSON.stringify(question.images)) {
              throw new ChatGptWebAdapterError("A new fork requires its pre-fork conversation history; no question was submitted", {
                status: 400, errorType: "invalid_request_error", code: "fork_history_missing", retryable: false,
              });
            }
            break;
          }
        }
        return { ...compiled, release: () => {} };
      };
      const project = (parsed._rawBody as { client_metadata?: { _chatgpt_project?: { id: string; name: string } } } | undefined)?.client_metadata?._chatgpt_project;
      const sessionMode = parsed._chatgptSessionMode ?? (parsed._rawBody as { client_metadata?: { _chatgpt_session_mode?: "temporary" | "persistent" } } | undefined)?.client_metadata?._chatgpt_session_mode;
      const deferTextUntilComplete = (parsed._rawBody as { client_metadata?: { _chatgpt_defer_text_until_complete?: boolean } } | undefined)?.client_metadata?._chatgpt_defer_text_until_complete === true;
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        ...(hooks.operation && identity.threadId && identity.turnId && conversationKey
          && !parsed._compactionRequest && !captureLunaCheckpoint && sessionMode !== "temporary"
          && retainedLauncherDescriptor && readLauncherBrowserHostDescriptor(retainedLauncherDescriptor).observationInstanceId ? {
          observationIdentity: { operationId: hooks.operation.record.operationId, executionKey: hooks.operation.record.executionKey,
            roundKey: chatGptTurnRoundKey(parsed), threadId: identity.threadId, turnId: identity.turnId },
          onObservationReady: (checkpoint: import("./observation-recovery").BrowserObservationCheckpoint) => {
            hooks.operation!.record.observation = checkpoint;
            hooks.operation!.record.conversationKey = conversationKey;
            hooks.operation!.record.observationRound ??= { roundKey: chatGptTurnRoundKey(parsed), deliveredToolResults: {} };
            hooks.operation!.checkpoint();
            hooks.operation!.notice("account_pinned");
          },
        } : {}),
        authorizeRecovery: async reason => {
          if (reason) return false;
          if (text.value() || contextRecoveries >= 3 || !hooks.operation) return false;
          checkpointRecovery(); return true;
        },
        ...(project && !parsed._compactionRequest ? { project } : {}),
        ...(sessionMode && !parsed._compactionRequest ? { sessionMode } : {}),
        ...(deferTextUntilComplete && !parsed._compactionRequest ? { deferTextUntilComplete: true } : {}),
        reasoning: parsed.options.reasoning,
        ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
        ...(parsed._chatgptProModel ? { proModel: true } : {}),
        capabilities: turnCapabilities,
        canonicalHistory: canonicalConversationHistory(checkpointInput.parsed),
        prepare: () => observedPreparation("fresh", () => prepareQuestion(checkpointInput.parsed, true)),
        ...(resumeInput ? { prepareResume: () => observedPreparation("restored", () => prepareQuestion(resumeInput)) } : {}),
        ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => { text.push(delta); onGenerationProgress(); },
        ...(deferTextUntilComplete ? { onRichWidgets: (widgets: ChatGptChartWidget[]) => { richWidgets.push(...widgets); } } : {}),
        onGenerationProgress,
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        richWidgets,
        usageInput: checkpointInput.parsed,
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        submission,
        cancel: browserTurn.cancel,
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    let browserToken: string | undefined;
    let receiptRecoveryInput: CodexParsedRequest | undefined;
    const prepareWith = async (input: CodexParsedRequest) => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
      browserToken ??= turnToken;
      try {
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          browserToken,
          { ...compileOptionsFor(input), ...(receiptRecoveryInput ? { completedNativeReceiptRecovery: true } : {}) },
        );
        // Publish only after preparation succeeds: otherwise its failure revokes the token
        // before the response observer uses it and masks the cause as an expired capability.
        observeCapabilityRetirement(turnToken, externalProgress);
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken, undefined, { source: "runtime.prepare", reason: "failure" });
        activeToken = undefined;
        throw error;
      }
    };
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      ...(hooks.operation && identity.threadId && identity.turnId && conversationKey
        && !parsed._compactionRequest && !captureLunaCheckpoint && parsed._chatgptSessionMode !== "temporary"
        && retainedLauncherDescriptor && readLauncherBrowserHostDescriptor(retainedLauncherDescriptor).observationInstanceId ? {
        observationIdentity: { operationId: hooks.operation.record.operationId, executionKey: hooks.operation.record.executionKey,
          roundKey: chatGptTurnRoundKey(parsed), threadId: identity.threadId, turnId: identity.turnId },
        onObservationReady: (checkpoint: import("./observation-recovery").BrowserObservationCheckpoint) => {
          if (!activeToken || checkpoint.toolChannel?.tokenHash !== operationDigest(browserToken ?? activeToken)) {
            throw observationUnavailable("the original native channel does not match its browser checkpoint");
          }
          hooks.operation!.record.observation = checkpoint;
          hooks.operation!.record.conversationKey = conversationKey;
          hooks.operation!.record.observationRound ??= { roundKey: chatGptTurnRoundKey(parsed), deliveredToolResults: {} };
          hooks.operation!.checkpoint();
          hooks.operation!.notice("account_pinned");
        },
      } : {}),
      authorizeRecovery: async reason => {
        if (text.value() || contextRecoveries >= 3 || !hooks.operation) return false;
        if (reason === "receipt_only_failure" && !receiptRecoveryInput) return false;
        if (reason === "delivery_loss") {
          const accepted = hooks.operation.record.observationRound?.deliveredToolResults;
          if (!activeToken || !accepted || !broker.recoverCompletedReceipts) return false;
          const recovery = await broker.recoverCompletedReceipts(activeToken, accepted);
          if (!recovery) return false;
          const messages = [...checkpointInput.parsed.context.messages];
          for (const receipt of recovery.receipts) {
            if (receipt.resultHash !== operationDigest(JSON.stringify(receipt.result))
              || accepted[receipt.request.callId] !== receipt.resultHash || receipt.request.freeform) {
              throw new Error("Completed Native context receipt failed validation");
            }
            messages.push({ role: "assistant", timestamp: Date.now(), content: [{ type: "toolCall",
              id: receipt.request.callId, name: receipt.request.wireName, arguments: receipt.request.arguments! }] });
            messages.push({ role: "toolResult", timestamp: Date.now(), toolCallId: receipt.request.callId,
              toolName: receipt.request.wireName, content: JSON.stringify(receipt.result), isError: receipt.result.isError === true });
          }
          receiptRecoveryInput = { ...checkpointInput.parsed, context: { ...checkpointInput.parsed.context, messages } };
          browserToken = recovery.token;
          checkpointRecovery();
          hooks.operation.record.observationRound = { roundKey: chatGptTurnRoundKey(parsed), deliveredToolResults: { ...accepted } };
          hooks.operation.checkpoint();
          return true;
        }
        if (receiptRecoveryInput && activeToken && broker.recoverCompletedReceipts) {
          const accepted = hooks.operation.record.observationRound?.deliveredToolResults;
          if (!accepted) return false;
          const retry = await broker.recoverCompletedReceipts(activeToken, accepted, true);
          if (!retry) return false;
          browserToken = retry.token;
          checkpointRecovery();
          hooks.operation.record.observationRound = { roundKey: chatGptTurnRoundKey(parsed), deliveredToolResults: { ...accepted } };
          hooks.operation.checkpoint();
          return true;
        }
        // History rollback is detected before prepare/register, so no current
        // browser capability exists yet. Durable admission still fences older owners.
        if (!activeToken && hooks.operation.record.submission === "prepared" && !hooks.operation.record.observation) {
          checkpointRecovery(); return true;
        }
        if (!activeToken || !broker.rotateForRecovery) return false;
        const replacement = await broker.rotateForRecovery(activeToken);
        if (!replacement) return false;
        browserToken = replacement;
        checkpointRecovery();
        return true;
      },
      ...(!parsed._compactionRequest ? { sessionMode: parsed._chatgptSessionMode ?? "persistent" } : {}),
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      ...(parsed._chatgptProModel ? { proModel: true } : {}),
      capabilities: turnCapabilities,
      canonicalHistory: canonicalConversationHistory(checkpointInput.parsed),
      prepare: () => observedPreparation("fresh", () => prepareWith(receiptRecoveryInput ?? checkpointInput.parsed)),
      ...(resumeInput ? { prepareResume: () => observedPreparation("restored", () => prepareWith(resumeInput)) } : {}),
      ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...submissionLifecycle,
      ...multipartProgressLifecycle,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => { text.push(delta); onGenerationProgress(); },
      onGenerationProgress,
      externalProgress,
      completionFence: {
        begin: async () => broker.beginCompletionFence(await token.promise),
        commit: async revision => broker.commitCompletionFence(await token.promise, revision),
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }))), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      usageInput: checkpointInput.parsed,
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      retireCapability: async () => {
        if (activeToken) await broker.revoke(activeToken, undefined, { source: "runtime.retire", reason: "cleanup" });
      },
      submission,
      cancel: (reason?: Error) => {
        browserTurn.cancel(reason);
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken, reason, { source: "runtime.cancel", reason: "cancelled" })).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const observerAbort = new AbortController();
      incoming = {
        ...incoming,
        abortSignal: incoming.abortSignal
          ? AbortSignal.any([incoming.abortSignal, observerAbort.signal])
          : observerAbort.signal,
      };
      const write = emit;
      emit = event => {
        if (incoming.abortSignal?.aborted) {
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        try { write(event); }
        catch (cause) {
          // The response writer is an observer, not the owner of browser execution. Its
          // failure must follow the existing disconnect path even before HTTP signals abort.
          const error = new ChatGptObserverDisconnected(cause);
          observerAbort.abort(error);
          throw error;
        }
      };
      const runChatGptWebTurn = async (): Promise<void> => {
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = (parsed._compactionRequest || parsed._chatgptLocalTools === false) && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools) {
          try {
            environment = environmentStore.resolve(parsed);
          } catch (error) {
            const identity = extractChatGptTurnIdentity(parsed);
            console.warn(
              "[chatgpt-web] trusted_environment_unavailable " + JSON.stringify({
                threadSha256: identity.threadId ? createHash("sha256").update(identity.threadId).digest("hex") : undefined,
                branch: error instanceof MissingTrustedCodexEnvironmentError ? error.resolutionBranch : "other_validation_error",
                ...chatGptEnvironmentDiagnostic(parsed),
              }),
            );
            throw error;
          }
        }
        if (parsed._compactionRequest) {
          const structuredCompactionRequired = (parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID || experimentalBiggerContext)
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired
            && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
            emit({
              type: "error",
              message: manualRequest
                ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
                : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256")
              .update(compactionExecutionKey)
              .digest("hex")
              .slice(0, 12);
            const freshCompactionTraceId = `${handoffTraceId}_${freshConversationPerTurn ? "fresh" : "fallback"}`;
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            const compactionRoundKey = chatGptTurnRoundKey(parsed);
            let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
            let compactionOperation: DurableOperation | undefined;
            let previousCompaction: OperationRecord | undefined;
            const compactionSettlements: Promise<void>[] = [];
            let continuationSource: DurableOperation | undefined;
            const markCompactionSource = (operation?: DurableOperation): void => {
              if (!operation || continuationSource === operation) return;
              operation.record.compactionContinuation = { compactionExecutionKey,
                compactionOperationId: compactionOperation!.record.operationId };
              operation.checkpoint(); // Fence summary-vs-ordinary-final before giving the source a handoff instruction.
              continuationSource = operation;
            };
            if (!sharedSummary) {
              const saved = operationJournal.read<OperationRecord>(compactionExecutionKey);
              if (saved) {
                if (saved.generation === "final" && saved.final) sharedSummary = Promise.resolve(saved.final.answer);
                else if (saved.physicalSettled && saved.error) previousCompaction = saved;
                else throw retainedOperationError();
              }
            }
            if (!sharedSummary) {
              compactionOperation = new DurableOperation(operationJournal, {
                version: 1, operationId: `op_${operationDigest(compactionExecutionKey)}`,
                executionKey: compactionExecutionKey, traceId: compactionTraceId,
                ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                threadId: compactionNativeIdentity.threadId, turnId: compactionNativeIdentity.turnId,
                requestIds: (incoming.headers.get("x-request-id") ?? incoming.headers.get("x-cpr-request-id"))
                  ? [operationDigest((incoming.headers.get("x-request-id") ?? incoming.headers.get("x-cpr-request-id"))!)] : [],
                submission: "prepared", generation: "not_started", delivery: "attached", recovery: "none",
                seq: previousCompaction?.seq ?? 0, attempt: (previousCompaction?.attempt ?? 0) + 1, updatedAt: Date.now(),
                rounds: { [compactionRoundKey]: { events: [], reasoning: [], completed: false } },
              });
              compactionOperation.checkpoint();
              sharedSummary = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [
                    compactionTraceId,
                    handoffTraceId,
                    freshCompactionTraceId,
                  ],
                  ...(compactionNativeIdentity.threadId
                    ? { nativeThreadId: compactionNativeIdentity.threadId }
                    : {}),
                  ...(compactionNativeIdentity.turnId
                    ? { nativeTurnId: compactionNativeIdentity.turnId }
                    : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const retainCompactionOwnerUntil = (settlement: Promise<void>): void => {
                    compactionSettlements.push(settlement);
                    retainOwnershipUntil(settlement);
                  };
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  const handoffDeadline = new AbortController();
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_handoff_timeout",
                      retryable: false,
                    },
                  );
                  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
                  let handoffPhase = "source_settlement";
                  const armHandoffDeadline = (): void => {
                    if (handoffDeadline.signal.aborted) return;
                    if (handoffTimer) clearTimeout(handoffTimer);
                    handoffTimer = setTimeout(
                      () => {
                        console.warn(`[chatgpt-web] compaction_timeout ${JSON.stringify({
                          traceId: compactionTraceId, phase: handoffPhase, timeoutMs: handoffTimeoutMs,
                        })}`);
                        handoffDeadline.abort(handoffTimeoutError);
                      },
                      handoffTimeoutMs,
                    );
                    handoffTimer.unref?.();
                  };
                  armHandoffDeadline();
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
                  const runFreshCompaction = async (reason: string): Promise<string> => {
                    handoffPhase = "fresh_compaction";
                    if (freshConversationPerTurn) console.info("[chatgpt-web] compaction uses configured fresh conversation mode");
                    else console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    // Fresh compaction is a bounded phase. Each exact multipart acknowledgement
                    // and the final accepted compact prompt re-arms the five-minute liveness budget;
                    // transport time cannot consume the model-generation window.
                    armHandoffDeadline();
                    const fallbackRuntime = startRuntime(
                      parsed,
                      manualRequest ? environment : undefined,
                      freshCompactionTraceId,
                      turnCapabilities,
                      { onCompactionProgress: armHandoffDeadline, operation: compactionOperation },
                    );
                    retainCompactionOwnerUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
                      await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
                      return canonicalizeCompactionHandoff(parsed, rawSummary);
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      // The shared owner retains physical settlement independently of this error.
                      // Neither a timeout nor operator cancellation can open a competing trace.
                      throw error;
                    }
                  };
                  let source: ChatGptTurnSession | undefined;
                  let stopSourceProgress: (() => void) | undefined;
                  let preserveFinalResponse = false;
                  try {
                    if (freshConversationPerTurn) {
                      // Full native history is the compaction input. Release an unfinished
                      // browser/tool owner before rebuilding it, but keep a committed final
                      // replayable if it won the native compaction race.
                      const previous = chatGptTurnSessions.find(compactedSourceExecutionKey);
                      const settlement = previous?.settledOutcome()?.type === "final"
                        ? previous.physicalSettlement
                        : chatGptTurnSessions.retireAndWait(compactedSourceExecutionKey).then(() => {});
                      retainCompactionOwnerUntil(settlement);
                      await withAbort(settlement, operationSignal);
                      if (previous && previous.settledOutcome()?.type !== "final") markCompactionSource(previous.runtime.operation);
                      return await runFreshCompaction("configured_fresh_conversation");
                    }
                    // The previous compaction may already have detached the retained head while
                    // its browser/helper is still unwinding. Do not inspect that old epoch or
                    // decide to open a fresh fallback until physical release has completed.
                    if (sourceConversationKey) {
                      await chatGptTurnSessions.waitForConversationRetirement(
                        sourceConversationKey,
                        operationSignal,
                      );
                    }
                    source = sourceConversationKey
                      ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                      : undefined;
                    preserveFinalResponse = !source?.isActive()
                      && source?.settledOutcome()?.type === "final";
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      return await runFreshCompaction("source_unavailable_before_handoff");
                    }
                    // Renew only for observed source activity, never an idle helper heartbeat.
                    stopSourceProgress = source.runtime.trace.observeProgress(armHandoffDeadline);
                    compactionOperation!.beforeSend();
                    let rawSummary: string;
                    if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
                      markCompactionSource(source.runtime.operation);
                      const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                        parsed,
                        source,
                        broker,
                        operationSignal,
                      );
                      if (zeroRiskSummary === undefined) {
                        preserveFinalResponse = true;
                        rawSummary = await runFreshCompaction("zero_risk_source_had_no_compaction_boundary");
                      } else {
                        rawSummary = zeroRiskSummary;
                      }
                    } else if (manualRequest) {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await runFreshCompaction("zero_risk_source_already_completed");
                    } else if (source.isActive() && source.runtime.mode === "tools") {
                      markCompactionSource(source.runtime.operation);
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      // The previous response has physically settled. Its waiting time must not
                      // consume the independent, bounded request for the retained checkpoint.
                      stopSourceProgress?.();
                      handoffPhase = "retained_checkpoint";
                      armHandoffDeadline();
                      compactionOperation!.beforeSend();
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      stopSourceProgress?.();
                      handoffPhase = "retained_checkpoint";
                      armHandoffDeadline();
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    await withAbort(
                      preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    if (preserveFinalResponse && continuationSource) {
                      delete continuationSource.record.compactionContinuation;
                      continuationSource.checkpoint();
                      continuationSource = undefined;
                    } else if (!preserveFinalResponse) markCompactionSource(source.runtime.operation);
                    return summary;
                  } catch (error) {
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    try {
                      // Operator cancellation ends the logical compaction, but cancel-all must not
                      // acknowledge until the retained browser/helper owner has physically retired.
                      await (preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source!,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey));
                    } catch (retirementError) {
                      handoffError = new AggregateError(
                        [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                        "Structured compaction failed and its retained conversation could not be retired",
                      );
                    }
                    if (preserveFinalResponse && continuationSource) {
                      delete continuationSource.record.compactionContinuation;
                      continuationSource.checkpoint();
                      continuationSource = undefined;
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      return await runFreshCompaction("source_disappeared_before_handoff");
                    }
                    throw handoffError;
                  } finally {
                    stopSourceProgress?.();
                    if (handoffTimer) clearTimeout(handoffTimer);
                  }
                },
              ).then(summary => {
                const events: AdapterEvent[] = [{ type: "text_delta", text: summary, phase: "final_answer" }];
                emitBrowserCompletion({ type: "final", answer: summary },
                  estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities,
                    experimentalBiggerContext, experimentalSkillAttachments), event => events.push(event));
                const record = compactionOperation!.record;
                if (continuationSource) {
                  continuationSource.record.compactionContinuation!.summaryHash = operationDigest(summary);
                  continuationSource.checkpoint();
                }
                record.generation = "final"; record.delivery = "unknown"; record.physicalSettled = true;
                record.final = { answer: summary, events, reasoning: [] };
                record.rounds[compactionRoundKey] = { events, reasoning: [], completed: true };
                compactionOperation!.checkpoint();
                return summary;
              }, error => {
                const record = compactionOperation!.record;
                record.generation = "unknown"; record.recovery = "retained";
                record.error = { code: error instanceof ChatGptWebAdapterError ? error.code : undefined, retryable: false };
                compactionOperation!.checkpoint();
                // Canonical compaction is side-effect free. Preserve its existing explicit
                // rebuild only after the original physical owner has proven retirement. A
                // crash before this checkpoint leaves unknown retained, never a new Send.
                if (compactionSettlements.length || record.submission === "prepared") {
                  void Promise.all(compactionSettlements).then(() => {
                    record.physicalSettled = true;
                    compactionOperation!.checkpoint();
                  }).catch(() => console.error(`[chatgpt-web] compaction retirement checkpoint unavailable; trace=${compactionTraceId}, recovery=retained`));
                }
                throw error;
              });
            }
            emit({ type: "heartbeat" });
            let summary: string;
            try {
              summary = await withAbort(sharedSummary, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              console.error("[chatgpt-web] structured context handoff failed:", handoffError);
              const upstreamError = handoffError instanceof ChatGptWebAdapterError ? handoffError : undefined;
              emit({
                type: "error",
                message: upstreamError?.message ?? `ChatGPT did not complete the context handoff: ${handoffError.message}`,
                status: upstreamError?.status ?? 409,
                errorType: upstreamError?.errorType ?? "invalid_request_error",
                code: upstreamError?.code ?? "compaction_handoff_failed",
                // Compaction retry remains an explicit operator decision even when its source
                // failure was retryable; preserve the cause without opening a new retry loop.
                retryable: false,
              });
              return;
            }
            const checkpoint = operationJournal.read<OperationRecord>(compactionExecutionKey);
            const events = checkpoint?.rounds[compactionRoundKey]?.events;
            if (!events) throw retainedOperationError();
            replayEvents(events, emit);
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
          const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
          if (sourceConversationKey && chatGptTurnSessions.findConversationHead(sourceConversationKey)) {
            await withAbort(chatGptTurnSessions.retireConversationAndWait(sourceConversationKey), incoming.abortSignal);
          } else {
            await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
          }
        }
        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerNamespace = mode.localTools ? executionNamespace : questionAnswerNamespace;
        const ownerKey = `${ownerNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = manualRequest ? new Set(priorChatGptAbortedTurnIds(parsed)) : undefined;
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        const traceId = chatGptWebTraceId(provider, parsed);
        const session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => {
            const saved = operationJournal.read<OperationRecord>(executionKey);
            const continuation = saved?.compactionContinuation;
            const committed = continuation?.summaryHash
              ? operationJournal.read<OperationRecord>(continuation.compactionExecutionKey) : undefined;
            const resumeCompaction = Boolean(saved?.physicalSettled && continuation?.summaryHash
              && committed?.generation === "final" && committed.final
              && committed.operationId === continuation.compactionOperationId
              && operationDigest(committed.final.answer) === continuation.summaryHash
              && resumesCommittedCompaction(parsed, continuation.summaryHash));
            if (continuation && !resumeCompaction) throw retainedOperationError();
            // Only an observed, retryable pre-Send failure permits another attempt.
            const safeRetry = saved?.submission === "prepared" && saved.error?.retryable === true;
            if (saved && !safeRetry && !resumeCompaction) {
              if (saved.version !== 1 || saved.executionKey !== executionKey) throw new Error("Invalid operation identity; dispatch blocked");
              const operation = new DurableOperation(operationJournal, saved);
              if (saved.generation !== "final" || !saved.final) {
                const c = saved.observation && parseBrowserObservation(saved.observation);
                const roundKey = chatGptTurnRoundKey(parsed);
                const round = saved.rounds[roundKey];
                if (c && !manualRequest && !parsed._compactionRequest
                  && saved.submission === "accepted" && !saved.physicalSettled && round && !round.completed
                  && saved.rounds[c.identity.roundKey]
                  && !round.events.some(event => event.type === "tool_call_start" || event.type === "error")
                  && c.identity.operationId === saved.operationId && c.identity.executionKey === executionKey
                  && (mode.localTools ? saved.observationRound?.roundKey === roundKey : c.identity.roundKey === roundKey)
                  && c.identity.threadId === nativeIdentity.threadId
                  && c.identity.turnId === nativeTurnId && c.traceId === traceId && c.modelId === parsed.modelId
                  && saved.threadId === nativeIdentity.threadId && saved.turnId === nativeTurnId
                  && saved.ownerKey === ownerKey && c.conversation.key === saved.conversationKey) {
                  const inspectTools = () => {
                    if (!mode.localTools) return undefined;
                    if (!structuredBroker || !c.toolChannel || !saved.observationRound) throw observationUnavailable("the original native owner proof is unavailable");
                    const delivered = saved.observationRound.deliveredToolResults;
                    for (const [id, hash] of Object.entries(delivered)) {
                      const matches = parsed.context.messages.filter(message => message.role === "toolResult" && message.toolCallId === id);
                      if (matches.length !== 1 || operationDigest(JSON.stringify(brokerResult(matches[0] as CodexToolResultMessage))) !== hash) {
                        throw observationUnavailable("the reconnect round does not contain the original terminal tool result");
                      }
                    }
                    try { return structuredBroker.inspectRetainedObservation(c.toolChannel.tokenHash, c.traceId, delivered); }
                    catch (error) { throw observationUnavailable(error instanceof Error ? error.message : "native proof unavailable"); }
                  };
                  let toolFence: ReturnType<typeof inspectTools>;
                  try { toolFence = inspectTools(); } catch (error) {
                    emit({ type: "provider_notice", notice: operation.notice("needs_reconcile") }); throw error;
                  }
                  const prefix = Object.values(saved.rounds).flatMap(value => value.events).filter(event => event.type === "text_delta" && event.phase === "final_answer")
                    .map(event => (event as { text: string }).text).join("");
                  const text = new ChatGptTextFeed();
                  text.push(prefix); text.drain();
                  const suffix = observationSuffix(prefix, delta => text.push(delta));
                  const abort = new AbortController();
                  operation.notice("reconnecting");
                  const browser = worker.run({ traceId, modelId: parsed.modelId, capabilities: turnCapabilities,
                    observation: c, ...(toolFence ? { observationToolFence: toolFence } : {}), abortSignal: abort.signal,
                    prepare: async () => { throw observationUnavailable("an observer cannot prepare a prompt"); },
                    onTextDelta: delta => suffix.push(delta),
                    onConversationRestored: () => { operation.notice("conversation_restored"); },
                    onObservationResumed: () => { operation.notice("resumed"); },
                  }).then(answer => {
                    if (toolFence && inspectTools()?.digest !== toolFence.digest) throw observationUnavailable("original native receipt state changed during observation");
                    suffix.finish(answer); return answer;
                  });
                  return { mode: "read-only" as const, operation, browser,
                    physicalSettlement: browser.then(() => undefined, () => undefined), trace: new ChatGptTraceFeed(), text,
                    submission: { phase: "accepted" as const }, usageInput: parsed, conversationKey: saved.conversationKey,
                    cancel(reason?: Error) { abort.abort(reason); } };
                }
                saved.recovery = "retained";
                operation.checkpoint();
                console.info(`[chatgpt-web] execution_retained ${JSON.stringify(operation.receipt())}`);
                throw retainedOperationError();
              }
              // Replay the persisted prefix; only a final not yet journaled needs a suffix.
              const round = saved.rounds[chatGptTurnRoundKey(parsed)];
              if (round?.events.some(event => event.type === "tool_call_start")) throw retainedOperationError();
              const prefix = round?.events.filter(event => event.type === "text_delta" && event.phase === "final_answer")
                .map(event => (event as { text: string }).text).join("") ?? "";
              const suffix = saved.final.answer.slice(prefix.length);
              const restoredText = new ChatGptTextFeed();
              restoredText.push(prefix); restoredText.drain(); restoredText.push(suffix);
              return { mode: "read-only" as const, operation, browser: Promise.resolve(saved.final.answer),
                physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: restoredText,
                submission: { phase: saved.submission }, usageInput: parsed,
                conversationKey: saved.conversationKey, cancel() {} };
            }
            const unresolved = operationJournal.unresolvedOwner(ownerKey, executionKey);
            if (unresolved && !chatGptTurnSessions.find(unresolved.executionKey)) throw retainedOperationError();
            const operation = new DurableOperation(operationJournal, {
              version: 1, operationId: `op_${operationDigest(executionKey)}`, executionKey, traceId, ownerKey,
              threadId: nativeIdentity.threadId, turnId: nativeTurnId,
              requestIds: (incoming.headers.get("x-request-id") ?? incoming.headers.get("x-cpr-request-id"))
                ? [operationDigest((incoming.headers.get("x-request-id") ?? incoming.headers.get("x-cpr-request-id"))!)] : [],
              submission: "prepared", generation: "not_started", delivery: "attached", recovery: "none",
              seq: saved?.seq ?? 0, attempt: (saved?.attempt ?? 0) + 1, updatedAt: Date.now(),
              rounds: { ...(resumeCompaction ? saved!.rounds : {}),
                [chatGptTurnRoundKey(parsed)]: { events: [], reasoning: [], completed: false } },
            });
            operation.checkpoint(); // Intent must survive before starting any browser work.
            return { ...startRuntime(parsed, environment, traceId, turnCapabilities, { operation }), operation };
          },
          traceId,
          incoming.abortSignal,
          nativeTurnId,
          nativeIdentity.threadId,
          // Ordinary questions queue on their shared chat. Native tool steering
          // alone may supersede an unfinished instruction and retire its surface.
          mode.localTools ? chatGptInstructionLineage(parsed) : undefined,
        );
        // A reconnect may disconnect while awaiting the registry; it must not evict a live observer.
        if (incoming.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
        const roundKey = chatGptTurnRoundKey(parsed);
        const operation = session.runtime.operation;
        if (operation) {
          const requestId = incoming.headers.get("x-request-id") ?? incoming.headers.get("x-cpr-request-id");
          if (requestId) {
            const ref = operationDigest(requestId);
            if (!operation.record.requestIds.includes(ref)) operation.record.requestIds.push(ref);
            operation.record.requestIds = operation.record.requestIds.slice(-32);
          }
          operation.record.delivery = "attached";
          session.checkpoint();
        }
        const stopNotices = operation?.observeNotices(notice => {
          if (!incoming.abortSignal?.aborted) {
            try { emit({ type: "provider_notice", notice }); }
            catch { /* emit already detached this HTTP observer; notice publication cannot cancel browser execution. */ }
          }
        });
        let pendingEvents: AdapterEvent[] = [];
        let firstDeltaPublished = session.roundEvents(roundKey).some(event => event.type === "text_delta"
          || event.type === "thinking_delta" || event.type === "reasoning_raw_delta");
        let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
        let checkpointFailure: unknown;
        const flushEvents = (): void => {
          if (checkpointTimer) clearTimeout(checkpointTimer);
          checkpointTimer = undefined;
          if (!pendingEvents.length) return;
          session.checkpoint(); // No observer sees data beyond the durable checkpoint.
          const batch = pendingEvents;
          pendingEvents = [];
          for (const event of batch) emit(event);
        };
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          if (checkpointFailure) throw checkpointFailure;
          session.appendRoundEvents(roundKey, events);
          pendingEvents.push(...events);
          const firstDelta = !firstDeltaPublished && events.some(event => event.type === "text_delta"
            || event.type === "thinking_delta" || event.type === "reasoning_raw_delta");
          if (firstDelta || events.some(event => event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "reasoning_raw_delta")) {
            flushEvents();
            if (firstDelta) firstDeltaPublished = true;
          } else if (pendingEvents.length && !checkpointTimer) {
            checkpointTimer = setTimeout(() => {
              try { flushEvents(); }
              catch (error) {
                checkpointFailure = error;
                observerAbort.abort(error);
              }
            }, 50);
          }
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        let awaitingRuntime = false;
        const releaseObserver = session.runtime.manualControl ? undefined : session.observeRound(roundKey, () => {
          observerAbort.abort(new DOMException("ChatGPT observer replaced by an exact reconnect", "AbortError"));
        });
        try {
          await withAbort(session.runExclusive(async () => {
            // A disconnected queued observer must never drain data after it finally acquires the lock.
            if (incoming.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (settled) {
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                // Both feeds were drained above: journal them together before any observer write.
                emitRoundBatch(buffer => {
                  if (replay.length === 0 && !parsed._compactionRequest) {
                    emitReadOnlyContextWarning(parsed, turnCapabilities, buffer);
                  }
                  emitTraceEvents(trace, buffer);
                  if (!bufferStructuredOutput) emitTextDeltas(completedTextDeltas, buffer);
                });
              }
              // A failed browser may still have produced text while the client was offline.
              if (settled.type === "error") throw settled.error;
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                buffer,
              ));
              session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            let turnToken: string | undefined;
            if (session.runtime.mode === "tools") {
              turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                for (const message of results) {
                  await broker.completeTool(turnToken, message.toolCallId, brokerResult(message));
                  session.runtime.externalProgress.recordToolResult();
                  session.runtime.trace.recordProgress();
                  session.markResultDelivered(message.toolCallId);
                  if (operation) {
                    operation.record.observationRound ??= { roundKey, deliveredToolResults: {} };
                    operation.record.observationRound.deliveredToolResults[message.toolCallId] = operationDigest(JSON.stringify(brokerResult(message)));
                  }
                }
              }
              if (operation) {
                operation.record.observationRound ??= { roundKey, deliveredToolResults: {} };
                operation.record.observationRound.roundKey = roundKey;
                session.checkpoint(); // Native result receipt + canonical HTTP round survive before its response/ACK.
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = (deltas: string[]) => {
                if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(deltas, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    const revision = externalProgress.recordToolBatch(requests.length);
                    session.runtime.trace.recordProgress();
                    if (!session.runtime.manualControl) {
                      // The browser outcome is in the same race below and owns the semantic DOM and
                      // renderer deadlines. A second fixed timer here can retire an accepted turn
                      // while its same-tab observer is still recovering. Keep the causal barrier —
                      // tools are not emitted until the browser captures their text boundary — but
                      // let browser settlement or request cancellation end the wait.
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                  }
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const finishBrowserOutcome = async (completedOutcome: ChatGptBrowserOutcome): Promise<void> => {
                // Zero Risk completion and its owner-only empty-batch signal are resolved by the
                // same broker transition. Drain once more so the accepted final answer cannot be
                // overtaken by the terminal owner notification.
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                if (turnToken) await broker.revoke(turnToken, undefined, { source: "runtime.browser_outcome", reason: completedOutcome.type === "error" ? "failure" : "completed" });
                if (completedOutcome.type === "error") throw completedOutcome.error;
                if (session.runtime.text.value() !== completedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                structuredOutputValidator?.(completedOutcome.answer);
                if (bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                }
                if (session.runtime.richWidgets?.length) {
                  emitRoundBatch(buffer => {
                    for (const widget of session.runtime.richWidgets!) buffer({ type: "rich_widget", widget });
                  });
                }
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              for (;;) {
                awaitingRuntime = true;
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                awaitingRuntime = false;
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(session.runtime.text.drain());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                operation?.notice("tool_waiting");
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
          }), incoming.abortSignal);
        } catch (error) {
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl) {
              // Zero Risk is user-driven and has no DOM observer that can distinguish continued
              // work from a stopped native turn. A closed Responses stream is therefore terminal:
              // revoke the MCP capability and release the Launcher tab instead of leaving a task
              // that Codex already shows as stopped waiting forever.
              chatGptTurnSessions.retire(executionKey, session);
            }
            // Automatic browser turns keep their exact execution and journal for reconnect. Their
            // owned DOM observer can continue proving the same accepted ChatGPT submission.
            throw error;
          }
          // Browser failure can retire tools before their next wait starts. Once that exact
          // browser has failed, its cause takes precedence over the cleanup's token error.
          // Validation and result-delivery failures never enter this branch.
          const settled = awaitingRuntime ? session.settledOutcome() : undefined;
          if (settled?.type === "error") error = settled.error;
          const turnError = submittedTurnFailure(session, error);
          const handledError = turnError instanceof ChatGptWebAdapterError && turnError.retryable
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (!(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
            // A deterministic request failure remains replayable so a native reconnect cannot burn
            // another browser attempt. Every other failure retires the browser session: client
            // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
            // instead of replaying one rejected browser outcome for the registry's full TTL.
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken, undefined, { source: "runtime.failure", reason: "failure" })).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        } finally {
          stopNotices?.();
          if (checkpointTimer) clearTimeout(checkpointTimer);
          // Persist drained data even when the observer went away; never cancel the browser.
          if (pendingEvents.length) {
            session.checkpoint();
            if (!incoming.abortSignal?.aborted) flushEvents();
          }
          if (operation) {
            if (incoming.abortSignal?.aborted) operation.notice("observer_detached");
            operation.record.delivery = incoming.abortSignal?.aborted ? "detached" : "unknown";
            session.checkpoint();
          }
          releaseObserver?.();
        }
      };

      // Arm this before any awaited work, including environment lookup and owner retirement.
      const heartbeat = setInterval(
        () => {
          try { emit({ type: "heartbeat" }); }
          catch { /* emit detached the observer and wakes its pending awaits. */ }
        },
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        emit({ type: "heartbeat" });
        await runChatGptWebTurn();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
