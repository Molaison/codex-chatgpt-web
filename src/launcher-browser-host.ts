import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { expandUserPath } from "./config";
import { processRunning } from "./process";

export const LAUNCHER_BROWSER_HOST_KIND = "codex-web-gpt-launcher";
export const LAUNCHER_BROWSER_IDLE_URL = "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Cmeta%20charset%3D%22utf-8%22%3E%3Ctitle%3ECodex%20Web%20GPT%3C%2Ftitle%3E%3C%2Fhead%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E#codex-web-gpt-browser-host";
export type LauncherBrowserHostProfile = "production" | "development";

export class LauncherBrowserTurnCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherBrowserTurnCancelledError";
  }
}

export class LauncherRetainedConversationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherRetainedConversationUnavailableError";
  }
}

export class LauncherBrowserTurnOwnerLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherBrowserTurnOwnerLostError";
  }
}

export class LauncherManualTurnTimedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherManualTurnTimedOutError";
  }
}

export class LauncherManualTurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherManualTurnFailedError";
  }
}

export interface LauncherBrowserHostDescriptor {
  version: 3;
  kind: typeof LAUNCHER_BROWSER_HOST_KIND;
  profile: LauncherBrowserHostProfile;
  pid: number;
  endpoint: string;
  control: {
    endpoint: string;
    token: string;
  };
  helper: {
    executable: string;
    script: string;
  };
  partition: string;
  idleUrl: string;
  surfaceId: string;
  surfaceTargets: Record<string, string>;
  createdAt: string;
  observationInstanceId?: string;
  hostVersion?: string;
  hostClosureDigest?: string;
}

export interface LauncherBrowserConnection {
  descriptor: LauncherBrowserHostDescriptor;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

function assertLoopbackEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} is not a valid URL`); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error(`${label} must use http://127.0.0.1`);
  }
  if (!parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must contain only a loopback host and explicit port`);
  }
  return parsed.origin;
}

function assertDescriptorShape(value: unknown): LauncherBrowserHostDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser descriptor is not an object");
  }
  const descriptor = value as Partial<LauncherBrowserHostDescriptor>;
  if (descriptor.version !== 3 || descriptor.kind !== LAUNCHER_BROWSER_HOST_KIND) {
    throw new Error("Launcher browser descriptor has an unsupported identity or version; restart the updated launcher");
  }
  if (descriptor.profile !== "production" && descriptor.profile !== "development") {
    throw new Error("Launcher browser descriptor has an invalid profile");
  }
  if (!Number.isInteger(descriptor.pid) || descriptor.pid! < 1) {
    throw new Error("Launcher browser descriptor has an invalid pid");
  }
  const endpoint = assertLoopbackEndpoint(descriptor.endpoint, "Launcher CDP endpoint");
  if (!descriptor.control || typeof descriptor.control !== "object") {
    throw new Error("Launcher browser descriptor is missing its control channel");
  }
  const controlEndpoint = assertLoopbackEndpoint(descriptor.control.endpoint, "Launcher control endpoint");
  if (typeof descriptor.control.token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(descriptor.control.token)) {
    throw new Error("Launcher browser descriptor has an invalid control token");
  }
  if (!descriptor.helper || typeof descriptor.helper !== "object") {
    throw new Error("Launcher browser descriptor is missing its Node helper command");
  }
  const helperExecutable = typeof descriptor.helper.executable === "string" ? resolve(descriptor.helper.executable) : "";
  const helperScript = typeof descriptor.helper.script === "string" ? resolve(descriptor.helper.script) : "";
  if (!helperExecutable || !existsSync(helperExecutable)) {
    throw new Error("Launcher browser descriptor helper executable does not exist");
  }
  if (!helperScript || !existsSync(helperScript)) {
    throw new Error("Launcher browser descriptor helper script does not exist");
  }
  const expectedPartition = descriptor.profile === "development"
    ? "persist:codex-web-gpt-dev-chatgpt"
    : "persist:codex-web-gpt-chatgpt";
  if (descriptor.partition !== expectedPartition) {
    throw new Error("Launcher browser descriptor identifies an unexpected browser partition");
  }
  if (descriptor.idleUrl !== LAUNCHER_BROWSER_IDLE_URL) {
    throw new Error("Launcher browser descriptor identifies an unexpected idle surface");
  }
  if (typeof descriptor.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(descriptor.surfaceId)) {
    throw new Error("Launcher browser descriptor has an invalid owned surface id");
  }
  const targets = descriptor.surfaceTargets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)
    || Object.entries(targets).some(([surface, target]) => !/^[A-Za-z0-9_-]{32}$/.test(surface)
      || typeof target !== "string" || !target.trim())
    || new Set(Object.values(targets)).size !== Object.keys(targets).length) {
    throw new Error("Launcher browser descriptor has invalid or duplicated surface targets");
  }
  if (typeof descriptor.createdAt !== "string" || Number.isNaN(Date.parse(descriptor.createdAt))) {
    throw new Error("Launcher browser descriptor has an invalid creation time");
  }
  return {
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: descriptor.profile,
    pid: descriptor.pid!,
    endpoint,
    control: { endpoint: controlEndpoint, token: descriptor.control.token },
    helper: { executable: helperExecutable, script: helperScript },
    partition: descriptor.partition,
    idleUrl: descriptor.idleUrl,
    surfaceId: descriptor.surfaceId,
    surfaceTargets: targets,
    createdAt: descriptor.createdAt,
    ...(typeof descriptor.hostVersion === "string" ? { hostVersion: descriptor.hostVersion } : {}),
    ...(typeof descriptor.hostClosureDigest === "string" && /^[a-f0-9]{64}$/.test(descriptor.hostClosureDigest) ? { hostClosureDigest: descriptor.hostClosureDigest } : {}),
    ...(typeof descriptor.observationInstanceId === "string" && /^[A-Za-z0-9_-]{32}$/.test(descriptor.observationInstanceId)
      ? { observationInstanceId: descriptor.observationInstanceId } : {}),
  };
}

export function readLauncherBrowserHostDescriptor(configuredPath: string): LauncherBrowserHostDescriptor {
  const path = resolve(expandUserPath(configuredPath));
  if (!existsSync(path)) throw new Error(`Launcher browser host is unavailable: descriptor is missing at ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Launcher browser descriptor is not a regular file: ${path}`);
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) throw new Error(`Launcher browser descriptor has unsafe permissions: ${path}`);
    const getuid = process.getuid;
    if (typeof getuid === "function" && stat.uid !== getuid()) {
      throw new Error(`Launcher browser descriptor is not owned by the current user: ${path}`);
    }
  }
  let decoded: unknown;
  try { decoded = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    throw new Error(`Launcher browser descriptor is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const descriptor = assertDescriptorShape(decoded);
  if (!processRunning(descriptor.pid)) {
    throw new Error(`Launcher browser host process is not running (pid ${descriptor.pid})`);
  }
  return descriptor;
}

