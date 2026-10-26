import { retainsBrowserExecution } from "./submission-identity";
import { hasNativeExecution, nativePreparationCancelledError, retainedOperationError, type DurableOperation } from "./operation-journal";
import { ExplicitNativeCancellation } from "./native-execution";
import { createHash } from "node:crypto";
import type { ChatGptChartWidget } from "./rich-widget";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError, chatGptTurnSupersededError } from "./adapter-error";
import {
  chatGptTurnUserRevisionHistory,
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "./environment";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import type { ChatGptExternalTurnProgress } from "./turn-progress";
import { buildResponseJSON } from "../../bridge";

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // Keep the underlying retirement promise observed even when the caller arrived after abort;
    // another owner may still depend on its eventual settlement and rejection must not become an
    // unhandled process-level error.
    void promise.catch(() => {});
    return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();
  private readonly progressObservers = new Set<() => void>();

  observeProgress(observer: () => void): () => void {
    this.progressObservers.add(observer);
    return () => { this.progressObservers.delete(observer); };
  }

  recordProgress(): void {
    for (const observer of this.progressObservers) observer();
  }

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    this.recordProgress();
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  operation?: DurableOperation;
  browser: Promise<string>;
  /** Physical helper/Playwright settlement, including the launcher end/release acknowledgement. */
  physicalSettlement: Promise<void>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  richWidgets?: ChatGptChartWidget[];
  usageInput?: CodexParsedRequest;
  conversationKey?: string;
  releaseRetainedConversation?: () => Promise<void>;
  /** Idempotently retire the turn-bound MCP capability after browser and observer settlement. */
  retireCapability?: () => void | Promise<void>;
  submission?: { phase: "prepared" | "send_activated" | "accepted" };
  /** Present only when the visible ChatGPT tab is driven manually through the Codex Zero Risk MCP contract. */
  manualControl?: { surfaceNonce: string };
  cancel: (reason?: Error) => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & {
    mode: "tools";
    token: Promise<string>;
    externalProgress: ChatGptExternalTurnProgress;
  })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

function executionKey(parsed: CodexParsedRequest, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

function compactionInputRevision(parsed: CodexParsedRequest): unknown[] {
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex request body");
  }
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex input history");
  }
  return input;
}

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    revision: parsed._compactionRequest
      ? compactionInputRevision(parsed)
      : extractChatGptTurnUserRevision(parsed),
    ...(!parsed._compactionRequest ? { instructionId: chatGptTurnUserRevisionHistory(parsed).at(-1)?.itemId } : {}),
  });
}

export interface ChatGptInstructionLineage {
  current: string;
  predecessors: ReadonlySet<string>;
}

export function chatGptInstructionLineage(parsed: CodexParsedRequest): ChatGptInstructionLineage {
  const revisions = chatGptTurnUserRevisionHistory(parsed).map(revision => createHash("sha256")
    .update(JSON.stringify([revision.itemId ?? null, revision.content])).digest("hex"));
  const current = revisions.pop();
  if (!current) throw new Error("ChatGPT web requires a canonical user instruction");
  return { current, predecessors: new Set(revisions) };
}

/** Native retries append clear reasoning receipts, not a new response round. */
function responseRoundInput(input: unknown[]): unknown[] {
  let end = input.length;
  while (end > 0) {
    const item = input[end - 1];
    if (!item || typeof item !== "object") break;
    const receipt = item as { type?: unknown; content?: unknown; encrypted_content?: unknown };
    if (receipt.type !== "reasoning" || receipt.content != null || receipt.encrypted_content != null) break;
    end -= 1;
  }
  return input.slice(0, end);
}

/** JSON object order is not semantic; array positions and string contents remain exact. */
function canonicalRoundInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRoundInput);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalRoundInput(record[key])]));
}

