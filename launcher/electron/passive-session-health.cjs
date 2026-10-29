const { readChatGptAuthSession } = require("./chatgpt-auth-session.cjs");
const HEALTH_FRESHNESS_MS = 60_000;
const HEALTH_REFRESH_MS = 20_000;
const { digestUserId, HOST_VERSION, HOST_CLOSURE_DIGEST } = require("./health-identity.cjs");

// Authentication metadata only. Never inspects the DOM or owns a turn.
class PassiveSessionHealth {
  constructor({ identity, session, available, timeoutMs, pin = () => null, now = Date.now }) {
    Object.assign(this, { identity, session, available, timeoutMs, pin, now });
    this.revision = 0;
    this.cookieRevision = 0;
    this.lastAttemptAt = -Infinity;
    this.proof = null;
    this.pending = null;
  }
  invalidate() {
    this.cookieRevision++;
    this.proof = null;
    if (!this.pending) this.lastAttemptAt = -Infinity;
  }
  async read() {
    const identity = this.identity();
    const pin = this.pin();
    const key = JSON.stringify([identity, pin]);
    if (this.key !== key) { this.invalidate(); this.key = key; this.lastAttemptAt = -Infinity; }
    if (!this.available()) return this.unknown(identity);
    if (this.pending) { await this.pending; return this.current(identity); }
    if (this.now() - this.lastAttemptAt < HEALTH_REFRESH_MS) return this.current(identity);
    let cookieRevision = this.cookieRevision;
    this.lastAttemptAt = this.now();
    const observedAt = this.lastAttemptAt; // Never mint a newer timestamp by reading cached evidence.
    // Publish the tracked read before invoking Electron: even a synchronous cookie
    // event from session.fetch must see this as a passive operation.
    this.pending = Promise.resolve().then(async () => {
      let result;
      try {
        const session = this.session();
        result = await readChatGptAuthSession(session.fetch.bind(session), "https://chatgpt.com", this.timeoutMs, digestUserId);
        if (result.sessionAuthenticated && result.sessionPrincipalDigest === pin
          && Number.isSafeInteger(session.healthCookieRevision)) cookieRevision = session.healthCookieRevision;
      } catch { result = { sessionCheckError: "unknown" }; }
      if (cookieRevision !== this.cookieRevision || key !== JSON.stringify([this.identity(), this.pin()]) || !this.available()) return;
      this.proof = {
        version: 1, ...identity, revision: ++this.revision, cookieRevision,
        observedAt, expiresAt: observedAt + HEALTH_FRESHNESS_MS,
        principalDigest: result.sessionPrincipalDigest ?? null,
        state: result.sessionCheckError ? "unknown" : !result.sessionAuthenticated ? "signed_out"
          : pin && result.sessionPrincipalDigest === pin ? "ready" : "unknown",
      };
    }).finally(() => { this.pending = null; });
    await this.pending;
    return this.current(identity);
  }
  unknown(identity) {
    return { version: 1, ...identity, revision: this.revision, cookieRevision: this.cookieRevision,
      principalDigest: null, observedAt: this.proof?.observedAt ?? null, expiresAt: this.proof?.expiresAt ?? null, state: "unknown" };
  }
  current(identity) {
    if (!this.available() || this.key !== JSON.stringify([this.identity(), this.pin()]) || !this.proof
      || this.proof.cookieRevision !== this.cookieRevision || this.now() >= this.proof.expiresAt) return this.unknown(identity);
    return structuredClone(this.proof);
  }
}
function hostHealthIdentity(host) {
  return { instanceId: host.observationInstanceId, pid: process.pid, profile: host.profile,
    partition: host.partition, version: HOST_VERSION, closureDigest: HOST_CLOSURE_DIGEST };
}
function sameHealthHost(a, b) {
  return !!a && !!b && ["instanceId", "pid", "profile", "partition", "version", "closureDigest"].every(k => a[k] === b[k]);
}
module.exports = { PassiveSessionHealth, hostHealthIdentity, sameHealthHost, HOST_VERSION, HOST_CLOSURE_DIGEST, HEALTH_FRESHNESS_MS, HEALTH_REFRESH_MS };