async function assertCdpReady(descriptor: LauncherBrowserHostDescriptor, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.endpoint}/json/version`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.webSocketDebuggerUrl !== "string" || !body.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")) {
      throw new Error("CDP metadata did not expose a loopback WebSocket endpoint");
    }
  } catch (error) {
    throw new Error(`Launcher browser CDP endpoint is not ready: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectLauncherBrowserHostLiveness(
  descriptorPath: string,
  options: {
    expectedProfile?: LauncherBrowserHostProfile;
    timeoutMs?: number;
  } = {},
): Promise<LauncherBrowserHostDescriptor> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(
      `Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`,
    );
  }
  await assertCdpReady(descriptor, options.timeoutMs ?? 5_000);
  return descriptor;
}

export async function selectLauncherPage(
  browser: Browser,
  descriptor: LauncherBrowserHostDescriptor,
  timeoutMs: number,
  surfaceId = descriptor.surfaceId,
  abortSignal?: AbortSignal,
): Promise<{ context: BrowserContext; page: Page }> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const targetId = descriptor.surfaceTargets[surfaceId];
  if (!targetId) throw new Error("Launcher browser surface is no longer registered with its native target");
  const deadline = Date.now() + timeoutMs;
  do {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const candidates = browser.contexts().flatMap(context => context.pages().map(page => ({ context, page })));
    // Target metadata belongs to the browser process. Evaluating every page here makes an
    // unrelated busy/paused renderer block acquisition of an already-responsive owned page.
    const inspected = await Promise.all(candidates.map(async candidate => {
      const session = await candidate.context.newCDPSession(candidate.page).catch(() => undefined);
      if (!session) return { ...candidate, targetId: undefined };
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        return { ...candidate, targetId: targetInfo.targetId };
      } catch {
        return { ...candidate, targetId: undefined };
      } finally {
        await session.detach().catch(() => {});
      }
    }));
    const owned = inspected.filter(candidate => candidate.targetId === targetId);
    if (owned.length === 1) {
      return { context: owned[0].context, page: owned[0].page };
    }
    if (owned.length > 1) {
      throw new Error(`Launcher browser host exposed ${owned.length} surfaces with the same ownership id`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Launcher browser host did not expose its owned browser surface");
}

export async function connectLauncherBrowserHost(
  descriptorPath: string,
  timeoutMs = 20_000,
  surfaceId?: string,
  abortSignal?: AbortSignal,
  readOnly = false,
): Promise<LauncherBrowserConnection> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  await assertCdpReady(descriptor, Math.min(timeoutMs, 5_000));
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(descriptor.endpoint, { timeout: timeoutMs, noDefaults: true });
  } catch (error) {
    throw new Error(`Could not connect Playwright to the launcher browser: ${error instanceof Error ? error.message : String(error)}`);
  }
  const closeOnAbort = () => { void browser.close().catch(() => {}); };
  abortSignal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const { context, page } = await selectLauncherPage(
      browser,
      descriptor,
      timeoutMs,
      surfaceId,
      abortSignal,
    );
    // Preserve the host's theme and other pages. Only our owned page needs
    // focus emulation for input while its Electron view is in the background.
    if (!readOnly) {
      const inputSession = await context.newCDPSession(page);
      await inputSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    }
    // The browser connection owns this session; disconnect releases the override.
    return { descriptor, browser, context, page };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", closeOnAbort);
  }
}