/** Exact canonical Responses request identity inside one long-lived browser execution. */
export function chatGptTurnRoundKey(parsed: CodexParsedRequest): string {
  if (parsed._chatgptObserverRoundKey) return parsed._chatgptObserverRoundKey;
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for round replay");
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Array.isArray((body as { input?: unknown }).input)) {
    throw new Error("ChatGPT web requires the complete native Codex input for round replay");
  }
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    // Canonicalize only the observer-round journal identity. Physical execution and instruction
    // lineage have separate ownership contracts and must not change with this replay repair.
    input: canonicalRoundInput(parsed._compactionRequest
      ? (body as { input: unknown[] }).input
      : responseRoundInput((body as { input: unknown[] }).input)),
  });
}

/** A Native reconnect can append the exact partial item it already received.
 * Match its emitted ID and exact received prefix against this operation's journal;
 * never infer replay from repeated prose or ignore a new tool result/user input.
 */
export function chatGptPartialReceiptRound(
  parsed: CodexParsedRequest,
  traceId: string,
  rounds: Record<string, { events: AdapterEvent[] }>,
): string | undefined {
  if (parsed._compactionRequest) return;
  const body = parsed._rawBody as { input?: unknown[] } | undefined;
  if (!Array.isArray(body?.input)) return;
  // Keep trailing clear reasoning here: it too is a received item that the
  // completed response must replace in continuation state, even without text.
  const input = body.input;
  const receipts: Array<Record<string, unknown>> = [];
  for (let end = input.length - 1; end >= 0; end--) {
    const item = input[end] as Record<string, unknown> | undefined;
    const clearReasoning = item?.type === "reasoning" && item.content == null && item.encrypted_content == null;
    if (!item || typeof item.id !== "string"
      || !(clearReasoning || item.type === "message" && item.role === "assistant")) break;
    receipts.unshift(item);
    const candidate = { ...parsed, _chatgptObserverRoundKey: undefined,
      _rawBody: { ...body, input: input.slice(0, end) } };
    const key = chatGptTurnRoundKey(candidate);
    const round = rounds[key];
    if (!round) continue;
    const replayIdentity = createHash("sha256").update(JSON.stringify([traceId, key])).digest("hex").slice(0, 32);
    const output = buildResponseJSON(round.events, parsed.modelId, { replayIdentity,
      hideThinkingSummary: parsed.options.hideThinkingSummary }).output as Array<Record<string, unknown>>;
    let previous = -1;
    const exact = receipts.every(receipt => {
      const index = output.findIndex(expected => expected.id === receipt.id);
      if (index <= previous) return false;
      previous = index;
      const expected = output[index];
      if (receipt.type === "reasoning") {
        return expected?.type === "reasoning" && receipt.content == null && receipt.encrypted_content == null
          && (receipt.summary === undefined || JSON.stringify(canonicalRoundInput(receipt.summary))
            === JSON.stringify(canonicalRoundInput(expected.summary)));
      }
      if (!expected || expected.type !== "message" || expected.role !== "assistant" || expected.phase !== receipt.phase
        || !Array.isArray(expected.content) || !Array.isArray(receipt.content)) return false;
      const parts = receipt.content as Array<{ type?: unknown; text?: unknown }>;
      const expectedParts = expected.content as Array<{ type?: unknown; text?: unknown }>;
      if (parts.length !== 1 || expectedParts.length !== 1 || parts[0]?.type !== "output_text"
        || expectedParts[0]?.type !== "output_text" || typeof parts[0].text !== "string"
        || typeof expectedParts[0].text !== "string") return false;
      return expectedParts[0].text.startsWith(parts[0].text);
    });
    if (exact) return key;
  }
}

/** Stable identity for limiting automatic retries of one native Codex turn. */
export function chatGptTurnRetryKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-turn retry budgeting");
  return createHash("sha256").update(JSON.stringify({
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
  })).digest("hex");
}

/** One native Codex thread may own at most one live ChatGPT browser surface. */
export function chatGptThreadOwnershipKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const owner = identity.threadId
    ? { kind: "thread", id: identity.threadId }
    : identity.promptCacheKey
      ? { kind: "prompt_cache", id: identity.promptCacheKey }
      : identity.turnId
        ? { kind: "turn", id: identity.turnId }
        : undefined;
  if (!owner) throw new Error("ChatGPT web requires native Codex turn identity metadata for browser ownership");
  return createHash("sha256").update(JSON.stringify(owner)).digest("hex");
}

