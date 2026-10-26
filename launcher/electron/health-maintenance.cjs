const { randomUUID, createHash } = require("node:crypto");
const STATES = new Set(["ready", "signed_out", "unknown", "runtime_unavailable", "binding_mismatch", "draining"]);
const MAX_ATTEMPTS = 3;
const RETRY_MS = 2_000;
const MAX_STORAGE_FAILURES = 3;
const STORAGE_RECOVERY_MS = 20_000;
const messages = Object.freeze({
  ready: "QA account health recovered. Existing sessions keep their original owner.",
  signed_out: "QA account authentication is unavailable. New account assignments are paused.",
  unknown: "QA account health could not be confirmed. New account assignments are paused.",
  runtime_unavailable: "QA runtime is unavailable. New account assignments are paused.",
  binding_mismatch: "QA health identity changed or does not match. New account assignments are paused.",
  draining: "QA runtime admission is paused by its administrator.",
});
function validDelivery(value) {
  const e = value?.event;
  return !!e && /^[a-f0-9-]{36}$/.test(e.eventId) && /^[a-f0-9]{16}$/.test(e.accountKey)
    && STATES.has(e.state) && Number.isSafeInteger(e.observedAt) && e.observedAt > 0
    && Number.isInteger(value.attempts) && value.attempts >= 0 && value.attempts <= MAX_ATTEMPTS
    && (value.acknowledgedAt === null || Number.isSafeInteger(value.acknowledgedAt) && value.acknowledgedAt >= e.observedAt);
}
class HealthMaintenanceDelivery {
  constructor({ stateStore, publishOperation, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { stateStore, publishOperation, now, schedule, cancel });
    this.storageFailures = 0;
    this.storageRetryAt = 0;
    this.delivering = false;
    this.closed = false;
    const value = stateStore.read().maintenanceDelivery;
    this.current = validDelivery(value) ? value : null;
    if (this.current && this.current.acknowledgedAt === null) this.scheduleRetry();
  }
  report({ accountId, state }) {
    if (this.closed) throw new Error("Health maintenance delivery closed");
    if (typeof accountId !== "string" || !accountId || !STATES.has(state)) throw new Error("Invalid health maintenance state");
    const accountKey = createHash("sha256").update(accountId).digest("hex").slice(0, 16);
    if (this.current?.event.accountKey === accountKey && this.current.event.state === state) {
      // A durable event may exist even though saving its first attempt failed.
      // Existing timers own recovery; repeated reports must not create a hot loop.
      if (!this.timer && !this.delivering && this.now() >= this.storageRetryAt) {
        this.storageFailures = 0;
        this.deliver();
      }
      return this.status();
    }
    const next = { event: { eventId: randomUUID(), accountKey, state, observedAt: this.now() },
      attempts: 0, acknowledgedAt: null };
    this.save(next); // Durable event precedes delivery, including a process restart.
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    this.storageFailures = 0;
    this.storageRetryAt = 0;
    this.deliver();
    return this.status();
  }
  save(value) {
    const history = this.stateStore.read().maintenanceHistory ?? [];
    const replaced = this.current && this.current.event.eventId !== value.event.eventId ? [this.current] : [];
    this.stateStore.update({ maintenanceDelivery: value,
      maintenanceHistory: [...(Array.isArray(history) ? history.filter(validDelivery) : []), ...replaced].slice(-16) });
    this.current = value;
  }
  status() {
    return { eventId: this.current?.event.eventId ?? null, acknowledged: this.current?.acknowledgedAt !== null && !!this.current,
      attempts: this.current?.attempts ?? 0 };
  }
  deliver() {
    if (this.closed || this.delivering || !this.current || this.current.acknowledgedAt !== null
      || this.current.attempts >= MAX_ATTEMPTS) return;
    this.delivering = true;
    try {
      try { this.save({ ...this.current, attempts: this.current.attempts + 1 }); }
      catch (error) {
        this.storageFailures++;
        this.storageRetryAt = this.now() + (this.storageFailures >= MAX_STORAGE_FAILURES ? STORAGE_RECOVERY_MS : RETRY_MS);
        throw error;
      }
      this.storageFailures = 0;
      this.storageRetryAt = 0;
      const event = this.current.event;
      this.publishOperation({ name: "qa-health", status: event.state === "ready" ? "completed" : "failed",
        message: messages[event.state], maintenance: event });
    } finally { this.delivering = false; this.scheduleRetry(); }
  }
  scheduleRetry() {
    if (this.closed || this.timer || !this.current || this.current.acknowledgedAt !== null
      || this.current.attempts >= MAX_ATTEMPTS || this.storageFailures >= MAX_STORAGE_FAILURES) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      try { this.deliver(); } catch { /* Unacknowledged durable state remains visible on snapshot. */ }
    }, Math.max(RETRY_MS, this.storageRetryAt - this.now()));
    this.timer.unref?.();
  }
  acknowledge(eventId) {
    if (this.closed) return false;
    if (!this.current || this.current.event.eventId !== eventId || this.current.attempts === 0) return false;
    if (this.current.acknowledgedAt === null) this.save({ ...this.current, acknowledgedAt: this.now() });
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    return true;
  }
  close() { this.closed = true; if (this.timer) this.cancel(this.timer); this.timer = null; }
}
module.exports = { HealthMaintenanceDelivery, validDelivery, MAX_ATTEMPTS, RETRY_MS, MAX_STORAGE_FAILURES, STORAGE_RECOVERY_MS };