export async function inspectLauncherBrowserHost(
  descriptorPath: string,
  options: {
    detectCapabilities?: boolean;
    expectedProfile?: LauncherBrowserHostProfile;
    timeoutMs?: number;
  } = {},
): Promise<{ solAvailable?: boolean; extraHighAvailable?: boolean; proAvailable?: boolean; url: string }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(
      `Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`,
    );
  }
  const timeoutMs = options.timeoutMs ?? (options.detectCapabilities
    ? LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS
    : LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/session/inspect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ detectCapabilities: options.detectCapabilities === true }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    if (body.authenticated !== true || body.temporary !== true || typeof body.url !== "string") {
      throw new Error("Launcher returned invalid ChatGPT session evidence");
    }
    if (options.detectCapabilities
      && (typeof body.solAvailable !== "boolean" || typeof body.extraHighAvailable !== "boolean" || typeof body.proAvailable !== "boolean")) {
      throw new Error("Launcher did not return complete ChatGPT account capability evidence");
    }
    if (options.detectCapabilities && (body.proAvailable === true || body.extraHighAvailable === true) && body.solAvailable !== true) {
      throw new Error("Launcher returned contradictory ChatGPT account capability evidence");
    }
    return {
      url: body.url,
      ...(options.detectCapabilities ? {
        solAvailable: body.solAvailable as boolean,
        extraHighAvailable: body.extraHighAvailable as boolean,
        proAvailable: body.proAvailable as boolean,
      } : {}),
    };
  } catch (error) {
    const detail = timedOut
      ? `session inspection timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
    throw new Error(`Launcher ChatGPT session could not be verified: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export const LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS = 30_000;
export const LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS = 120_000;

export class LauncherBrowserWriterConflictError extends Error {}

export type NativeWatchField = { presence: "absent" | "null" } | { presence: "value"; value: string };
export type NativeWatchStage = { kind: "final" } | { kind: "part"; index: number; total: number };
export interface NativeWatchBinding {
  roundKey: string;
  stage: NativeWatchStage;
  host: LauncherNativeSubmissionWatch["host"];
  lease: LauncherNativeSubmissionWatch["lease"];
  documentEpoch: string;
}
/** Structural mirrors of native-execution.ts; this transport layer owns no durable journal. */
export interface NativeWatchOperationScope {
  operationId: string; executionKey: string; roundKey: string;
  threadId?: string; turnId: string; traceId: string;
}
export interface NativeWatchCancelIntent {
  version: 1; cancelId: string; source: "native_interrupt";
  threadId: string; turnId: string; requestedAt: number;
  scope: NativeWatchOperationScope; sendId: string; binding: NativeWatchBinding;
}
export interface NativeWatchCancelTerminal {
  cancelId: string; sendId: string; sessionEpoch: string; watchSeq: number;
  proof: "same-bound-generation-stopped" | "same-bound-generation-completed" | "not_dispatched";
  assistantIdentity?: string; observedAt: number; dispatchAttempted: boolean;
}
/** Full ready was ACKed by parent first. Host receives no answer, only this sealed metadata. */
export interface NativeWatchResultReadyMetadata {
  version: 1; scope: NativeWatchOperationScope; sendId: string; completedDigest: string;
  answerSha256: string; readyAt: number; digest: string;
}
export interface NativeHostReleaseRequest {
  sendId: string; binding: NativeWatchBinding; sessionEpoch: string; terminalDigest: string;
}
export interface NativeHostReleaseReceipt {
  version: 1; releaseId: string; sendId: string; roundKey: string; sessionEpoch: string;
  host: NativeWatchBinding["host"]; lease: NativeWatchBinding["lease"];
  documentEpoch: string; outcome: "completed" | "cancelled"; terminalDigest: string;
}
export interface LauncherNativeReleaseReadRequest {
  phase: "native-release-read";
  traceId: string; helperPid: number; surfaceId: string; sendId: string;
  host: NativeWatchBinding["host"]; targetId: string; binding: NativeWatchBinding;
  sessionEpoch: string; scope: NativeWatchOperationScope;
  authorization: { resultReadyDigest: string }
    | { observation: import("./adapters/chatgpt-web/observation-recovery").BrowserObservationCheckpoint }
    | { cancelId: string; terminalDigest: string }
    | { cancelId: string; terminalDigest: string; intentDigest: string };
}
export interface NativeWatchCompletion {
  proof: "same-bound-assistant-completed";
  assistantIdentity: string;
  userMessageId: string;
  payloadSha256: string;
  watchSeq: number;
  observedAt: number;
}
/** Exact acknowledged native record, not a projection: digest = sha256(JSON.stringify(record)). */
export interface NativeWatchDurableReceipt {
  record: {
    version: 1;
    sendId: string;
    revision: number;
    phase: "stage_acknowledged" | "completed";
    binding: NativeWatchBinding;
    initialTurnIdentities: string[];
    post: Pick<LauncherNativeSubmissionWatch["identities"][number],
      "userMessageId" | "payloadSha256" | "parentMessageId" | "conversationId" | "action" | "observedAt">;
    dom: { acceptedUserIdentity: string; assistantIdentity: string; acceptedTurnIdentities: string[];
      proof: "same-bound-assistant-progress" | "same-bound-assistant-completed"; observedAt: number };
    hostWatch: LauncherNativeSubmissionWatch;
    stageAcknowledgement?: { expectedSha256: string; actualSha256: string; assistantIdentity: string };
    completion?: NativeWatchCompletion;
  };
  acknowledgement: { sendId: string; revision: number; digest: string };
}
export interface NativeWatchNotDispatchedReceipt {
  record: {
    version: 1; sendId: string; revision: number; phase: "watch_ready";
    initialTurnIdentities: string[]; binding: NativeWatchBinding; hostWatch: LauncherNativeSubmissionWatch;
  };
  acknowledgement: NativeWatchDurableReceipt["acknowledgement"];
}
export interface NativeWatchSegment {
  sendId: string;
  binding: NativeWatchBinding;
  state: "watching" | "stage-completed" | "completed";
  postCount: number;
  identities: LauncherNativeSubmissionWatch["identities"];
  initialConversationId: string | null;
  /** Compact retained proof; never embeds the full record or recursively nests watch snapshots. */
  durableReceipt?: {
    acknowledgement: NativeWatchDurableReceipt["acknowledgement"];
    watchSeq: number;
    stageAcknowledgement?: NonNullable<NativeWatchDurableReceipt["record"]["stageAcknowledgement"]>;
    completion?: NativeWatchCompletion;
  };
}
export interface LauncherNativeSubmissionWatch {
  version: 1;
  scope: NativeWatchOperationScope | null;
  resultReady?: NativeWatchResultReadyMetadata;
  cancellation?: { cancelId: string; intentDigest: string; requestedAt: number; dispatchAttempted: boolean;
    terminal?: NativeWatchCancelTerminal; terminalDigest?: string; notDispatchedDigest?: string };
  traceId: string;
  sendId: string;
  currentSendId: string;
  binding: NativeWatchBinding | null;
  segmentState: NativeWatchSegment["state"];
  totalPostCount: number;
  /** Previously closed segments; their proofs stay present after rotation. */
  segments: NativeWatchSegment[];
  latePosts: Array<{ observedDuringSendId: string; originalSendId: string;
    identity: LauncherNativeSubmissionWatch["identities"][number] }>;
  host: { pid: number; instanceId: string; profile: string; partition: string };
  lease: { helperPid: number; surfaceId: string; targetId: string };
  sessionEpoch: string;
  documentEpoch: string | null;
  mainFrame: { frameId: string; loaderId: string } | null;
  seq: number;
  active: boolean;
  gap: boolean;
  gapReasons: string[];
  conflict: boolean;
  conflictReasons: string[];
  postCount: number;
  identities: Array<{
    ordinal: number;
    watchOrdinal: number;
    endpoint: "/backend-api/conversation" | "/backend-api/f/conversation";
    requestId: string;
    frameId: string;
    loaderId: string;
    userMessageId: string;
    payloadSha256: string;
    action: NativeWatchField;
    parentMessageId: NativeWatchField;
    conversationId: NativeWatchField;
    observedAt: number;
  }>;
  startedAt: number;
  readAt: number;
  stoppedAt?: number;
  initialConversationId: string | null;
  boundConversationId: string | null;
  flush: { stable: boolean; pending: number; throughSeq: number };
}
interface LauncherNativeSubmissionWatchOwner {
  phase: "native-submission-watch";
  traceId: string;
  helperPid: number;
  surfaceId: string;
  sendId: string;
  host: LauncherNativeSubmissionWatch["host"];
  targetId: string;
}
export type LauncherNativeSubmissionWatchRequest = LauncherNativeSubmissionWatchOwner & (
  | { action: "start"; slot: Pick<NativeWatchBinding, "roundKey" | "stage">; scope: NativeWatchOperationScope }
  | { action: "read"; observation?: import("./adapters/chatgpt-web/observation-recovery").BrowserObservationCheckpoint }
  | { action: "stage-complete"; receipt: NativeWatchDurableReceipt;
      next: { sendId: string; binding: NativeWatchBinding } }
  | { action: "final-complete"; receipt: NativeWatchDurableReceipt; resultReady: NativeWatchResultReadyMetadata }
  | { action: "cancel-request"; intent: NativeWatchCancelIntent; acknowledgement: { digest: string }; dispatchAttempted: boolean }
  | { action: "cancel-terminal"; terminal: NativeWatchCancelTerminal; acknowledgement: { digest: string };
      notDispatchedReceipt?: NativeWatchNotDispatchedReceipt }
);

export type LauncherTurnActivity =
  | LauncherNativeReleaseReadRequest
  | LauncherNativeSubmissionWatchRequest
  | {
      phase: "observe-ready" | "observe";
      traceId: string;
      helperPid: number;
      surfaceId: string;
      observation: import("./adapters/chatgpt-web/observation-recovery").BrowserObservationCheckpoint;
    }
  | {
      phase: "approval";
      traceId: string;
      helperPid: number;
      surfaceId?: string;
      pending: boolean;
    }
  | {
      phase: "usage";
      traceId: string;
      helperPid: number;
      surfaceId?: string;
      receipt?: {
        id: string;
        accountKey: string;
        model: "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";
        at: number;
      };
      trackingError?: "account-unavailable";
    }
  | {
      phase: "start";
      traceId: string;
      helperPid: number;
      surfaceId?: string;
      conversationKey?: string;
      conversationUrl?: string;
      leaseFencing?: boolean;
      connectorIdentity?: string;
      requireRetainedConversation?: boolean;
    }
  | {
      phase: "heartbeat";
      traceId: string;
      helperPid: number;
      surfaceId?: string;
      /** Re-establish the launcher's hidden viewport after the caller closes its CDP session. */
      refreshViewport?: boolean;
      progress?: {
        stage: "preparing" | "sending" | "chatgpt";
        activeToolCalls: number;
      };
    }
  | {
      phase: "end";
      traceId: string;
      helperPid: number;
      surfaceId?: string;
      status: "completed" | "cancelled" | "failed" | "aborted";
      nativeRelease?: NativeHostReleaseRequest;
      message?: string;
      retain?: boolean;
      connectorBound?: boolean;
    };

// Startup must outlast the launcher's ten-second idle bootstrap. This is not a model-turn budget.
export const LAUNCHER_TURN_START_TIMEOUT_MS = 30_000;
export const LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS = 10_000;
export const LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS = 5_000;
export const LAUNCHER_TURN_END_TIMEOUT_MS = 15_000;

export interface LauncherManualTurnOwner {
  traceId: string;
  helperPid: number;
}

export interface LauncherManualTurnStart extends LauncherManualTurnOwner {
  prompt: string;
  /** Used only when the exact retained ChatGPT conversation already owns the accumulated history. */
  resumePrompt?: string;
  conversationKey?: string;
  /** Gives a manual context handoff enough time without widening ordinary Zero Risk turns. */
  compaction?: true;
}

export interface LauncherManualTurnLease {
  tabId: string;
  reused: boolean;
  deadlineAt: string | null;
  state: "awaiting-user" | "sent" | "running" | "completed";
}

export interface LauncherManualTurnEnd extends LauncherManualTurnOwner {
  status: "completed" | "failed" | "aborted";
  retain?: boolean;
}

export interface LauncherManualTurnTerminal {
  status: "cancelled" | "failed";
}

export const LAUNCHER_MANUAL_TURN_START_TIMEOUT_MS = 10_000;
export const LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS = 40_000;
export const LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS = 15_000;

async function launcherManualRequest(
  descriptor: LauncherBrowserHostDescriptor,
  action: "start" | "wait-sent" | "wait-terminal" | "started" | "end" | "cancel",
  body: LauncherManualTurnStart | LauncherManualTurnOwner | LauncherManualTurnEnd,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  abortSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/manual/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const decoded = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { response, body: decoded };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", abort);
  }
}

