const { createHash, randomUUID } = require("node:crypto");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_IDENTITIES = 128;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validStage = stage => stage && (stage.kind === "final" && Object.keys(stage).length === 1
  || stage.kind === "part" && Object.keys(stage).length === 3 && Number.isSafeInteger(stage.index)
    && Number.isSafeInteger(stage.total) && stage.index >= 1 && stage.index <= stage.total
    && stage.total < MAX_IDENTITIES);
const sameHost = (a, b) => a && b && ["pid", "instanceId", "profile", "partition"].every(k => a[k] === b[k]);
const sameLease = (a, b) => a && b && ["helperPid", "surfaceId", "targetId"].every(k => a[k] === b[k]);
const sameBinding = (a, b) => a && b && a.roundKey === b.roundKey && validStage(a.stage) && validStage(b.stage)
  && a.stage.kind === b.stage.kind && a.stage.index === b.stage.index && a.stage.total === b.stage.total
  && sameHost(a.host, b.host) && sameLease(a.lease, b.lease) && a.documentEpoch === b.documentEpoch;
function validSlot(slot) {
  return slot && typeof slot.roundKey === "string" && slot.roundKey.length > 0 && slot.roundKey.length <= 4096
    && validStage(slot.stage);
}
const SCOPE_KEYS = ["operationId", "executionKey", "roundKey", "threadId", "turnId", "traceId"];
const validScope = s => s && Object.keys(s).length === SCOPE_KEYS.length - (Object.hasOwn(s, "threadId") ? 0 : 1)
  && SCOPE_KEYS.every(k => k === "threadId" && !Object.hasOwn(s, k)
    || Object.hasOwn(s, k) && typeof s[k] === "string" && s[k].length > 0 && s[k].length <= 4096);
const sameScope = (a, b) => a && b && validScope(a) && validScope(b)
  && Object.hasOwn(a, "threadId") === Object.hasOwn(b, "threadId") && SCOPE_KEYS.every(k => a[k] === b[k]);
const exactKeys = (v, keys) => v && !Array.isArray(v) && Object.keys(v).length === keys.length
  && keys.every(k => Object.hasOwn(v, k));