/** Locate the browser response that a native mid-turn compaction replaces. */
export function chatGptCompactionSourceExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const source = extractChatGptCompactionSourceRevision(parsed);
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: source.turnId ?? identity.turnId,
    purpose: "response",
    revision: source.content,
    instructionId: source.itemId,
  });
}

export class ChatGptTurnSession {
  supersededError?: Error;
  readonly createdAt = Date.now();
  private lastTouchedAt = this.createdAt;
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  readonly physicalSettlement: Promise<void>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private settledPhysical = false;
  private attachedConversationKey: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly roundObservers = new Map<string, () => void>();
  private capabilityRetirementScheduled = false;
  private readonly rounds = new Map<string, {
    events: AdapterEvent[];
    reasoning: string[];
    completed: boolean;
    failure?: Error;
  }>();

  constructor(
    readonly runtime: ChatGptTurnRuntime,
    readonly traceId?: string,
    readonly ownerKey?: string,
    readonly nativeTurnId?: string,
    readonly nativeThreadId?: string,
    readonly instruction?: string,
  ) {
    this.attachedConversationKey = runtime.conversationKey;
    const saved = runtime.operation?.record;
    if (saved) {
      for (const [key, round] of Object.entries(saved.rounds)) this.rounds.set(key, {
        ...round, events: [...round.events], reasoning: [...round.reasoning],
        failure: round.failure ? new Error(round.failure) : undefined,
      });
      this.finalPrelude = saved.final?.events ?? [];
      this.finalReasoning = saved.final?.reasoning ?? [];
    }
    // Helper/observer termination is not a Native release. Keep the durable release gate
    // alive even after the helper dies so an exact metadata-only reconciliation can open it.
    const nativeRelease = runtime.operation?.waitForNativeRelease();
    const physical = runtime.physicalSettlement.then(
      () => runtime.operation && hasNativeExecution(runtime.operation.record)
        ? runtime.operation.waitForNativeRelease() : undefined,
      error => {
        if (runtime.operation && hasNativeExecution(runtime.operation.record)) return runtime.operation.waitForNativeRelease();
        throw error;
      },
    );
    this.physicalSettlement = (nativeRelease ? Promise.race([physical, nativeRelease]) : physical).then(
      () => {
        if (runtime.operation && hasNativeExecution(runtime.operation.record) && !runtime.operation.hasNativeRelease()) {
          throw retainedOperationError();
        }
        this.settledPhysical = true;
        if (runtime.operation) { runtime.operation.record.physicalSettled = true; this.checkpoint(); }
      },
      error => {
        this.settledPhysical = !runtime.operation?.record.nativeScope && runtime.mode !== "read-only" && !retainsBrowserExecution(error);
        throw error;
      },
    );
    void this.physicalSettlement.catch(() => {});
    const resultReady = runtime.operation?.waitForNativeResultReady().then(ready => ready.answer);
    this.browserOutcome = (resultReady ? Promise.race([runtime.browser, resultReady]) : runtime.browser)
      .catch(error => {
        // A helper may die after result-ready ACK but before /end or its result frame.
        // Return only that already durable, exactly scoped answer; keep the release gate closed.
        const operation = runtime.operation;
        if (operation?.record.nativeFinal && operation.record.nativeScope) {
          return operation.nativeFinalFor(operation.record.nativeScope).answer;
        }
        throw error;
      })
      .then(answer => {
        const operation = runtime.operation;
        if (operation && hasNativeExecution(operation.record) && operation.record.nativeFinal) {
          const ready = operation.nativeFinalFor(operation.record.nativeScope!);
          if (ready.answer !== answer) throw retainedOperationError();
          // A completion racing explicit cancellation may persist the full original answer
          // before a final text frame arrives. Reproduce only its exact already-emitted prefix.
          const prefix = runtime.text.value();
          if (!ready.answer.startsWith(prefix)) throw retainedOperationError();
          runtime.text.push(ready.answer.slice(prefix.length));
        }
        return answer;
      })
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof ExplicitNativeCancellation && runtime.submission?.phase === "prepared"
        ? nativePreparationCancelledError() : error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.settledBrowserOutcome = outcome;
      const operation = runtime.operation;
      if (operation) {
        const record = operation.record;
        record.conversationKey = runtime.conversationKey;
        record.generation = outcome.type === "final" ? "final" : "unknown";
        record.delivery = "unknown"; // HTTP writes are not a client ACK.
        if (outcome.type === "final") {
          // A read-only DOM observer can finish logically without granting a new durable
          // result-ready/completion authority. Only the original writer supplies nativeFinal.
          if (!hasNativeExecution(record) || record.nativeFinal) record.final = { answer: outcome.answer,
            events: this.finalPrelude, reasoning: this.finalReasoning };
          else delete record.final;
        }
        else {
          record.recovery = "retained";
          const typed = outcome.error instanceof ChatGptWebAdapterError ? outcome.error : undefined;
          record.error = { code: typed?.code, retryable: typed?.retryable ?? runtime.submission?.phase === "prepared",
            ...(typed && "diagnostics" in typed ? { diagnostics: typed.diagnostics as Record<string, unknown> } : {}) };
        }
        this.checkpoint();
      }
      const error = outcome.type === "error" && outcome.error instanceof ChatGptWebAdapterError
        ? outcome.error : undefined;
      console.info(`[chatgpt-web] browser_settled ${JSON.stringify({
        traceId: this.traceId,
        ...(runtime.operation ? { receipt: runtime.operation.receipt() } : {}),
        outcome: outcome.type,
        compaction: runtime.usageInput?._compactionRequest === true,
        ...(!runtime.usageInput?._compactionRequest ? { submission: runtime.submission?.phase ?? "unknown" } : {}),
        ...(error ? { code: error.code, retryable: error.retryable } : {}),
      })}`);
      return outcome;
    });
  }

  /** Bounded by the existing helper lifecycle; an ended un-released owner fails closed.
   * physicalSettlement itself remains a release-only promise so later metadata can resolve it. */
  async waitForPhysicalSettlement(signal?: AbortSignal): Promise<void> {
    const lifecycle = this.runtime.physicalSettlement.then(
      () => {
        if (this.runtime.operation && hasNativeExecution(this.runtime.operation.record)
          && !this.runtime.operation.hasNativeRelease()) throw retainedOperationError();
        return this.physicalSettlement;
      },
      error => {
        if (this.runtime.operation && hasNativeExecution(this.runtime.operation.record)) {
          if (this.runtime.operation.hasNativeRelease()) return;
          throw retainedOperationError();
        }
        throw error;
      },
    );
    await awaitWithAbort(Promise.race([this.physicalSettlement, lifecycle]), signal);
  }

  checkpoint(): void {
    const operation = this.runtime.operation;
    if (!operation) return;
    operation.record.rounds = Object.fromEntries([...this.rounds].map(([key, round]) => [key, {
      events: round.events, reasoning: round.reasoning, completed: round.completed,
      ...(round.failure ? { failure: round.failure.message } : {}),
    }]));
    if (operation.record.final) {
      operation.record.final.events = this.finalPrelude;
      operation.record.final.reasoning = this.finalReasoning;
    }
    operation.checkpoint();
  }

  /** An exact reconnect replaces its stale HTTP observer, never the browser execution. */
  observeRound(key: string, detach: () => void): () => void {
    this.roundObservers.get(key)?.();
    this.roundObservers.set(key, detach);
    return () => {
      if (this.roundObservers.get(key) === detach) this.roundObservers.delete(key);
    };
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    this.scheduleCapabilityRetirement();
    return run;
  }

  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  conversationKey(): string | undefined {
    return this.attachedConversationKey;
  }

  detachConversation(conversationKey: string): boolean {
    if (this.attachedConversationKey !== conversationKey) return false;
    this.attachedConversationKey = undefined;
    return true;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  /** The client-visible browser result can settle before launcher/helper cleanup does. */
  isPhysicallySettled(): boolean {
    return this.settledPhysical;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  roundEvents(key: string): AdapterEvent[] {
    return [...this.round(key).events];
  }

  roundReasoning(key: string): string[] {
    return [...this.round(key).reasoning];
  }

  appendRoundEvent(key: string, event: AdapterEvent): void {
    this.appendRoundEvents(key, [event]);
  }

  appendRoundEvents(key: string, events: readonly AdapterEvent[]): void {
    if (events.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append to a completed ChatGPT native round");
    round.events.push(...events);
  }

  appendRoundReasoning(key: string, values: readonly string[]): void {
    if (values.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append reasoning to a completed ChatGPT native round");
    round.reasoning.push(...values);
  }

  completeRound(key: string): void {
    this.round(key).completed = true;
    this.checkpoint();
  }

  failRound(key: string, error: Error): void {
    const round = this.round(key);
    round.failure = error;
    round.completed = true;
    this.checkpoint();
  }

  roundCompleted(key: string): boolean {
    return this.rounds.get(key)?.completed === true;
  }

  roundFailure(key: string): Error | undefined {
    return this.rounds.get(key)?.failure;
  }

  roundHasTerminalEvent(key: string): boolean {
    return this.rounds.get(key)?.events.some(event => event.type === "done" || event.type === "error") === true;
  }

  cancel(reason?: Error): void {
    this.runtime.cancel(reason);
  }

  private scheduleCapabilityRetirement(): void {
    if (this.capabilityRetirementScheduled || !this.runtime.retireCapability) return;
    this.capabilityRetirementScheduled = true;
    // Register only after the first observer entered `runExclusive`. This ensures an immediately
    // completed mocked/real browser cannot revoke its token ahead of the browser-outcome branch.
    // At physical settlement, read the current tail so every tool-result/reconnect observer that
    // was already admitted finishes before the capability is retired.
    void this.physicalSettlement
      .then(() => this.tail)
      .then(() => this.runtime.retireCapability!())
      .catch(error => {
        console.error(
          `[chatgpt-web] failed to retire settled turn capability: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private round(key: string) {
    let round = this.rounds.get(key);
    if (round) return round;
    round = { events: [], reasoning: [], completed: false };
    this.rounds.set(key, round);
    while (this.rounds.size > 512) {
      const oldestCompleted = [...this.rounds].find(([, candidate]) => candidate.completed);
      if (!oldestCompleted) {
        throw new Error("ChatGPT native round journal is full (512 unfinished rounds)");
      }
      this.rounds.delete(oldestCompleted[0]);
    }
    return round;
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly conversationHeads = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly ownerRetirements = new Map<string, Promise<void>>();
  private readonly conversationRetirements = new Map<string, Promise<void>>();
  private readonly retiringSessions = new Map<string, ChatGptTurnSession>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
  ) {}

  getOrCreate(
    key: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    ownerKey?: string,
    nativeTurnId?: string,
    nativeThreadId?: string,
    instruction?: string,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.supersededError) throw existing.supersededError;
      existing.touch();
      return existing;
    }
    const active = [...this.entries.values()].filter(session => session.isActive()).length;
    if (active >= MAX_CHATGPT_BROWSER_TABS) {
      throw new ChatGptWebAdapterError(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
        { status: 429, errorType: "rate_limit_error", code: "concurrency_limit_exceeded", retryable: true },
      );
    }
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start(), traceId, ownerKey, nativeTurnId, nativeThreadId, instruction);
    this.entries.set(key, session);
    const conversationKey = session.conversationKey();
    if (conversationKey) this.conversationHeads.set(conversationKey, session);
    return session;
  }

  async getOrCreateAfterOwnerRetirement(
    key: string,
    ownerKey: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    signal?: AbortSignal,
    nativeTurnId?: string,
    nativeThreadId?: string,
    instruction?: ChatGptInstructionLineage,
  ): Promise<ChatGptTurnSession> {
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.supersededError) throw existing.supersededError;
        existing.touch();
        return existing;
      }
      const pending = this.retirements.get(key) ?? this.ownerRetirements.get(ownerKey);
      if (pending) {
        // Do not wait forever on the release-only promise after the helper has already
        // ended. Its retained session remains available for exact release reconciliation.
        for (const [retiredKey, session] of this.retiringSessions) {
          if (retiredKey === key || session.ownerKey === ownerKey) await session.waitForPhysicalSettlement(signal);
        }
        await awaitWithAbort(pending, signal);
        continue;
      }
      const activeOwner = [...this.entries, ...this.retiringSessions].find(([ownedKey, session]) => (
        ownedKey !== key && session.ownerKey === ownerKey && !session.isPhysicallySettled()
      ));
      if (activeOwner) {
        const [ownedKey, ownedSession] = activeOwner;
        if (ownedSession.isActive() && instruction && ownedSession.instruction
          && instruction.current !== ownedSession.instruction) {
          if (!instruction.predecessors.has(ownedSession.instruction)) throw chatGptTurnSupersededError();
          // Native steering can return the old tool result and a new instruction in one request.
          // Waiting for the old browser here deadlocks before that result can be consumed. Retire
          // its capability and rebuild from the complete canonical history, including that result.
          // Keep the old entry terminal so a delayed replay cannot restart superseded work.
          const reason = chatGptTurnSupersededError();
          ownedSession.supersededError = reason;
          this.forgetConversationHead(ownedSession);
          await awaitWithAbort(this.beginRetirement(ownedKey, ownedSession, reason), signal);
          continue;
        }
        // A completed response may still be releasing its browser surface. Sequential work
        // waits for that cleanup; preemption requires a proven newer canonical instruction.
        await ownedSession.waitForPhysicalSettlement(signal);
        continue;
      }
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      return this.getOrCreate(key, start, traceId, ownerKey, nativeTurnId, nativeThreadId, instruction?.current);
    }
  }

  find(key: string): ChatGptTurnSession | undefined {
    const session = this.entries.get(key);
    session?.touch();
    return session;
  }

  /** Metadata reconciliation addresses the original owner even after explicit retirement. */
  findPhysicalOwner(key: string): ChatGptTurnSession | undefined {
    return this.entries.get(key) ?? this.retiringSessions.get(key);
  }

  findConversationHead(conversationKey: string): ChatGptTurnSession | undefined {
    const session = this.conversationHeads.get(conversationKey);
    session?.touch();
    return session;
  }

  /** Wait for a retained conversation epoch that has been detached but not physically released. */
  async waitForConversationRetirement(conversationKey: string, signal?: AbortSignal): Promise<void> {
    for (const session of this.retiringSessions.values()) {
      if (session.runtime.conversationKey === conversationKey) await session.waitForPhysicalSettlement(signal);
    }
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) await awaitWithAbort(pending, signal);
  }

  async retireConversationAndWait(conversationKey: string): Promise<number> {
    return this.closeConversationAndWait(conversationKey);
  }

  /**
   * Close the physical retained-chat epoch without discarding a terminal response that won the
   * compaction race before any compaction instruction reached that response. The detached logical
   * session remains addressable by its exact Responses execution key, so the post-compaction
   * native round can consume the already-committed answer instead of opening another browser turn.
   */
  async retireConversationPreservingFinalResponse(
    conversationKey: string,
    preserved: ChatGptTurnSession,
    preservedExecutionKey: string,
  ): Promise<number> {
    if (!preservedExecutionKey) throw new Error("Preserved ChatGPT response execution key is required");
    const outcome = preserved.settledOutcome();
    if (!outcome || outcome.type !== "final") {
      throw new Error("Only a settled final ChatGPT response can survive retained-conversation retirement");
    }
    return this.closeConversationAndWait(conversationKey, {
      session: preserved,
      executionKey: preservedExecutionKey,
    });
  }

  private async closeConversationAndWait(
    conversationKey: string,
    preserved?: { session: ChatGptTurnSession; executionKey: string },
  ): Promise<number> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) {
      await this.waitForConversationRetirement(conversationKey);
      return 0;
    }
    const matches = [...this.entries].filter(([, session]) => (
      session.conversationKey() === conversationKey
    ));
    if (matches.length === 0) return 0;
    if (preserved && !matches.some(([, session]) => session === preserved.session)) {
      throw new Error("The final ChatGPT response does not own the retained conversation being retired");
    }
    const target = preserved ? this.entries.get(preserved.executionKey) : undefined;
    if (target && target !== preserved?.session) {
      throw new Error("The compacted ChatGPT response execution key is already owned by another session");
    }
    this.conversationHeads.delete(conversationKey);
    for (const [key, session] of matches) {
      if (session.runtime.operation && hasNativeExecution(session.runtime.operation.record) && !session.isPhysicallySettled()) {
        this.retiringSessions.set(key, session);
        void session.physicalSettlement.then(() => {
          if (this.retiringSessions.get(key) === session) this.retiringSessions.delete(key);
        }, () => {});
      }
      if (this.entries.get(key) === session
        && (session !== preserved?.session || key !== preserved.executionKey)) {
        this.entries.delete(key);
      }
      if (session.isActive()) session.cancel();
      if (!session.detachConversation(conversationKey)) {
        throw new Error("ChatGPT retained-conversation ownership changed during retirement");
      }
    }
    if (preserved) this.entries.set(preserved.executionKey, preserved.session);
    const release = matches.findLast(([, session]) => (
      session.runtime.releaseRetainedConversation !== undefined
    ))?.[1].runtime.releaseRetainedConversation;
    const retirement = Promise.all(matches.map(([, session]) => session.physicalSettlement))
      .then(async () => { await release?.(); });
    this.conversationRetirements.set(conversationKey, retirement);
    void retirement.then(() => {
      if (this.conversationRetirements.get(conversationKey) === retirement) this.conversationRetirements.delete(conversationKey);
    }, () => { /* Keep unresolved physical/context release fenced. */ });
    await Promise.all(matches.map(([, session]) => session.waitForPhysicalSettlement()));
    await retirement;
    return matches.length;
  }

  async waitForRetirement(key: string): Promise<void> {
    await this.retiringSessions.get(key)?.waitForPhysicalSettlement();
    await this.retirements.get(key);
  }

  async retireAndWait(key: string, signal?: AbortSignal): Promise<boolean> {
    const pending = this.retirements.get(key);
    if (pending) {
      await this.retiringSessions.get(key)?.waitForPhysicalSettlement(signal);
      await awaitWithAbort(pending, signal);
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    this.forgetConversationHead(session);
    await awaitWithAbort(this.beginRetirement(key, session), signal);
    return true;
  }

  retire(key: string, session: ChatGptTurnSession): boolean {
    if (this.entries.get(key) !== session) return false;
    this.entries.delete(key);
    this.forgetConversationHead(session);
    this.beginRetirement(key, session);
    return true;
  }

  /** Cancel only active responses whose exact native turn ids Codex marked as interrupted. */
  retireAbortedOwnerTurns(
    ownerKey: string,
    abortedTurnIds: ReadonlySet<string>,
    keepKey: string,
  ): number {
    const matches = [...this.entries].filter(([key, session]) => (
      key !== keepKey
      && session.ownerKey === ownerKey
      && session.nativeTurnId !== undefined
      && abortedTurnIds.has(session.nativeTurnId)
      && session.isActive()
    ));
    for (const [key, session] of matches) {
      this.entries.delete(key);
      this.forgetConversationHead(session);
      this.beginRetirement(key, session);
    }
    return matches.length;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const [key, session] of this.entries) this.beginRetirement(key, session);
    this.entries.clear();
    this.conversationHeads.clear();
    return cancelled;
  }

  async cancelTrace(traceId: string, reason = chatGptBrowserTabClosedError()): Promise<number> {
    const cancellation = this.beginCancelTrace(traceId, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  /** Revoke execution immediately; keep physical cleanup tracked independently of the UI receipt. */
  beginCancelTrace(traceId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
    const sessions = [...this.entries.values()]
      .filter(session => session.traceId === traceId && session.isActive());
    for (const session of sessions) session.cancel(reason);
    return { cancelled: sessions.length, settlement: Promise.all(sessions.map(session => session.waitForPhysicalSettlement())).then(() => undefined) };
  }

  /**
   * Begin retiring only the browser execution owned by the exact native Codex turn.
   *
   * Codex runs Interrupt hooks synchronously with a short deadline. Ownership is removed and the
   * abort is delivered before this method returns; physical helper cleanup remains represented by
   * `settlement`, so replacement turns still serialize behind the real teardown without blocking
   * the hook acknowledgement itself.
   */
  cancelNativeTurn(
    threadId: string,
    turnId: string,
    reason: Error,
  ): { cancelled: number; settlement: Promise<void> } {
    const matches = [...this.entries].filter(([, session]) => (
      session.nativeThreadId === threadId
      && session.nativeTurnId === turnId
    ));
    for (const [key, session] of matches) {
      if (this.entries.get(key) !== session) continue;
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
    const settlement = Promise.all(
      matches.map(([key, session]) => this.beginRetirement(key, session, reason)),
    ).then(() => undefined);
    return { cancelled: matches.length, settlement };
  }

  cancelledError(traceId: string): Error | undefined {
    for (const session of this.entries.values()) {
      if (session.traceId !== traceId) continue;
      if (session.supersededError) return session.supersededError;
      const outcome = session.settledOutcome();
      if (outcome?.type !== "error") continue;
      if ("code" in outcome.error && outcome.error.code === "client_cancelled") return outcome.error;
    }
    return undefined;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      if (session.isActive() || !session.isPhysicallySettled() || session.lastUsedAt() >= cutoff) continue;
      session.cancel();
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
  }

  private forgetConversationHead(session: ChatGptTurnSession): void {
    const conversationKey = session.conversationKey();
    if (conversationKey && this.conversationHeads.get(conversationKey) === session) {
      this.conversationHeads.delete(conversationKey);
    }
  }

  private beginRetirement(key: string, session: ChatGptTurnSession, reason?: Error): Promise<void> {
    const existing = this.retirements.get(key);
    if (existing) return this.retiringSessions.get(key)?.waitForPhysicalSettlement() ?? existing;
    const conversationKey = session.conversationKey();
    session.cancel(reason);
    const retirement = session.physicalSettlement;
    this.retirements.set(key, retirement);
    this.retiringSessions.set(key, session);
    void retirement.then(() => {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
      if (this.retiringSessions.get(key) === session) this.retiringSessions.delete(key);
    }, () => { /* Retained ownership keeps its rejection fence. */ });
    if (session.ownerKey) {
      const previous = this.ownerRetirements.get(session.ownerKey);
      const ownerRetirement = previous
        ? Promise.all([previous, retirement]).then(() => undefined)
        : retirement;
      this.ownerRetirements.set(session.ownerKey, ownerRetirement);
      void ownerRetirement.then(() => {
        if (this.ownerRetirements.get(session.ownerKey!) === ownerRetirement) {
          this.ownerRetirements.delete(session.ownerKey!);
        }
      }, () => { /* Retained owner remains blocked. */ });
    }
    if (conversationKey) {
      const previous = this.conversationRetirements.get(conversationKey);
      const conversationRetirement = previous
        ? Promise.all([previous, retirement]).then(() => undefined)
        : retirement;
      this.conversationRetirements.set(conversationKey, conversationRetirement);
      const forgetConversationRetirement = () => {
        if (this.conversationRetirements.get(conversationKey) === conversationRetirement) {
          this.conversationRetirements.delete(conversationKey);
        }
      };
      void conversationRetirement.then(
        forgetConversationRetirement,
        forgetConversationRetirement,
      );
    }
    const wait = session.waitForPhysicalSettlement();
    void wait.catch(() => {});
    return wait;
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