async function reconcileLauncherManualMutation(
  descriptor: LauncherBrowserHostDescriptor,
  action: "start" | "started" | "end",
  body: LauncherManualTurnStart | LauncherManualTurnOwner | LauncherManualTurnEnd,
  timeoutMs: number,
  validAcknowledgement: (body: Record<string, unknown>) => boolean,
  invalidAcknowledgementMessage: string,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  let ambiguousError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await launcherManualRequest(descriptor, action, body, timeoutMs);
      if (!result.response.ok || validAcknowledgement(result.body)) return result;
      ambiguousError = new LauncherManualTurnFailedError(invalidAcknowledgementMessage);
    } catch (error) {
      ambiguousError = error;
    }
  }
  // These mutations are keyed by the exact turn owner and are idempotent in the launcher.
  // The second identical request reconciles one missing or incomplete local acknowledgement.
  throw ambiguousError;
}

function isLauncherManualTurnLease(body: Record<string, unknown>): boolean {
  return body.ok === true
    && typeof body.tabId === "string"
    && body.tabId.length > 0
    && typeof body.reused === "boolean"
    && (body.deadlineAt === null
      || (typeof body.deadlineAt === "string" && !Number.isNaN(Date.parse(body.deadlineAt))))
    && ["awaiting-user", "sent", "running", "completed"].includes(String(body.state));
}