const validTime = v => Number.isSafeInteger(v) && v > 0;
function unresolved() { throw new Error("native_submission_unresolved"); }
function observedField(body, key) {
  if (!Object.hasOwn(body, key)) return { presence: "absent" };
  if (body[key] === null) return { presence: "null" };
  if (typeof body[key] !== "string" || !body[key] || body[key].length > 4096) throw new Error("schema_unknown");
  return { presence: "value", value: body[key] };
}
function conversationId(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password
      || url.searchParams.get("temporary-chat") === "true") return undefined;
    return url.pathname.match(/^(?:\/g\/g-p-[a-f0-9]{32}(?:-[^/]+)?)?\/c\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/?$/)?.[1];
  } catch { return undefined; }
}
function chatUrl(value) {
  try { const u = new URL(value); return u.origin === "https://chatgpt.com" && !u.username && !u.password; }
  catch { return false; }
}
function endpoint(value) {
  try {
    const u = new URL(value);
    return chatUrl(value) && ["/backend-api/conversation", "/backend-api/f/conversation"].includes(u.pathname)
      ? u.pathname : undefined;
  } catch { return undefined; }
}
function parsePost(raw) {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error("body_unavailable");
  const b = JSON.parse(raw);
  if (!b || typeof b !== "object" || Array.isArray(b) || !Array.isArray(b.messages) || b.messages.length !== 1
    || b.messages[0]?.author?.role !== "user" || !UUID.test(b.messages[0]?.id)) throw new Error("schema_unknown");
  const action = observedField(b, "action");
  if (action.presence === "value" && action.value !== "next") throw new Error("schema_unknown");
  return {
    userMessageId: b.messages[0].id, action,
    parentMessageId: observedField(b, "parent_message_id"),
    conversationId: observedField(b, "conversation_id"),
    payloadSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

/**
 * One original Host webContents, continuous CDP session, and ordered physical Send segments.
 * No request interception, no response
 * consumption, no navigation and no IPC writer transfer. Raw bodies live only while parsing.
 * A detached debugger is NEVER reattached: a new connection cannot prove the missing interval.
 */
class NativeSubmissionObserver {
  constructor(contents, binding, { flushTimeoutMs = 2000, slot, scope } = {}) {
    this.contents = contents;
    this.debugger = contents.debugger;
    this.binding = structuredClone(binding);
    this.scope = scope ? structuredClone(scope) : null;
    this.sessionEpoch = randomUUID();
    this.seq = 0;
    this.active = false;
    this.ownsDebugger = false;
    this.startedAt = Date.now();
    this.documentEpoch = null;
    this.mainFrame = null;
    this.postCount = 0;
    this.identities = [];
    this.postSegments = new Map();
    this.segments = new Map();
    this.latePosts = [];
    this.segment = { sendId: binding.sendId, slot: slot ? { roundKey: slot.roundKey, stage: structuredClone(slot.stage) } : null,
      binding: null, state: "watching", postCount: 0, identities: [],
      initialConversationId: conversationId(contents.getURL()) ?? null };
    this.segments.set(binding.sendId, this.segment);
    this.gaps = new Set();
    this.conflicts = new Set();
    this.pending = new Set();
    this.finishWarnings = [];
    this.flushTimeoutMs = flushTimeoutMs;
    this.initialConversationId = conversationId(contents.getURL());
    this.boundConversationId = this.initialConversationId;
    this.onMessage = (_event, method, params, sessionId) => {
      // Child/worker sessions can reuse frame/request IDs. This watch never enables auto-attach.
      if (sessionId || !this.ownsDebugger) return;
      try { this.message(method, params || {}); } catch { this.gap("event_unreadable"); }
    };
    this.onDetach = () => {
      if (this.finishCertificate) return;
      if (this.finishingDetach) { this.finishingDetach.observed = true; return; }
      this.ownsDebugger = false; this.active = false; this.gap("debugger_detached");
    };
    this.onDestroyed = () => { if (!this.finishCertificate) { this.active = false; this.gap("contents_destroyed"); } };
    this.onGone = () => { if (!this.finishCertificate) { this.active = false; this.gap("renderer_gone"); } };
    this.onNavigation = (_event, _url, inPlace, mainFrame) => {
      if (!this.finishCertificate && mainFrame && !inPlace) this.gap("document_changed");
    };
  }
  gap(reason) { if (!this.gaps.has(reason)) { this.gaps.add(reason); this.seq++; } }
  conflict(reason) { if (!this.conflicts.has(reason)) { this.conflicts.add(reason); this.seq++; } }
  track(promise) {
    // Own both the original and cleanup promises; no detached rejected chains.
    const task = Promise.resolve(promise).catch(() => { this.gap("command_failed"); });
    this.pending.add(task);
    void task.then(() => { this.pending.delete(task); });
    return task;
  }
  async command(method, params = {}) {
    if (!this.ownsDebugger || !this.debugger.isAttached()) throw new Error("debugger_unavailable");
    return this.debugger.sendCommand(method, params);
  }
  frame(frame, initial = false) {
    if (!frame || typeof frame.id !== "string" || !frame.id || typeof frame.loaderId !== "string"
      || !frame.loaderId || !chatUrl(frame.url)) { this.gap("document_unavailable"); return; }
    const epoch = JSON.stringify([frame.id, frame.loaderId]);
    if (initial && !this.mainFrame) {
      this.mainFrame = { frameId: frame.id, loaderId: frame.loaderId };
      this.documentEpoch = epoch;
      if (this.segment.slot) this.segment.binding = {
        ...this.segment.slot, host: structuredClone(this.binding.host), lease: structuredClone(this.binding.lease),
        documentEpoch: epoch,
      };
      this.seq++;
    } else if (epoch !== this.documentEpoch) this.gap("document_changed");
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!this.debugger || this.debugger.isAttached()) {
        this.gap("debugger_unavailable"); return;
      }
      this.debugger.on("message", this.onMessage);
      this.debugger.on("detach", this.onDetach);
      this.contents.on("destroyed", this.onDestroyed);
      this.contents.on("render-process-gone", this.onGone);
      this.contents.on("did-start-navigation", this.onNavigation);
      try {
        this.debugger.attach("1.3");
        this.ownsDebugger = true;
        // Listeners precede enable. Requests before the frame fence is established poison start.
        await this.command("Network.enable", { maxPostDataSize: MAX_BODY_BYTES });
        await this.command("Page.enable");
        const tree = await this.command("Page.getFrameTree");
        this.frame(tree?.frameTree?.frame, true);
        this.checkContents();
        this.active = this.ownsDebugger && !!this.documentEpoch && this.gaps.size === 0;
        this.seq++;
      } catch { this.gap("observer_start_failed"); }
    })();
    await this.track(this.starting);
    return this.starting;
  }
  checkContents() {
    if (this.contents.isDestroyed()) { this.onDestroyed(); return; }
    if (this.contents.getOrCreateDevToolsTargetId() !== this.binding.lease.targetId) this.gap("target_changed");
    const url = this.contents.getURL();
    if (!chatUrl(url)) { this.gap("document_changed"); return; }
    const id = conversationId(url);
    if (this.boundConversationId && id !== this.boundConversationId) this.gap("conversation_changed");
    if (!this.boundConversationId && id) { this.boundConversationId = id; this.seq++; }
    for (const post of this.identities) this.checkConversation(post, this.postSegments.get(post.watchOrdinal));
  }
  checkConversation(post, segment = this.segment) {
    const cid = post.conversationId;
    if (segment.initialConversationId
      ? cid.presence !== "value" || cid.value !== segment.initialConversationId
      : cid.presence === "value" && (!this.boundConversationId || cid.value !== this.boundConversationId)) {
      this.conflict("conversation_mismatch");
    }
  }
  message(method, p) {
    if (method === "Inspector.detached" || method === "Inspector.targetCrashed") {
      this.active = false; this.ownsDebugger = false; this.gap("inspector_lost"); return;
    }
    if (method === "Page.frameNavigated" && !p.frame?.parentId) {
      // Page.enable may report the existing frame; start's getFrameTree establishes the baseline.
      if (this.mainFrame) this.frame(p.frame);
      return;
    }
    if (method === "Page.frameDetached" && p.frameId === this.mainFrame?.frameId) {
      this.gap("main_frame_detached"); return;
    }
    if (method !== "Network.requestWillBeSent" || p.request?.method !== "POST") return;
    const path = endpoint(p.request.url);
    if (!path) return;
    if (!this.mainFrame) { this.gap("request_before_document_fence"); return; }
    if (typeof p.frameId !== "string" || !p.frameId) { this.gap("request_frame_missing"); return; }
    if (p.frameId !== this.mainFrame.frameId) return;
    this.postCount++;
    const segment = this.segment;
    const ordinal = ++segment.postCount;
    this.seq++;
    if (segment.state !== "watching") this.conflict("post_after_completion");
    if (this.cancellation?.terminal) this.conflict("post_after_cancel_terminal");
    if (ordinal > 1) this.conflict("multiple_posts"); // Including identical IDs and browser retries.
    if (p.loaderId !== this.mainFrame.loaderId) { this.gap("request_document_mismatch"); return; }
    if (typeof p.requestId !== "string" || !p.requestId) { this.gap("request_id_missing"); return; }
    if (p.redirectResponse) this.gap("redirected_post");
    if (this.postCount > MAX_IDENTITIES) { this.gap("identity_capacity_exceeded"); return; }
    if (this.identities.some(post => post.requestId === p.requestId)) this.conflict("request_id_reused");
    const metadata = { ordinal, watchOrdinal: this.postCount, endpoint: path, requestId: p.requestId, frameId: p.frameId,
      loaderId: p.loaderId, observedAt: Date.now() };
    // Never capture the event, headers, request or full response in a retained closure.
    const raw = typeof p.request.postData === "string" ? p.request.postData : undefined;
    this.track(this.capture(metadata, raw, segment));
  }
  async capture(metadata, raw, segment) {
    try {
      if (raw === undefined) {
        const response = await this.command("Network.getRequestPostData", { requestId: metadata.requestId });
        raw = response?.postData;
      }
      const post = { ...metadata, ...parsePost(raw) };
      const prior = this.identities.find(p => this.postSegments.get(p.watchOrdinal) !== segment
        && (p.userMessageId === post.userMessageId || p.payloadSha256 === post.payloadSha256 || p.requestId === post.requestId));
      if (prior) {
        // A late old POST is never the first identity of a new intent. Keep the old proof and
        // record this event separately, while poisoning the entire continuous watcher.
        this.conflict("late_previous_segment_post");
        this.latePosts.push({ observedDuringSendId: segment.sendId,
          originalSendId: this.postSegments.get(prior.watchOrdinal).sendId, identity: post });
      } else {
        segment.identities.push(post);
        segment.identities.sort((a, b) => a.ordinal - b.ordinal);
      }
      this.identities.push(post);
      this.identities.sort((a, b) => a.watchOrdinal - b.watchOrdinal);
      this.postSegments.set(post.watchOrdinal, segment);
      this.checkConversation(post, segment);
      this.seq++;
    } catch {
      // Unknown schema and missing body are sticky gaps, never evidence of zero POSTs.
      this.gap("post_identity_unavailable");
    }
  }
  segmentSnapshot(segment) {
    const { slot: _slot, transition: _transition, ...metadata } = segment;
    return structuredClone(metadata);
  }
  snapshot(stable = this.pending.size === 0, sendId = this.segment.sendId) {
    const segment = this.segments.get(sendId);
    if (!segment) unresolved();
    return structuredClone({
      version: 1, ...this.binding, scope: this.scope,
      ...(this.resultReady ? { resultReady: this.resultReady } : {}),
      ...(this.cancellation ? { cancellation: this.cancellation } : {}),
      sendId, currentSendId: this.segment.sendId, binding: segment.binding,
      segmentState: segment.state, totalPostCount: this.postCount,
      segments: [...this.segments.values()].filter(s => s !== this.segment).map(s => this.segmentSnapshot(s)),
      latePosts: this.latePosts, sessionEpoch: this.sessionEpoch, documentEpoch: this.documentEpoch,
      mainFrame: this.mainFrame, seq: this.seq, active: this.active,
      gap: this.gaps.size > 0, gapReasons: [...this.gaps],
      conflict: this.conflicts.size > 0, conflictReasons: [...this.conflicts],
      postCount: segment.postCount, identities: segment.identities,
      startedAt: this.startedAt, readAt: Date.now(), stoppedAt: this.stoppedAt,
      initialConversationId: segment.initialConversationId,
      boundConversationId: this.boundConversationId ?? null,
      flush: { stable, pending: this.pending.size, throughSeq: this.seq },
    });
  }
  async read() {
    // A read is a watermark, not a promise that no future browser POST can occur. The Host
    // continues collecting after this returns and every consumer must revalidate before use.
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), this.flushTimeoutMs); });
    try {
      if (this.ownsDebugger && !this.stoppedAt) {
        this.track((async () => {
          const tree = await this.command("Page.getFrameTree");
          this.frame(tree?.frameTree?.frame);
        })());
      }
      while (this.pending.size) {
        const drained = await Promise.race([Promise.all([...this.pending]).then(() => true), deadline]);
        if (!drained) { this.gap("flush_timeout"); return this.snapshot(false); }
      }
      this.checkContents();
      if (!this.stoppedAt && (!this.ownsDebugger || !this.debugger.isAttached())) {
        this.active = false; this.gap("debugger_detached");
      }
      return this.snapshot(true);
    } finally { clearTimeout(timer); }
  }
  healthy() {
    this.checkContents();
    if (!this.active || !this.ownsDebugger || !this.debugger.isAttached() || this.pending.size
      || this.gaps.size || this.conflicts.size || !this.segment.binding) unresolved();
  }
  verifyReceipt(receipt, kind) {
    this.healthy();
    const segment = this.segment, r = receipt?.record, ack = receipt?.acknowledgement;
    const live = this.snapshot(), saved = r?.hostWatch;
    if (!r || !ack || r.version !== 1 || r.sendId !== segment.sendId || !UUID.test(r.sendId)
      || !Number.isSafeInteger(r.revision) || r.revision < 5
      || ack.sendId !== r.sendId || ack.revision !== r.revision || Object.keys(ack).length !== 3 || !SHA256.test(ack.digest)
      || ack.digest !== digest(r) || r.conflict !== undefined
      || !sameBinding(r.binding, segment.binding) || !saved || !sameBinding(saved.binding, r.binding)
      || segment.postCount !== 1 || segment.identities.length !== 1
      || saved.version !== 1 || saved.traceId !== this.binding.traceId || saved.sendId !== r.sendId
      || saved.currentSendId !== r.sendId || saved.sessionEpoch !== this.sessionEpoch
      || saved.documentEpoch !== this.documentEpoch || saved.seq !== this.seq
      || !sameScope(saved.scope, this.scope)
      || !sameHost(saved.host, live.host) || !sameLease(saved.lease, live.lease)
      || saved.active !== true || saved.gap !== false || saved.conflict !== false
      || saved.postCount !== 1 || saved.totalPostCount !== this.postCount
      || saved.flush?.stable !== true || saved.flush.pending !== 0 || saved.flush.throughSeq !== this.seq
      || !same(saved.identities, segment.identities)
      || !same(saved.segments, live.segments) || !same(saved.latePosts, live.latePosts)
      || (r.expectedConversationId !== undefined && r.expectedConversationId !== segment.initialConversationId)) unresolved();
    const post = segment.identities[0];
    if (!r.post || ["userMessageId", "payloadSha256", "parentMessageId", "conversationId", "action"]
      .some(key => !same(r.post[key], post[key]))) unresolved();
    const dom = r.dom, user = "group:user:" + post.userMessageId, assistant = "group:assistant:" + post.userMessageId;
    const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === "string" && id.length > 0)
      && new Set(ids).size === ids.length;
    if (!dom || dom.acceptedUserIdentity !== user || dom.assistantIdentity !== assistant
      || !["same-bound-assistant-progress", "same-bound-assistant-completed"].includes(dom.proof)
      || !Number.isSafeInteger(r.post.observedAt) || r.post.observedAt <= 0
      || !Number.isSafeInteger(dom.observedAt) || dom.observedAt < r.post.observedAt
      || !validIds(r.initialTurnIdentities) || !validIds(dom.acceptedTurnIdentities)
      || r.initialTurnIdentities.includes(user) || r.initialTurnIdentities.includes(assistant)
      || !dom.acceptedTurnIdentities.includes(user) || !dom.acceptedTurnIdentities.includes(assistant)
      || dom.acceptedTurnIdentities.some(id => !r.initialTurnIdentities.includes(id) && id !== user && id !== assistant)) unresolved();
    if (kind === "stage") {
      const proof = r.stageAcknowledgement;
      if (r.phase !== "stage_acknowledged" || r.binding.stage.kind !== "part" || r.completion !== undefined
        || !proof || !SHA256.test(proof.expectedSha256) || proof.expectedSha256 !== proof.actualSha256
        || proof.assistantIdentity !== assistant || Object.keys(proof).length !== 3) unresolved();
    } else {
      const proof = r.completion;
      if (r.phase !== "completed" || r.binding.stage.kind !== "final" || r.stageAcknowledgement !== undefined
        || !proof || Object.keys(proof).length !== 6 || proof.proof !== "same-bound-assistant-completed" || proof.assistantIdentity !== assistant
        || proof.userMessageId !== post.userMessageId || proof.payloadSha256 !== post.payloadSha256
        || proof.watchSeq !== this.seq || !Number.isSafeInteger(proof.observedAt)
        || proof.observedAt < dom.observedAt) unresolved();
    }
    return { acknowledgement: structuredClone(ack), watchSeq: this.seq,
      ...(kind === "stage" ? { stageAcknowledgement: structuredClone(r.stageAcknowledgement) }
        : { completion: structuredClone(r.completion) }) };
  }
  rotate(sendId, receipt, next) {
    if (this.cancellation || this.resultReady) unresolved();
    this.healthy();
    const previous = this.segments.get(sendId);
    if (!previous || !next || !UUID.test(next.sendId) || !validSlot(next.binding)) unresolved();
    if (previous !== this.segment) {
      // Lost HTTP response: acknowledge only the exact already-committed transition. No second
      // segment is created and this does not authorize a second physical Send.
      if (previous.transition?.nextSendId !== next.sendId || this.segment.sendId !== next.sendId
        || !sameBinding(previous.transition.binding, next.binding)
        || previous.durableReceipt?.acknowledgement.digest !== receipt?.acknowledgement?.digest
        || !same(previous.durableReceipt.acknowledgement, receipt.acknowledgement)
        || digest(receipt.record) !== receipt.acknowledgement.digest) unresolved();
      return;
    }
    if (previous.state !== "watching" || this.segments.has(next.sendId)) unresolved();
    const proof = this.verifyReceipt(receipt, "stage"), old = previous.binding;
    const stage = old.stage;
    const expected = stage.index < stage.total
      ? { kind: "part", index: stage.index + 1, total: stage.total } : { kind: "final" };
    if (!sameBinding(next.binding, { ...old, stage: expected })) unresolved();
    previous.state = "stage-completed";
    previous.durableReceipt = proof;
    const nextBinding = structuredClone({ ...old, stage: expected });
    previous.transition = { nextSendId: next.sendId, binding: nextBinding };
    this.segment = { sendId: next.sendId, slot: { roundKey: old.roundKey, stage: structuredClone(expected) },
      binding: nextBinding, state: "watching", postCount: 0, identities: [],
      initialConversationId: conversationId(this.contents.getURL()) ?? null };
    this.segments.set(next.sendId, this.segment);
    this.binding.sendId = next.sendId;
    this.seq++;
    // No listener/domain/session changes here. Late old POSTs remain visible across this boundary.
  }
  complete(receipt, resultReady) {
    const proof = this.verifyReceipt(receipt, "completion");
    if (this.segment.state === "completed"
      && !same(this.segment.durableReceipt, proof)) unresolved();
    if (this.segment.state !== "watching" && this.segment.state !== "completed") unresolved();
    if (!exactKeys(resultReady, ["version", "scope", "sendId", "completedDigest", "answerSha256", "readyAt", "digest"])
      || resultReady.version !== 1 || !sameScope(resultReady.scope, this.scope)
      || resultReady.sendId !== this.segment.sendId || resultReady.completedDigest !== proof.acknowledgement.digest
      || !SHA256.test(resultReady.answerSha256) || !SHA256.test(resultReady.digest)
      || !validTime(resultReady.readyAt) || resultReady.readyAt < proof.completion.observedAt
      || (this.resultReady && !same(this.resultReady, resultReady)) || this.cancellation?.terminal?.proof === "same-bound-generation-stopped") unresolved();
    this.resultReady = structuredClone(resultReady);
    this.segment.state = "completed";
    this.segment.durableReceipt = proof;
    // No network seq change: an accepted immutable checkpoint remains valid for this same slot.
  }
  hasCompletion() {
    const segment = this.segment;
    const proof = segment.durableReceipt?.completion;
    return segment.state === "completed" && segment.binding?.stage.kind === "final"
      && proof && proof.watchSeq <= this.seq && segment.identities.length === 1
      && proof.userMessageId === segment.identities[0].userMessageId
      && proof.payloadSha256 === segment.identities[0].payloadSha256;
  }
  requestCancellation(intent, acknowledgement, dispatchAttempted) {
    this.healthy();
    if (typeof dispatchAttempted !== "boolean" || !exactKeys(intent, ["version", "cancelId", "source", "threadId", "turnId", "requestedAt", "scope", "sendId", "binding"])
      || intent.version !== 1 || intent.source !== "native_interrupt" || !UUID.test(intent.cancelId)
      || !validTime(intent.requestedAt) || !sameScope(intent.scope, this.scope)
      || typeof intent.threadId !== "string" || !intent.threadId || !Object.hasOwn(this.scope, "threadId")
      || intent.threadId !== this.scope.threadId || intent.turnId !== this.scope.turnId
      || intent.sendId !== this.segment.sendId || !sameBinding(intent.binding, this.segment.binding)
      || !exactKeys(acknowledgement, ["digest"]) || !SHA256.test(acknowledgement.digest)
      || acknowledgement.digest !== digest(intent)) unresolved();
    if (this.cancellation) {
      if (this.cancellation.cancelId !== intent.cancelId || this.cancellation.intentDigest !== acknowledgement.digest
        || this.cancellation.dispatchAttempted !== dispatchAttempted) unresolved();
      return; // The same intent is a query/ACK retry, never a second Stop authorization.
    }
    this.cancellation = { cancelId: intent.cancelId, intentDigest: acknowledgement.digest, requestedAt: intent.requestedAt, dispatchAttempted };
  }
  cancelTerminal(terminal, acknowledgement, notDispatchedReceipt) {
    this.healthy();
    const c = this.cancellation, post = this.segment.identities[0];
    const notDispatched = terminal?.proof === "not_dispatched";
    if (!c || !exactKeys(terminal, ["cancelId", "sendId", "sessionEpoch", "watchSeq", "proof", "observedAt", "dispatchAttempted",
        ...(notDispatched ? [] : ["assistantIdentity"])])
      || terminal.dispatchAttempted !== !notDispatched || terminal.dispatchAttempted !== c.dispatchAttempted
      || terminal.cancelId !== c.cancelId || terminal.sendId !== this.segment.sendId
      || terminal.sessionEpoch !== this.sessionEpoch || terminal.watchSeq !== this.seq
      || !validTime(terminal.observedAt) || terminal.observedAt < c.requestedAt
      || (!notDispatched && (this.segment.postCount !== 1 || this.segment.identities.length !== 1
        || terminal.observedAt < post.observedAt || terminal.assistantIdentity !== "group:assistant:" + post.userMessageId))
      || !exactKeys(acknowledgement, ["digest"]) || !SHA256.test(acknowledgement.digest)
      || acknowledgement.digest !== digest(terminal)) unresolved();
    if (notDispatched) {
      // The original dispatcher is responsible for never-attempted-click before producing this
      // parent-durable terminal. Zero Host POSTs alone are deliberately insufficient.
      const r = notDispatchedReceipt?.record, ack = notDispatchedReceipt?.acknowledgement, saved = r?.hostWatch;
      const live = this.snapshot();
      if (this.hasCompletion() || this.resultReady || this.segment.postCount !== 0 || this.segment.identities.length !== 0
        || !r || r.version !== 1 || r.sendId !== this.segment.sendId || r.phase !== "watch_ready" || r.revision !== 2
        || r.post !== undefined || r.dom !== undefined || r.conflict !== undefined || r.completion !== undefined
        || r.stageAcknowledgement !== undefined || !Array.isArray(r.initialTurnIdentities)
        || !sameBinding(r.binding, this.segment.binding) || !exactKeys(ack, ["sendId", "revision", "digest"])
        || ack.sendId !== r.sendId || ack.revision !== r.revision || ack.digest !== digest(r)
        || !saved || saved.version !== 1 || saved.sendId !== r.sendId || saved.currentSendId !== r.sendId
        || saved.traceId !== this.binding.traceId || saved.sessionEpoch !== this.sessionEpoch
        || saved.documentEpoch !== this.documentEpoch || !sameBinding(saved.binding, r.binding)
        || !sameScope(saved.scope, this.scope) || !sameHost(saved.host, live.host) || !sameLease(saved.lease, live.lease)
        || !Number.isSafeInteger(saved.seq) || saved.seq < 0 || saved.seq > this.seq
        || saved.postCount !== 0 || saved.identities?.length !== 0 || saved.totalPostCount !== this.postCount
        || saved.active !== true || saved.gap !== false || saved.conflict !== false
        || saved.flush?.stable !== true || saved.flush.pending !== 0 || saved.flush.throughSeq !== saved.seq
        || !same(saved.segments, live.segments) || !same(saved.latePosts, live.latePosts)
        || (c.notDispatchedDigest && c.notDispatchedDigest !== ack.digest)) unresolved();
      c.notDispatchedDigest = ack.digest;
    } else if (notDispatchedReceipt !== undefined) unresolved();
    else if (terminal.proof === "same-bound-generation-completed") {
      // A completion race must use the original completed record and result-ready, not convert success to cancellation.
      if (!this.hasCompletion() || !this.resultReady) unresolved();
    } else if (terminal.proof !== "same-bound-generation-stopped" || this.hasCompletion() || this.resultReady) unresolved();
    if (c.terminal && (!same(c.terminal, terminal) || c.terminalDigest !== acknowledgement.digest)) unresolved();
    c.terminal = structuredClone(terminal);
    c.terminalDigest = acknowledgement.digest;
  }
  hasCancellation() {
    const c = this.cancellation, p = this.segment.identities[0];
    if (c?.terminal?.proof === "not_dispatched") return SHA256.test(c.terminalDigest) && SHA256.test(c.notDispatchedDigest)
      && c.terminal.sendId === this.segment.sendId && c.terminal.watchSeq <= this.seq
      && this.segment.postCount === 0 && this.segment.identities.length === 0;
    return c?.terminal?.proof === "same-bound-generation-stopped" && SHA256.test(c.terminalDigest)
      && c.terminal.sendId === this.segment.sendId && c.terminal.watchSeq <= this.seq
      && this.segment.identities.length === 1 && c.terminal.assistantIdentity === "group:assistant:" + p.userMessageId;
  }
  releaseWitness(outcome) {
    if (outcome === "completed" && this.hasCompletion() && this.resultReady) return this.segment.durableReceipt.acknowledgement.digest;
    if (outcome === "cancelled" && this.hasCancellation() && !this.hasCompletion()) return this.cancellation.terminalDigest;
    unresolved();
  }
  finishConfirmed(outcome, terminalDigest) {
    const c = this.finishCertificate;
    return !!c && c.outcome === outcome && c.terminalDigest === terminalDigest
      && c.sendId === this.segment.sendId && c.sessionEpoch === this.sessionEpoch
      && c.documentEpoch === this.documentEpoch && !this.active && !this.ownsDebugger;
  }
  finishWarning(step, error) {
    const errorType = typeof error?.name === "string" ? error.name : "Error";
    if (!this.finishWarnings.some(w => w.step === step && w.errorType === errorType)) this.finishWarnings.push({ step, errorType });
  }
  cleanupFinishedListeners() {
    if (!this.finishCertificate) unresolved();
    this.finishListenerCleanup ??= new Map([
      ["message", () => this.debugger.removeListener("message", this.onMessage)],
      ["detach", () => this.debugger.removeListener("detach", this.onDetach)],
      ["destroyed", () => this.contents.removeListener("destroyed", this.onDestroyed)],
      ["renderer", () => this.contents.removeListener("render-process-gone", this.onGone)],
      ["navigation", () => this.contents.removeListener("did-start-navigation", this.onNavigation)],
    ]);
    for (const [name, remove] of this.finishListenerCleanup) {
      try { remove(); this.finishListenerCleanup.delete(name); }
      catch (error) { this.finishWarning("listener_" + name, error); }
    }
    if (this.finishListenerCleanup.size) throw new Error("native_release_listener_cleanup_pending");
  }
  // A terminal proof and a confirmed owned detach precede this certificate. active=false alone
  // is never release evidence. Host commits its lease and receipt before optional listener/UI cleanup.
  finish(outcome = "completed") {
    const terminalDigest = this.releaseWitness(outcome);
    if (this.finishConfirmed(outcome, terminalDigest)) return this.finishCertificate;
    this.healthy();
    const notDispatched = outcome === "cancelled" && this.cancellation?.terminal?.proof === "not_dispatched";
    if ((!notDispatched && (this.segment.postCount !== 1 || this.segment.identities.length !== 1))
      || (outcome === "completed" && this.segment.binding?.stage.kind !== "final")
      || [...this.segments.values()].some(s => s !== this.segment && (s.state !== "stage-completed" || !s.durableReceipt))) unresolved();
    const throughSeq = this.seq;
    const attempt = { observed: false };
    this.finishingDetach = attempt;
    try { this.debugger.detach(); }
    catch (error) { this.finishWarning("detach", error); }
    finally { this.finishingDetach = undefined; }
    let attached;
    try { attached = this.debugger.isAttached(); }
    catch (error) {
      this.finishWarning("detach_probe", error);
      this.gap("finish_detach_unverified");
      this.ownsDebugger = false; this.active = false;
      unresolved();
    }
    if (typeof attached !== "boolean") {
      this.gap("finish_detach_unverified"); this.ownsDebugger = false; this.active = false; unresolved();
    }
    if (attached) {
      this.finishWarning("detach_still_attached", new Error("original_debugger_still_attached"));
      // No detach event and the original session is still attached: keep its collector and
      // require a fresh flush on retry. A detach event followed by attached may be someone else's session.
      if (attempt.observed) {
        this.ownsDebugger = false; this.active = false; this.gap("finish_session_replaced");
      }
      unresolved();
    }
    this.ownsDebugger = false;
    this.active = false;
    try { this.checkContents(); }
    catch (error) { this.finishWarning("post_detach_fence", error); this.gap("finish_fence_unverified"); }
    if (this.seq !== throughSeq || this.pending.size || this.gaps.size || this.conflicts.size
      || this.releaseWitness(outcome) !== terminalDigest) {
      this.gap("finish_evidence_changed");
      unresolved();
    }
    this.stoppedAt = Date.now();
    this.seq++;
    this.finishCertificate = Object.freeze({ outcome, terminalDigest, sendId: this.segment.sendId,
      sessionEpoch: this.sessionEpoch, documentEpoch: this.documentEpoch, throughSeq });
    return this.finishCertificate;
  }
}

module.exports = { NativeSubmissionObserver, validSlot, sameBinding, validScope, sameScope, sameHost, sameLease };
