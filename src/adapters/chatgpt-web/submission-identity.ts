import type { NativeOperationScope, NativeCancelIntent, NativeCancelTerminal, NativeResultReady } from "./native-execution";
import type { LauncherNativeSubmissionWatch } from "../../launcher-browser-host";
import { createHash, randomUUID } from "node:crypto";
import type { Page, Request, Response } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";

type ObservedId = { presence: "absent" } | { presence: "null" } | { presence: "value"; value: string };
export interface NativeSubmissionBinding {
  roundKey: string;
  stage: { kind: "final" } | { kind: "part"; index: number; total: number };
  host: LauncherNativeSubmissionWatch["host"];
  lease: LauncherNativeSubmissionWatch["lease"];
  documentEpoch: string | null;
}
export interface NativeSubmissionControls {
  binding: NativeSubmissionBinding;
  watch(action: "start" | "read", record: NativeSubmissionRecord, deadlineAt?: number, cleanupIntent?: NativeCancelIntent): Promise<LauncherNativeSubmissionWatch>;
  complete(record: NativeSubmissionRecord, ready: NativeResultReady): Promise<void>;
  requestCancel(record: NativeSubmissionRecord, intent: NativeCancelIntent, dispatchAttempted: boolean, deadlineAt: number): Promise<LauncherNativeSubmissionWatch>;
  cancelTerminal(record: NativeSubmissionRecord, terminal: NativeCancelTerminal, deadlineAt: number): Promise<void>;
  readCleanup(record: NativeSubmissionRecord, deadlineAt: number): Promise<LauncherNativeSubmissionWatch>;
  deadlineAt?: () => number | undefined;
}
export interface NativeSubmissionRecord {
  version: 1;
  sendId: string;
  revision: number;
  phase: "send_activated" | "watch_ready" | "post_observed" | "accepted" | "stage_acknowledged" | "completed" | "conflict";
  initialTurnIdentities: string[];
  expectedConversationId?: string;
  binding?: NativeSubmissionBinding;
  hostWatch?: LauncherNativeSubmissionWatch;
  stageAcknowledgement?: { expectedSha256: string; actualSha256: string; assistantIdentity: string };
  completion?: { proof: "same-bound-assistant-completed"; assistantIdentity: string; userMessageId: string; payloadSha256: string; watchSeq: number; observedAt: number };
  post?: { userMessageId: string; parentMessageId: ObservedId; conversationId: ObservedId;
    action: ObservedId; payloadSha256: string; observedAt: number };
  dom?: { acceptedUserIdentity: string; assistantIdentity: string; acceptedTurnIdentities: string[];
    proof: "same-bound-assistant-progress" | "same-bound-assistant-completed"; observedAt: number };
  conflict?: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10000
  && value.every(x => typeof x === "string" && x.length > 0 && x.length <= 4096)
  && new Set(value).size === value.length;
export function submissionIdentityUnproven(reason: string, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(`The original browser submission identity is unresolved: ${reason}. Execution is retained; do not resend.`, {
    status: 409, errorType: "server_error", code: "chatgpt_submission_identity_unproven", retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}
export function retainsBrowserExecution(error: unknown): boolean {
  return error instanceof ChatGptWebAdapterError && ["chatgpt_recovery_budget_exhausted",
    "chatgpt_recovery_budget_missing", "chatgpt_submission_identity_unproven", "chatgpt_execution_retained",
    "chatgpt_browser_release_unconfirmed", "chatgpt_bound_turn_incomplete"].includes(error.code);
}

function field(body: Record<string, unknown>, key: string): ObservedId {
  if (!Object.hasOwn(body, key)) return { presence: "absent" };
  if (body[key] === null) return { presence: "null" };
  if (typeof body[key] !== "string" || !body[key] || body[key].length > 4096) throw submissionIdentityUnproven(`invalid ${key}`);
  return { presence: "value", value: body[key] };
}
function validField(value: unknown): boolean {
  const v = value as ObservedId;
  return !!v && (v.presence === "absent" || v.presence === "null"
    ? Object.keys(v).length === 1 : v.presence === "value" && Object.keys(v).length === 2
      && typeof v.value === "string" && v.value.length > 0 && v.value.length <= 4096);
}
export function parseNativeSubmission(value: unknown): NativeSubmissionRecord {
  const r = value as NativeSubmissionRecord;
  if (!r || r.version !== 1 || !uuid.test(r.sendId) || !Number.isSafeInteger(r.revision) || r.revision < 1
    || !["send_activated", "watch_ready", "post_observed", "accepted", "stage_acknowledged", "completed", "conflict"].includes(r.phase) || !ids(r.initialTurnIdentities)
    || r.expectedConversationId !== undefined && (typeof r.expectedConversationId !== "string" || !r.expectedConversationId || r.expectedConversationId.length > 4096)) {
    throw submissionIdentityUnproven("invalid durable submission record");
  }
  const expectedRevision = r.binding
    ? { send_activated: 1, watch_ready: 2, post_observed: 3, accepted: 4, stage_acknowledged: 5, completed: 5 }[r.phase as Exclude<NativeSubmissionRecord["phase"], "conflict">]
    : { send_activated: 1, post_observed: 2, accepted: 3 }[r.phase as "send_activated" | "post_observed" | "accepted"];
  if (r.phase !== "conflict" && r.revision !== expectedRevision || r.phase === "conflict" && r.revision < 2) {
    throw submissionIdentityUnproven("invalid native submission revision");
  }
  if (!["send_activated", "watch_ready", "conflict"].includes(r.phase) && !r.post) throw submissionIdentityUnproven("POST identity missing");
  if (["send_activated", "watch_ready"].includes(r.phase) && r.post) throw submissionIdentityUnproven("POST identity precedes the armed Send");
  if (r.binding) {
    const b = r.binding;
    if (!b.roundKey || !["final", "part"].includes(b.stage?.kind)
      || b.stage.kind === "part" && (!Number.isSafeInteger(b.stage.index) || !Number.isSafeInteger(b.stage.total)
        || b.stage.index < 1 || b.stage.total < b.stage.index || b.stage.total > 128)
      || !Number.isSafeInteger(b.host?.pid) || b.host.pid < 1 || !/^[A-Za-z0-9_-]{32}$/.test(b.host.instanceId)
      || !["production", "development"].includes(b.host.profile)
      || b.host.partition !== (b.host.profile === "development" ? "persist:codex-web-gpt-dev-chatgpt" : "persist:codex-web-gpt-chatgpt")
      || !Number.isSafeInteger(b.lease?.helperPid) || b.lease.helperPid < 1 || !/^[A-Za-z0-9_-]{32}$/.test(b.lease.surfaceId)
      || typeof b.lease.targetId !== "string" || !b.lease.targetId
      || r.phase !== "send_activated" && r.phase !== "conflict" && (typeof b.documentEpoch !== "string" || !b.documentEpoch)) {
      throw submissionIdentityUnproven("invalid physical slot ownership binding");
    }
    if (r.phase !== "send_activated" && r.phase !== "conflict") assertNativeHostWatch(r, r.hostWatch);
  }
  if (r.post && (!uuid.test(r.post.userMessageId) || !digest.test(r.post.payloadSha256)
    || !validField(r.post.parentMessageId) || !validField(r.post.conversationId) || !validField(r.post.action)
    || !Number.isSafeInteger(r.post.observedAt) || r.post.observedAt <= 0)) throw submissionIdentityUnproven("invalid POST identity");
  if (["accepted", "stage_acknowledged", "completed"].includes(r.phase)) {
    const p = r.post!, d = r.dom;
    const user = `group:user:${p.userMessageId}`, assistant = `group:assistant:${p.userMessageId}`;
    if (!d || d.acceptedUserIdentity !== user || d.assistantIdentity !== assistant || !ids(d.acceptedTurnIdentities)
      || !d.acceptedTurnIdentities.includes(user) || !d.acceptedTurnIdentities.includes(assistant)
      || r.initialTurnIdentities.includes(user) || r.initialTurnIdentities.includes(assistant)
      || d.acceptedTurnIdentities.some(id => !r.initialTurnIdentities.includes(id) && id !== user && id !== assistant)
      || !["same-bound-assistant-progress", "same-bound-assistant-completed"].includes(d.proof)
      || !Number.isSafeInteger(d.observedAt) || d.observedAt < p.observedAt) throw submissionIdentityUnproven("invalid owned DOM generation witness");
  } else if (r.phase !== "conflict" && r.dom) throw submissionIdentityUnproven("unaccepted DOM witness");
  if (r.phase === "stage_acknowledged" && (r.binding?.stage.kind !== "part" || !r.stageAcknowledgement
    || !digest.test(r.stageAcknowledgement.expectedSha256) || r.stageAcknowledgement.expectedSha256 !== r.stageAcknowledgement.actualSha256
    || r.stageAcknowledgement.assistantIdentity !== r.dom?.assistantIdentity)) throw submissionIdentityUnproven("invalid completed multipart stage");
  if (r.phase === "completed" && (r.binding?.stage.kind !== "final" || !r.completion
    || r.completion.proof !== "same-bound-assistant-completed" || r.completion.userMessageId !== r.post?.userMessageId
    || r.completion.payloadSha256 !== r.post?.payloadSha256 || r.completion.watchSeq !== r.hostWatch?.seq
    || r.completion.assistantIdentity !== r.dom?.assistantIdentity
    || !Number.isSafeInteger(r.completion.observedAt) || r.completion.observedAt < r.dom.observedAt)) throw submissionIdentityUnproven("invalid original writer completion");
  if (r.phase === "conflict" && (typeof r.conflict !== "string" || !r.conflict)) throw submissionIdentityUnproven("missing conflict");
  return structuredClone(r);
}

export function assertNativeHostWatch(record: NativeSubmissionRecord, value: LauncherNativeSubmissionWatch | undefined): asserts value is LauncherNativeSubmissionWatch {
  const b = record.binding;
  if (!b || !value || value.version !== 1 || value.sendId !== record.sendId
    || record.hostWatch && (value.sessionEpoch !== record.hostWatch.sessionEpoch || value.seq < record.hostWatch.seq)
    || value.currentSendId !== record.sendId || value.binding?.roundKey !== b.roundKey
    || JSON.stringify(value.binding?.stage) !== JSON.stringify(b.stage)
    || !value.active || value.gap || value.conflict || !value.flush?.stable || value.flush.pending !== 0
    || value.flush.throughSeq !== value.seq || value.documentEpoch !== b.documentEpoch
    || JSON.stringify(value.host) !== JSON.stringify(b.host) || JSON.stringify(value.lease) !== JSON.stringify(b.lease)
    || value.postCount !== (record.post ? 1 : 0) || value.identities.length !== (record.post ? 1 : 0)
    || record.expectedConversationId && value.initialConversationId !== record.expectedConversationId) {
    throw submissionIdentityUnproven("continuous original Host observation is incomplete or changed");
  }
  if (record.post) for (const key of ["userMessageId", "payloadSha256", "action", "parentMessageId", "conversationId"] as const) {
    if (JSON.stringify(record.post[key]) !== JSON.stringify(value.identities[0]![key])) {
      throw submissionIdentityUnproven("helper POST differs from the continuously observed original Host POST");
    }
  }
}

export function nativeSubmissionDescendsFrom(ancestor: NativeSubmissionRecord, current: NativeSubmissionRecord): boolean {
  if (JSON.stringify(ancestor) === JSON.stringify(current)) return true;
  if (ancestor.phase !== "accepted" || current.phase !== "completed" || current.revision !== ancestor.revision + 1
    || ancestor.binding?.stage.kind !== "final" || current.binding?.stage.kind !== "final") return false;
  for (const key of ["version", "sendId", "initialTurnIdentities", "expectedConversationId", "binding", "post", "dom"] as const) {
    if (JSON.stringify(ancestor[key]) !== JSON.stringify(current[key])) return false;
  }
  const oldWatch = ancestor.hostWatch, latest = current.hostWatch;
  return !!oldWatch && !!latest && oldWatch.sessionEpoch === latest.sessionEpoch
    && oldWatch.documentEpoch === latest.documentEpoch && latest.seq >= oldWatch.seq
    && JSON.stringify(oldWatch.identities) === JSON.stringify(latest.identities);
}

export function nativeSubmissionDigest(value: NativeSubmissionRecord): string {
  return createHash("sha256").update(JSON.stringify(parseNativeSubmission(value))).digest("hex");
}

/** One owned page, one physical Send. It observes browser requests and never changes them. */
export class NativeSubmissionCollector {
  private page?: Page;
  private record?: NativeSubmissionRecord;
  private acknowledgedRecord?: NativeSubmissionRecord;
  private readonly requests = new Set<Request>();
  private responseAccepted = false;
  private resolveResponseAccepted?: () => void;
  private readonly responseAcceptedPromise = new Promise<void>(resolve => {
    this.resolveResponseAccepted = resolve;
  });
  private dispatchedAt?: number;
  private posts = 0;
  private armed = false;
  private dispatchAttempted = false;
  private resultReady?: NativeResultReady;
  private cleanupAuthority?: {intent:NativeCancelIntent;deadlineAt:number};
  private acknowledged: Promise<void> = Promise.resolve();
  private failure?: Error;
  private rejectFailure!: (error: Error) => void;
  readonly failed: Promise<never>;
  constructor(private readonly persist: (record: NativeSubmissionRecord) => void | Promise<void>, private readonly controls?: NativeSubmissionControls) {
    this.failed = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
    void this.failed.catch(() => {});
  }
  async activate(page: Page, initialTurnIdentities: readonly string[], expectedConversationId?: string): Promise<void> {
    if (this.record) throw submissionIdentityUnproven("physical Send was already activated");
    this.record = { version: 1, sendId: randomUUID(), revision: 1, phase: "send_activated", initialTurnIdentities: [...initialTurnIdentities], ...(expectedConversationId ? { expectedConversationId } : {}), ...(this.controls ? { binding: structuredClone(this.controls.binding) } : {}) };
    this.page = page;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    const snapshot = parseNativeSubmission(this.record);
    await this.persist(snapshot);
    this.acknowledgedRecord = snapshot;
    if (this.controls) {
      const watch = await this.controls.watch("start", snapshot);
      if (!watch.documentEpoch) throw submissionIdentityUnproven("original Host document is unobserved");
      this.record = { ...snapshot, revision: 2, phase: "watch_ready", hostWatch: watch,
        binding: { ...snapshot.binding!, documentEpoch: watch.documentEpoch } };
      this.checkpoint();
      await this.observed();
    }
  }
  arm(): void {
    if (!this.record || !this.acknowledgedRecord || this.armed || this.failure || this.cleanupAuthority
      || this.acknowledgedRecord.revision !== this.record.revision
      || (this.controls ? this.record.phase !== "watch_ready" : this.record.phase !== "send_activated")) throw submissionIdentityUnproven("Send activation is unavailable or duplicated");
    this.armed = true;
  }
  dispatching(): void {
    if (!this.armed || this.dispatchAttempted || this.failure) throw submissionIdentityUnproven("physical dispatch is unavailable or duplicated");
    this.dispatchAttempted = true;
    this.dispatchedAt = performance.now();
  }
  didAttemptDispatch(): boolean { return this.dispatchAttempted; }
  acknowledgedSnapshot(): NativeSubmissionRecord | undefined {
    return this.acknowledgedRecord && parseNativeSubmission(this.acknowledgedRecord);
  }
  async requestCancel(intent: NativeCancelIntent, deadlineAt: number): Promise<LauncherNativeSubmissionWatch> {
    await this.observed();
    const record = this.acknowledgedSnapshot();
    if (!record || !this.controls || record.sendId !== intent.sendId || JSON.stringify(record.binding) !== JSON.stringify(intent.binding)) {
      throw submissionIdentityUnproven("explicit cancellation does not match the original durable slot");
    }
    const watch = await this.controls.requestCancel(record, intent, this.dispatchAttempted, deadlineAt);
    assertNativeHostWatch(record, watch);
    this.cleanupAuthority={intent:structuredClone(intent),deadlineAt};
    return watch;
  }
  async readCleanup(deadlineAt: number): Promise<LauncherNativeSubmissionWatch> {
    const record = this.acknowledgedSnapshot();
    if (!record || !this.controls) throw submissionIdentityUnproven("original cleanup watch is unavailable");
    const watch = await this.controls.readCleanup(record, deadlineAt);assertNativeHostWatch(record, watch);return watch;
  }
  async publishCancelTerminal(terminal: NativeCancelTerminal, deadlineAt: number): Promise<void> {
    const record = this.acknowledgedSnapshot();
    if (!record || !this.controls || terminal.dispatchAttempted !== this.dispatchAttempted) throw submissionIdentityUnproven("original cancellation dispatch proof changed");
    await this.controls.cancelTerminal(record, terminal, deadlineAt);
  }
  makeResultReady(scope: NativeOperationScope, answer: string): NativeResultReady {
    const record=this.acknowledgedSnapshot();
    if(record?.phase!=="completed")throw submissionIdentityUnproven("original result is not durably completed");
    const answerSha256=createHash("sha256").update(answer).digest("hex");
    if(this.resultReady){
      if(this.resultReady.answerSha256!==answerSha256 || JSON.stringify(this.resultReady.scope)!==JSON.stringify(scope))throw submissionIdentityUnproven("original result-ready changed");
    }else this.resultReady={version:1,scope:structuredClone(scope),sendId:record.sendId,
      completedDigest:nativeSubmissionDigest(record),answer,answerSha256,readyAt:Date.now()};
    return structuredClone(this.resultReady);
  }
  async publishResultReady(ready: NativeResultReady): Promise<void> {
    const record = this.acknowledgedSnapshot();
    if (record?.phase !== "completed" || !this.controls || nativeSubmissionDigest(record) !== ready.completedDigest) throw submissionIdentityUnproven("result-ready does not match the original completed slot");
    await this.controls.complete(record, ready);
  }
  private async readHost(record: NativeSubmissionRecord, expectedPosts = record.post ? 1 : 0): Promise<LauncherNativeSubmissionWatch> {
    const cleanup=this.cleanupAuthority;
    const deadline = Math.min(Date.now() + 2_000, cleanup?.deadlineAt ?? this.controls!.deadlineAt?.() ?? Infinity);
    for (;;) {
      if (Date.now() >= deadline) throw submissionIdentityUnproven("original Host metadata handshake deadline exhausted");
      const watch = await this.controls!.watch("read", record, deadline,cleanup?.intent);
      if (Date.now() >= deadline) throw submissionIdentityUnproven("original Host metadata arrived after its handshake deadline");
      // Validate immutable fences before replacing the acknowledged Host snapshot.
      if (record.hostWatch && (watch.sessionEpoch !== record.hostWatch.sessionEpoch || watch.seq < record.hostWatch.seq)) {
        throw submissionIdentityUnproven("original continuous Host session changed or regressed");
      }
      if (watch.postCount !== 0 || expectedPosts === 0) {
        assertNativeHostWatch(record, watch);
        return watch;
      }
      // Independent CDP sessions may deliver the same POST in either order. Wait only for
      // metadata on the original continuous session, bounded by this handshake and turn clock.
      assertNativeHostWatch({ ...record, post: undefined }, watch);
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
  private checkpoint(): void {
    const snapshot = structuredClone(this.record!);
    this.acknowledged = this.acknowledged.then(async () => {
      if (this.controls && snapshot.phase !== "watch_ready" && snapshot.phase !== "conflict") {
        const watch = await this.readHost(snapshot);
        snapshot.hostWatch = watch;
        if (snapshot.completion) snapshot.completion.watchSeq = watch.seq;
      }
      const validated = parseNativeSubmission(snapshot);
      await this.persist(validated);
      this.acknowledgedRecord = validated;
      if (this.record?.revision === snapshot.revision) this.record = structuredClone(validated);
    }).catch(error => {
      this.failure = submissionIdentityUnproven("durable identity acknowledgement failed");
      this.rejectFailure(this.failure);
    });
  }
  private readonly onRequest = (request: Request): void => {
    if (!this.page || request.method() !== "POST"
      || !/^https:\/\/chatgpt\.com\/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(request.url())
      || request.frame() !== this.page.mainFrame()) return;
    const r = this.record!;
    try {
      if (!this.armed) throw submissionIdentityUnproven("browser POST preceded the owned Send activation");
      if (++this.posts !== 1) throw submissionIdentityUnproven("multiple conversation POSTs on the owned Send");
      const raw = request.postData();
      if (!raw) throw submissionIdentityUnproven("POST body is unavailable");
      const body = JSON.parse(raw);
      const messages = body?.messages;
      if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.author?.role !== "user"
        || !uuid.test(messages[0]?.id ?? "")) throw submissionIdentityUnproven("unqualified conversation POST shape");
      const action = field(body, "action");
      if (action.presence === "value" && action.value !== "next") throw submissionIdentityUnproven("conversation action is not a new user message");
      r.post = { userMessageId: messages[0].id, parentMessageId: field(body, "parent_message_id"),
        conversationId: field(body, "conversation_id"), action,
        payloadSha256: createHash("sha256").update(raw).digest("hex"), observedAt: Date.now() };
      if (r.expectedConversationId && (r.post.conversationId.presence !== "value"
        || r.post.conversationId.value !== r.expectedConversationId)) {
        throw submissionIdentityUnproven("POST conversation differs from the original saved page");
      }
      this.requests.add(request);
      r.phase = "post_observed";
      r.revision++;
      console.info(`[chatgpt-web] native submission post_observed ${JSON.stringify({
        sendId: r.sendId, postMs: this.dispatchedAt === undefined ? undefined : Math.round(performance.now() - this.dispatchedAt),
      })}`);
      this.checkpoint();
    } catch (error) {
      this.failure = error instanceof ChatGptWebAdapterError ? error : submissionIdentityUnproven("POST identity could not be parsed");
      this.rejectFailure(this.failure);
      r.phase = "conflict"; r.conflict = this.failure.message; r.revision++;
      this.checkpoint();
    }
  };
  private readonly onResponse = (response: Response): void => {
    const request = response.request();
    if (!this.requests.delete(request) || this.responseAccepted) return;
    if (response.status() !== 200 || !response.headers()["content-type"]?.includes("text/event-stream")) return;
    this.responseAccepted = true;
    console.info(`[chatgpt-web] native submission response_accepted ${JSON.stringify({
      sendId: this.record?.sendId, responseMs: this.dispatchedAt === undefined ? undefined : Math.round(performance.now() - this.dispatchedAt),
    })}`);
    this.resolveResponseAccepted?.();
  };
  waitForResponseAccepted(): Promise<void> {
    return this.responseAcceptedPromise;
  }
  async observed(): Promise<NativeSubmissionRecord | undefined> {
    for (;;) {
      const queued = this.acknowledged;
      await queued;
      if (queued !== this.acknowledged) continue;
      if (this.failure) throw this.failure;
      return this.acknowledgedRecord?.post ? parseNativeSubmission(this.acknowledgedRecord) : undefined;
    }
  }
  async accept(turnIdentities: string[], proof: NonNullable<NativeSubmissionRecord["dom"]>["proof"]): Promise<NativeSubmissionRecord> {
    const observed = await this.observed();
    if (!observed?.post) throw submissionIdentityUnproven("native POST has not been durably observed");
    if (observed.phase === "accepted") return observed;
    const r = this.record = structuredClone(observed);
    r.dom = { acceptedUserIdentity: `group:user:${r.post!.userMessageId}`,
      assistantIdentity: `group:assistant:${r.post!.userMessageId}`, acceptedTurnIdentities: [...turnIdentities], proof, observedAt: Date.now() };
    r.phase = "accepted"; r.revision++;
    this.checkpoint();
    const accepted = await this.observed();
    if (accepted?.phase !== "accepted") throw submissionIdentityUnproven("acceptance could not be recorded");
    return accepted;
  }
  async reattach(page: Page): Promise<void> {
    await this.observed();
    if (!this.acknowledgedRecord?.post || !this.controls || !this.armed) throw submissionIdentityUnproven("original Page POST identity was not durably witnessed; execution remains retained");
    // Host continues watching while our Page transport is absent. Retire only this old listener.
    this.page?.off("request", this.onRequest);
    this.page?.off("response", this.onResponse);
    const record = structuredClone(this.acknowledgedRecord);
    assertNativeHostWatch(record, await this.readHost(record));
    this.page = page; page.on("request", this.onRequest); page.on("response", this.onResponse);
  }
  async acknowledgeStage(expected: string, actual: string): Promise<NativeSubmissionRecord> {
    const prior = await this.observed();
    if (prior?.phase !== "accepted" || prior.binding?.stage.kind !== "part") throw submissionIdentityUnproven("original multipart stage is not accepted");
    this.record = { ...prior, revision: prior.revision + 1, phase: "stage_acknowledged", stageAcknowledgement: {
      expectedSha256: createHash("sha256").update(expected).digest("hex"), actualSha256: createHash("sha256").update(actual).digest("hex"), assistantIdentity: prior.dom!.assistantIdentity } };
    this.checkpoint(); return (await this.observed())!;
  }
  async completed(): Promise<NativeSubmissionRecord> {
    const prior = await this.observed();
    if (prior?.phase !== "accepted" || prior.binding?.stage.kind !== "final") throw submissionIdentityUnproven("original final is not accepted");
    this.record = { ...prior, revision: prior.revision + 1, phase: "completed", completion: {
      proof: "same-bound-assistant-completed", assistantIdentity: prior.dom!.assistantIdentity,
      userMessageId: prior.post!.userMessageId, payloadSha256: prior.post!.payloadSha256, watchSeq: prior.hostWatch!.seq, observedAt: Date.now() } };
    this.checkpoint();
    const completed = (await this.observed())!;
    return completed;
  }
  dispose(): void {
    this.page?.off("request", this.onRequest);
    this.page?.off("response", this.onResponse);
    this.page = undefined;
    this.requests.clear();
  }
}