function throwManualControlError(response: Response, body: Record<string, unknown>): never {
  const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
  if (body.code === "turn_cancelled") throw new LauncherBrowserTurnCancelledError(message);
  if (body.code === "manual_turn_timed_out") throw new LauncherManualTurnTimedOutError(message);
  throw new LauncherManualTurnFailedError(message);
}

export async function startLauncherManualTurn(
  descriptorPath: string,
  activity: LauncherManualTurnStart,
  timeoutMs = LAUNCHER_MANUAL_TURN_START_TIMEOUT_MS,
): Promise<LauncherManualTurnLease> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await reconcileLauncherManualMutation(
    descriptor,
    "start",
    activity,
    timeoutMs,
    isLauncherManualTurnLease,
    "Launcher returned an invalid manual turn lease",
  );
  if (!response.ok) throwManualControlError(response, body);
  return {
    tabId: body.tabId as string,
    reused: body.reused as boolean,
    deadlineAt: body.deadlineAt as string | null,
    state: body.state as LauncherManualTurnLease["state"],
  };
}

export async function waitForLauncherManualSent(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ sentAt: string | null }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const timeoutMs = options.timeoutMs ?? LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS;
  for (;;) {
    if (options.abortSignal?.aborted) throw new DOMException("Manual Sent wait aborted", "AbortError");
    const { response, body } = await launcherManualRequest(
      descriptor,
      "wait-sent",
      owner,
      timeoutMs,
      options.abortSignal,
    );
    if (response.status === 202 && body.status === "pending") continue;
    if (!response.ok) throwManualControlError(response, body);
    if (body.status !== "sent"
      || (body.sentAt !== null && (typeof body.sentAt !== "string" || Number.isNaN(Date.parse(body.sentAt))))) {
      throw new LauncherManualTurnFailedError("Launcher returned invalid manual Sent confirmation");
    }
    return { sentAt: body.sentAt as string | null };
  }
}

export async function markLauncherManualTurnStarted(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<void> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await reconcileLauncherManualMutation(
    descriptor,
    "started",
    owner,
    timeoutMs,
    body => body.ok === true,
    "Launcher returned an invalid manual started acknowledgement",
  );
  if (!response.ok) throwManualControlError(response, body);
}

export async function waitForLauncherManualTerminal(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LauncherManualTurnTerminal> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const timeoutMs = options.timeoutMs ?? LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS;
  for (;;) {
    if (options.abortSignal?.aborted) throw new DOMException("Manual terminal wait aborted", "AbortError");
    const { response, body } = await launcherManualRequest(
      descriptor,
      "wait-terminal",
      owner,
      timeoutMs,
      options.abortSignal,
    );
    if (response.status === 202 && body.status === "pending") continue;
    if (!response.ok) throwManualControlError(response, body);
    if (body.status !== "cancelled" && body.status !== "failed") {
      throw new LauncherManualTurnFailedError("Launcher returned an invalid manual terminal signal");
    }
    return { status: body.status };
  }
}

export async function endLauncherManualTurn(
  descriptorPath: string,
  activity: LauncherManualTurnEnd,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<{ cancelledByUser: boolean }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await reconcileLauncherManualMutation(
    descriptor,
    "end",
    activity,
    timeoutMs,
    body => body.ok === true && typeof body.cancelledByUser === "boolean",
    "Launcher returned an invalid manual turn release result",
  );
  if (!response.ok) throwManualControlError(response, body);
  return { cancelledByUser: body.cancelledByUser as boolean };
}

export async function cancelLauncherManualTurn(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<void> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await launcherManualRequest(descriptor, "cancel", owner, timeoutMs);
  if (!response.ok) throwManualControlError(response, body);
}

export async function notifyLauncherTurn(
  descriptorPath: string,
  activity: LauncherTurnActivity,
  timeoutMs = activity.phase === "end"
    ? LAUNCHER_TURN_END_TIMEOUT_MS
    : activity.phase === "heartbeat" || activity.phase === "approval"
      ? LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS
      : LAUNCHER_TURN_START_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{
  surfaceId?: string;
  reused?: boolean;
  connectorBound?: boolean;
  cancelledByUser?: boolean;
  authenticationRequired?: boolean;
  trackUsage?: boolean;
  nativeSubmissionWatch?: LauncherNativeSubmissionWatch;
  nativeRelease?: NativeHostReleaseReceipt | null;
}> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/turn/${activity.phase}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(activity),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.status === 409 && body.code === "browser_writer_conflict") {
        throw new LauncherBrowserWriterConflictError("The browser tab or conversation already has another writer");
      }
      if (response.status === 409 && body.code === "turn_cancelled") {
        throw new LauncherBrowserTurnCancelledError(
          typeof body.error === "string" ? body.error : `Browser turn ${activity.traceId} was cancelled by the user`,
        );
      }
      if (response.status === 409 && body.code === "retained_conversation_unavailable") {
        throw new LauncherRetainedConversationUnavailableError(
          typeof body.error === "string" ? body.error : "The retained ChatGPT conversation is no longer available",
        );
      }
      if (response.status === 409 && body.code === "turn_owner_lost") {
        throw new LauncherBrowserTurnOwnerLostError(
          typeof body.error === "string" ? body.error : "The running ChatGPT turn lost its browser helper. Check its tab before retrying.",
        );
      }
      const detail = typeof body.error === "string" ? body.error : "";
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    let release: NativeHostReleaseReceipt | null | undefined;
    if (activity.phase === "native-release-read" || activity.phase === "end" && activity.nativeRelease) {
      const r = body.nativeRelease as NativeHostReleaseReceipt | null | undefined;
      const sealedCancel = activity.phase === "native-release-read" && "intentDigest" in activity.authorization
        ? activity.authorization : undefined;
      const expected = activity.phase === "end" ? activity.nativeRelease! : activity;
      if (body.ok !== true || r === undefined || (r === null && activity.phase === "end")
        || (sealedCancel && (!r || r.outcome !== "cancelled" || r.terminalDigest !== sealedCancel.terminalDigest))
        || (r !== null && (!r || Object.keys(r).length !== 10 || r.version !== 1
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.releaseId)
          || r.sendId !== expected.sendId || r.roundKey !== expected.binding.roundKey
          || r.sessionEpoch !== expected.sessionEpoch || r.documentEpoch !== expected.binding.documentEpoch
          || !["pid", "instanceId", "profile", "partition"].every(k =>
            r.host?.[k as keyof typeof r.host] === expected.binding.host[k as keyof typeof r.host])
          || !["helperPid", "surfaceId", "targetId"].every(k =>
            r.lease?.[k as keyof typeof r.lease] === expected.binding.lease[k as keyof typeof r.lease])
          || !["completed", "cancelled"].includes(r.outcome) || !/^[a-f0-9]{64}$/.test(r.terminalDigest)
          || (activity.phase === "end" && (r.outcome !== activity.status || r.terminalDigest !== activity.nativeRelease!.terminalDigest))))) {
        throw new Error("Launcher returned invalid original release metadata");
      }
      release = r;
      if (activity.phase === "native-release-read") return { nativeRelease: release };
    }
    if (activity.phase === "native-submission-watch") {
      const watch = body.nativeSubmissionWatch as LauncherNativeSubmissionWatch | undefined;
      const expectedSendId = activity.action === "stage-complete" ? activity.next.sendId : activity.sendId;
      const observation = activity.action === "read" ? activity.observation : undefined;
      if (body.ok !== true || !watch || watch.version !== 1 || watch.traceId !== activity.traceId
        || watch.sendId !== expectedSendId || watch.host?.pid !== activity.host.pid
        || watch.host?.instanceId !== activity.host.instanceId || watch.host?.profile !== activity.host.profile
        || watch.host?.partition !== activity.host.partition || watch.lease?.surfaceId !== activity.surfaceId
        || watch.lease?.targetId !== activity.targetId
        || watch.lease?.helperPid !== (observation?.lease.helperPid ?? activity.helperPid)
        || !watch.scope || watch.scope.traceId !== activity.traceId || watch.scope.roundKey !== watch.binding?.roundKey
        || (activity.action === "start" && (Object.hasOwn(watch.scope, "threadId") !== Object.hasOwn(activity.scope, "threadId")
          || ["operationId", "executionKey", "roundKey", "threadId", "turnId", "traceId"]
            .some(k => watch.scope![k as keyof NativeWatchOperationScope] !== activity.scope[k as keyof NativeWatchOperationScope])))
        || (activity.action === "final-complete" && JSON.stringify(watch.resultReady) !== JSON.stringify(activity.resultReady))
        || (activity.action === "cancel-request" && (watch.cancellation?.cancelId !== activity.intent.cancelId
          || watch.cancellation?.intentDigest !== activity.acknowledgement.digest
          || watch.cancellation?.dispatchAttempted !== activity.dispatchAttempted))
        || (activity.action === "cancel-terminal" && (watch.cancellation?.terminalDigest !== activity.acknowledgement.digest
          || JSON.stringify(watch.cancellation?.terminal) !== JSON.stringify(activity.terminal)))
        || typeof watch.currentSendId !== "string" || !["watching", "stage-completed", "completed"].includes(watch.segmentState)
        || !Number.isSafeInteger(watch.totalPostCount) || watch.totalPostCount < watch.postCount
        || !Array.isArray(watch.segments) || !Array.isArray(watch.latePosts)
        || (watch.binding !== null && (!watch.binding || typeof watch.binding.roundKey !== "string"
          || !watch.binding.roundKey || watch.binding.documentEpoch !== watch.documentEpoch
          || JSON.stringify(watch.binding.host) !== JSON.stringify(watch.host)
          || JSON.stringify(watch.binding.lease) !== JSON.stringify(watch.lease)))
        || !Number.isSafeInteger(watch.seq) || watch.seq < 0
        || typeof watch.sessionEpoch !== "string" || !watch.sessionEpoch
        || (watch.documentEpoch !== null && (typeof watch.documentEpoch !== "string" || !watch.mainFrame
          || typeof watch.mainFrame.frameId !== "string" || !watch.mainFrame.frameId
          || typeof watch.mainFrame.loaderId !== "string" || !watch.mainFrame.loaderId
          || watch.documentEpoch !== JSON.stringify([watch.mainFrame.frameId, watch.mainFrame.loaderId])))
        || (watch.active && watch.documentEpoch === null)
        || typeof watch.active !== "boolean" || typeof watch.gap !== "boolean" || typeof watch.conflict !== "boolean"
        || !Array.isArray(watch.identities) || !Array.isArray(watch.gapReasons) || !Array.isArray(watch.conflictReasons)
        || !Number.isSafeInteger(watch.postCount) || watch.postCount < watch.identities.length
        || watch.identities.some(post => !post || typeof post.userMessageId !== "string"
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(post.userMessageId)
          || typeof post.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(post.payloadSha256)
          || !["/backend-api/conversation", "/backend-api/f/conversation"].includes(post.endpoint)
          || post.frameId !== watch.mainFrame?.frameId || post.loaderId !== watch.mainFrame?.loaderId
          || typeof post.requestId !== "string" || !post.requestId
          || !Number.isSafeInteger(post.ordinal) || post.ordinal < 1 || post.ordinal > watch.postCount
          || !Number.isSafeInteger(post.watchOrdinal) || post.watchOrdinal < 1 || post.watchOrdinal > watch.totalPostCount
          || !Number.isSafeInteger(post.observedAt) || post.observedAt < 1
          || [post.action, post.parentMessageId, post.conversationId].some(field => !field
            || (field.presence === "absent" || field.presence === "null"
              ? Object.keys(field).length !== 1
              : field.presence !== "value" || typeof field.value !== "string"
                || !field.value || Object.keys(field).length !== 2)))
        || typeof watch.flush?.stable !== "boolean" || !Number.isSafeInteger(watch.flush?.pending)
        || watch.flush.pending < 0 || watch.flush.throughSeq !== watch.seq
        || (watch.flush.stable && watch.flush.pending !== 0)) {
        throw new Error("Launcher returned an invalid original submission watch");
      }
      return { nativeSubmissionWatch: watch };
    }
    if (activity.phase === "start") {
      if (typeof body.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.surfaceId)) {
        throw new Error("Launcher browser control channel returned an invalid turn surface id");
      }
      if (typeof body.reused !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid reuse state");
      }
      if (typeof body.connectorBound !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid connector state");
      }
      return {
        surfaceId: body.surfaceId,
        reused: body.reused,
        connectorBound: body.connectorBound,
        trackUsage: body.trackUsage === true,
      };
    }
    if (activity.phase === "end") {
      if (typeof body.cancelledByUser !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid turn release result");
      }
      if (body.authenticationRequired !== undefined && typeof body.authenticationRequired !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid authentication state");
      }
      return {
        cancelledByUser: body.cancelledByUser,
        ...(release ? { nativeRelease: release } : {}),
        ...(body.authenticationRequired === true ? { authenticationRequired: true } : {}),
      };
    }
    return {};
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Launcher browser acquisition cancelled", "AbortError");
    if (controller.signal.aborted) throw new Error(`Launcher browser control ${activity.phase} timed out after ${timeoutMs}ms`);
    if (error instanceof LauncherBrowserTurnCancelledError
      || error instanceof LauncherBrowserTurnOwnerLostError
      || error instanceof LauncherRetainedConversationUnavailableError
      || error instanceof LauncherBrowserWriterConflictError) throw error;
    throw new Error(`Launcher browser control channel failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function releaseLauncherRetainedConversation(
  descriptorPath: string,
  conversationKey: string,
  timeoutMs = LAUNCHER_TURN_END_TIMEOUT_MS,
): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(conversationKey)) {
    throw new Error("Launcher retained conversation key is invalid");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationKey }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || !Number.isSafeInteger(body.released) || Number(body.released) < 0) {
      const detail = typeof body.error === "string" ? `: ${body.error}` : "";
      throw new Error(`HTTP ${response.status}${detail}`);
    }
    return Number(body.released);
  } catch (error) {
    throw new Error(`Launcher retained conversation release failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在已登录的 launcher 浏览器里重新读取一个会话内下载 URL。生成文件的本地缓存过期后
 * 用它取回字节；只在已打开本站页面时复用该页，否则临时开一个页面并在结束后关闭。
 */
export async function fetchLauncherAuthenticatedBytes(
  descriptorPath: string,
  url: string,
  options: { maxBytes: number; timeoutMs?: number },
): Promise<{ bytes: Uint8Array; mime: string }> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "chatgpt.com" || endpoint.username || endpoint.password) {
    throw new Error("Only observed ChatGPT download endpoints can be re-read in the launcher browser");
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const connection = await connectLauncherBrowserHost(descriptorPath, Math.min(timeoutMs, 30_000));
  let temporary: Page | undefined;
  try {
    let page = connection.context.pages().find(candidate => candidate.url().startsWith("https://chatgpt.com/"));
    if (!page) {
      temporary = await connection.context.newPage();
      await temporary.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: timeoutMs });
      page = temporary;
    }
    const captured = await page.evaluate(async ({ href, limit, budget }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      try {
        const response = await fetch(href, { credentials: "include", signal: controller.signal });
        if (!response.ok) throw new Error("Download HTTP " + response.status);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Download was empty");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) { await reader.cancel(); throw new Error("Download exceeds the size limit"); }
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { base64: btoa(binary), mime: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() };
      } finally { clearTimeout(timer); }
    }, { href: url, limit: options.maxBytes, budget: timeoutMs });
    const bytes = Buffer.from(captured.base64, "base64");
    if (bytes.length === 0 || bytes.length > options.maxBytes) throw new Error("Invalid download size");
    return { bytes, mime: captured.mime };
  } finally {
    await temporary?.close().catch(() => {});
    await browserDisconnect(connection.browser);
  }
}

async function browserDisconnect(browser: Browser): Promise<void> {
  // CDP 连接关闭只断开 Playwright 的传输，不关闭用户正在使用的浏览器。
  await browser.close().catch(() => {});
}
