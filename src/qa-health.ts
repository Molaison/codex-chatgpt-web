import { installedRuntimeBundleId } from "./qa-health-build";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readLauncherBrowserHostDescriptor, type LauncherBrowserHostDescriptor } from "./launcher-browser-host";
import { isAbsolute } from "node:path";
import { VERSION } from "./version";
const LOADED_RUNTIME_BUNDLE_ID = installedRuntimeBundleId(import.meta.path);

export const QA_HEALTH_FRESHNESS_MS = 60_000;
export const QA_HEALTH_REFRESH_MS = 20_000;
export type QaHealthState = "ready" | "signed_out" | "unknown";
export type MaintenanceHealthState = QaHealthState | "runtime_unavailable" | "binding_mismatch" | "draining";
export interface HealthHostIdentity {
  instanceId: string; pid: number; profile: "production" | "development"; partition: string; version: string; closureDigest: string;
}
export interface HostHealthRequest { accountId: string; expectedHost: HealthHostIdentity }
export interface HostHealthProof {
  version: 1; host: HealthHostIdentity; accountId: string; principalDigest: string | null;
  revision: number; cookieRevision: number; observedAt: number | null; expiresAt: number | null; state: QaHealthState;
}
export interface QaAssignmentIdentity { admissionId: string; sessionHash: string }
export interface RuntimeHealthIdentity {
  instanceId: string; pid: number; version: string; bundleId: string | null; accountId: string; mode: "browser-only";
}
export interface HostAssignmentAdmission {
  version: 1; assignment: QaAssignmentIdentity; runtime: RuntimeHealthIdentity; host: HostHealthProof; admittedAt: number;
}
export interface RuntimeHealthRequest extends HostHealthRequest {
  probeId: string;
  assignment?: QaAssignmentIdentity & { expectedRuntime: RuntimeHealthIdentity; expectedProof: HostHealthProof };
}
export interface RuntimeHealthProof {
  version: 1; probeId: string;
  runtime: RuntimeHealthIdentity;
  acceptingNewAssignments: boolean; host: HostHealthProof;
  admission?: HostAssignmentAdmission;
}
export interface QaHealthAccount {
  id: string; origin: string; browserHostDescriptorPath?: string; runtimeControlTokenFile?: string; qaHealthPinPath?: string;
}
const hostFields = ["instanceId", "pid", "profile", "partition", "version", "closureDigest"] as const;
export function sameHealthHost(a: HealthHostIdentity, b: HealthHostIdentity): boolean {
  return !!a && !!b && hostFields.every(key => a[key] === b[key]);
}
export function descriptorHealthHost(d: LauncherBrowserHostDescriptor): HealthHostIdentity {
  if (!d.observationInstanceId || !d.hostVersion || !d.hostClosureDigest) throw new Error("Health descriptor identity unavailable");
  return { instanceId: d.observationInstanceId, pid: d.pid, profile: d.profile, partition: d.partition, version: d.hostVersion, closureDigest: d.hostClosureDigest };
}
function sameDescriptor(a: LauncherBrowserHostDescriptor, b: LauncherBrowserHostDescriptor) {
  return sameHealthHost(descriptorHealthHost(a), descriptorHealthHost(b))
    && a.control.endpoint === b.control.endpoint && a.control.token === b.control.token;
}
async function jsonPost(url: string, token: string, body: unknown, timeout: number): Promise<any> {
  const response = await fetch(url, { method: "POST", redirect: "error", cache: "no-store",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!response.ok || response.redirected) throw new Error("Health transport unavailable");
  return response.json();
}
export async function readHostHealth(descriptor: LauncherBrowserHostDescriptor, accountId: string): Promise<HostHealthProof> {
  const host = descriptorHealthHost(descriptor);
  const proof = await jsonPost(descriptor.control.endpoint + "/v1/health/read", descriptor.control.token,
    { accountId, expectedHost: host }, 6_000);
  if (!validHostProof(proof, host, accountId)) throw new Error("Health observation invalid");
  return proof;
}
function validHostProof(p: HostHealthProof, host: HealthHostIdentity, accountId: string): boolean {
  return !!p && p.version === 1 && sameHealthHost(p.host, host) && p.accountId === accountId
    && (p.principalDigest === null || typeof p.principalDigest === "string" && /^[a-f0-9]{64}$/.test(p.principalDigest))
    && Number.isSafeInteger(p.revision) && p.revision >= 0
    && Number.isSafeInteger(p.cookieRevision) && p.cookieRevision >= 0
    && ["ready", "signed_out", "unknown"].includes(p.state)
    && ((p.observedAt === null && p.expiresAt === null && p.state === "unknown")
      || typeof p.observedAt === "number" && Number.isSafeInteger(p.observedAt) && p.observedAt > 0
      && p.expiresAt === p.observedAt + QA_HEALTH_FRESHNESS_MS);
}
function ready(p: HostHealthProof, now: number) {
  return p.state === "ready" && p.revision > 0 && p.observedAt !== null && p.expiresAt !== null
    && p.observedAt <= now && now < p.expiresAt;
}
const runtimeFields = ["instanceId", "pid", "version", "bundleId", "accountId", "mode"] as const;
function sameRuntime(a: RuntimeHealthIdentity, b: RuntimeHealthIdentity) {
  return !!a && !!b && runtimeFields.every(key => a[key] === b[key]);
}
function validAssignment(a: QaAssignmentIdentity): boolean {
  return !!a && /^[a-f0-9-]{36}$/.test(a.admissionId) && /^[a-f0-9]{64}$/.test(a.sessionHash);
}
function matchesAdmission(value: HostAssignmentAdmission, assignment: QaAssignmentIdentity,
  runtime: RuntimeHealthIdentity, host: HostHealthProof): boolean {
  return !!value && value.version === 1 && value.assignment?.admissionId === assignment.admissionId
    && value.assignment.sessionHash === assignment.sessionHash && sameRuntime(value.runtime, runtime)
    && JSON.stringify(value.host) === JSON.stringify(host) && ready(value.host, Date.now())
    && Number.isSafeInteger(value.admittedAt) && value.admittedAt >= host.observedAt!
    && value.admittedAt <= Date.now() && value.admittedAt < host.expiresAt!;
}
export function createRuntimeQaHealth(config: { mode: string; accountId?: string; browserHostDescriptorPath?: string; qaHealthPinPath?: string },
  accepting: () => boolean) {
  // Per listener, not a caller supplied UUID or a diagnostic response header.
  const instanceId = randomUUID();
  const bundleId = LOADED_RUNTIME_BUNDLE_ID;
  const runtime: RuntimeHealthIdentity = { instanceId, pid: process.pid, version: VERSION, bundleId,
    accountId: config.accountId ?? "", mode: "browser-only" };
  return async (request: RuntimeHealthRequest): Promise<RuntimeHealthProof> => {
    if (config.mode !== "browser-only" || !config.accountId || !config.browserHostDescriptorPath
      || request?.accountId !== config.accountId || typeof request.probeId !== "string"
      || !/^[a-f0-9-]{36}$/.test(request.probeId)) throw new Error("QA health binding unavailable");
    const descriptor = readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath);
    if (!sameHealthHost(request.expectedHost, descriptorHealthHost(descriptor))) throw new Error("QA health Host changed");
    if (request.assignment !== undefined) {
      const { expectedRuntime, expectedProof, ...assignment } = request.assignment;
      if (!validAssignment(assignment) || !bundleId || !sameRuntime(expectedRuntime, runtime) || !accepting()
        || !validHostProof(expectedProof, request.expectedHost, config.accountId) || !ready(expectedProof, Date.now())
        || expectedProof.principalDigest !== readPrincipalPin(config.qaHealthPinPath, config.accountId, request.expectedHost)) {
        throw new Error("Selected QA assignment proof unavailable");
      }
      // The selected assignment, not a background probe: Host makes a synchronous
      // decision against its current cookie revision and pin. This is the health
      // admission boundary, not a transaction spanning Host and the pool database.
      const admission = await jsonPost(descriptor.control.endpoint + "/v1/health/admit", descriptor.control.token,
        { accountId: config.accountId, expectedHost: request.expectedHost, assignment, runtime, expectedProof }, 1_000);
      if (!matchesAdmission(admission, assignment, runtime, expectedProof) || !accepting()
        || !sameDescriptor(descriptor, readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath))
        || expectedProof.principalDigest !== readPrincipalPin(config.qaHealthPinPath, config.accountId, request.expectedHost)) {
        throw new Error("Selected QA assignment changed during admission");
      }
      return { version: 1, probeId: request.probeId, runtime, host: admission.host, acceptingNewAssignments: true, admission };
    }
    const host = await readHostHealth(descriptor, config.accountId);
    if (!sameDescriptor(descriptor, readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath))) {
      throw new Error("QA health Host changed during observation");
    }
    const pin = readPrincipalPin(config.qaHealthPinPath, config.accountId, host.host);
    if (!pin || host.principalDigest !== pin) host.state = "unknown";
    return { version: 1, probeId: request.probeId,
      runtime,
      acceptingNewAssignments: accepting(), host };
  };
}
export function readPrincipalPin(path: string | undefined, accountId: string, host: HealthHostIdentity): string | null {
  try {
    if (!path || !isAbsolute(path)) return null;
    privateFile(path);
    const pin = JSON.parse(readFileSync(path, "utf8"));
    return pin?.version === 1 && pin.accountId === accountId && pin.profile === host.profile
      && pin.partition === host.partition && /^[a-f0-9]{64}$/.test(pin.principalDigest) ? pin.principalDigest : null;
  } catch { return null; }
}
function privateFile(path: string) {
  const stat = statSync(path);
  if (!stat.isFile() || (process.platform !== "win32"
    && ((stat.mode & 0o077) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid()))) {
    throw new Error("Untrusted health control credentials");
  }
}
function readControlToken(path: string): string {
  privateFile(path);
  const token = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error("Invalid health control credentials");
  return token;
}
export class QaHealthAdmission {
  private pending = new Map<string, Promise<boolean>>();
  private admissions = new Map<string, { expiresAt: number; descriptor: LauncherBrowserHostDescriptor; principalDigest: string;
    token: string; runtime: RuntimeHealthIdentity; host: HostHealthProof }>();
  private observations = new Map<string, { hostInstance: string; runtimeInstance: string; revision: number; cookieRevision: number; serialized: string }>();
  private states = new Map<string, MaintenanceHealthState>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private accounts: QaHealthAccount[]) {
    this.timer = setInterval(() => { void Promise.allSettled(accounts.map(a => this.check(a))); }, QA_HEALTH_REFRESH_MS);
    this.timer.unref();
    void Promise.allSettled(accounts.map(a => this.check(a)));
  }
  snapshot() { return Object.fromEntries(this.accounts.map(a => [createHash("sha256").update(a.id).digest("hex").slice(0, 16),
    this.states.get(a.id) === "ready" && !this.eligibleNow(a) ? "unknown" : this.states.get(a.id) ?? "unknown"])); }
  close() { this.closed = true; clearInterval(this.timer); }
  eligibleNow(account: QaHealthAccount): boolean {
    const proof = this.admissions.get(account.id);
    if (this.closed || !proof || this.states.get(account.id) !== "ready" || Date.now() >= proof.expiresAt) return false;
    try {
      return !!account.browserHostDescriptorPath && !!account.runtimeControlTokenFile
        && sameDescriptor(proof.descriptor, readLauncherBrowserHostDescriptor(account.browserHostDescriptorPath))
        && proof.token === readControlToken(account.runtimeControlTokenFile)
        && proof.principalDigest === readPrincipalPin(account.qaHealthPinPath, account.id, descriptorHealthHost(proof.descriptor));
    } catch { return false; }
  }
  check(account: QaHealthAccount): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const prior = this.pending.get(account.id);
    if (prior) return prior;
    const operation = this.probe(account).finally(() => { this.pending.delete(account.id); });
    this.pending.set(account.id, operation);
    return operation;
  }
  async authorizeSelected(account: QaHealthAccount, sessionHash: string): Promise<(() => HostAssignmentAdmission | undefined) | undefined> {
    const proof = this.admissions.get(account.id);
    if (!proof || !this.eligibleNow(account)) return;
    const assignment = { admissionId: randomUUID(), sessionHash };
    const probeId = randomUUID();
    try {
      const result = await jsonPost(account.origin.replace(/\/$/, "") + "/admin/qa-health", proof.token,
        { accountId: account.id, expectedHost: descriptorHealthHost(proof.descriptor), probeId,
          assignment: { ...assignment, expectedRuntime: proof.runtime, expectedProof: proof.host } }, 2_000) as RuntimeHealthProof;
      if (result?.version !== 1 || result.probeId !== probeId || result.acceptingNewAssignments !== true
        || !sameRuntime(result.runtime, proof.runtime) || JSON.stringify(result.host) !== JSON.stringify(proof.host)
        || !matchesAdmission(result.admission!, assignment, proof.runtime, proof.host)) throw new Error("QA admission mismatch");
      let consumed = false;
      // Only the caller that requested this exact selected account/session may
      // consume the result, once, inside the synchronous owner transaction.
      return () => {
        if (consumed) return;
        consumed = true;
        if (this.closed || !ready(proof.host, Date.now())) return;
        try {
          const valid = !!account.browserHostDescriptorPath && !!account.runtimeControlTokenFile
            && sameDescriptor(proof.descriptor, readLauncherBrowserHostDescriptor(account.browserHostDescriptorPath))
            && proof.token === readControlToken(account.runtimeControlTokenFile)
            && proof.principalDigest === readPrincipalPin(account.qaHealthPinPath, account.id, proof.host.host);
          return valid ? structuredClone(result.admission!) : undefined;
        } catch { return; }
      };
    } catch {
      this.admissions.delete(account.id); this.states.set(account.id, "unknown");
      return;
    }
  }
  private async probe(account: QaHealthAccount): Promise<boolean> {
    let state: MaintenanceHealthState = "unknown";
    let descriptor: LauncherBrowserHostDescriptor | undefined;
    let admitted = false;
    this.admissions.delete(account.id);
    try {
      if (!account.browserHostDescriptorPath || !account.runtimeControlTokenFile) throw new Error("Health configuration missing");
      descriptor = readLauncherBrowserHostDescriptor(account.browserHostDescriptorPath);
      const expectedHost = descriptorHealthHost(descriptor);
      const token = readControlToken(account.runtimeControlTokenFile);
      const probeId = randomUUID();
      state = "runtime_unavailable";
      const result = await jsonPost(account.origin.replace(/\/$/, "") + "/admin/qa-health", token,
        { accountId: account.id, expectedHost, probeId }, 7_000) as RuntimeHealthProof;
      state = "binding_mismatch";
      if (result?.version !== 1 || result.probeId !== probeId || result.runtime?.accountId !== account.id
        || result.runtime.mode !== "browser-only" || typeof result.runtime.instanceId !== "string"
        || !/^[a-f0-9-]{36}$/.test(result.runtime.instanceId) || !Number.isSafeInteger(result.runtime.pid)
        || result.runtime.pid < 1 || typeof result.runtime.version !== "string" || !result.runtime.version
        || typeof result.runtime.bundleId !== "string" || !/^[a-f0-9]{64}$/.test(result.runtime.bundleId)
        || typeof result.acceptingNewAssignments !== "boolean"
        || !validHostProof(result.host, expectedHost, account.id)) throw new Error("Runtime health identity mismatch");
      // Re-read the actual Host, not just the runtime's cached report: cookie changes,
      // descriptor replacement and a new Host cannot resurrect a prior ready proof.
      const current = await readHostHealth(descriptor, account.id);
      if (!sameDescriptor(descriptor, readLauncherBrowserHostDescriptor(account.browserHostDescriptorPath))
        || JSON.stringify(current) !== JSON.stringify(result.host)) throw new Error("Host health changed");
      const previous = this.observations.get(account.id);
      const serialized = JSON.stringify(current);
      if (previous?.hostInstance === expectedHost.instanceId) {
        if (current.revision < previous.revision || current.cookieRevision < previous.cookieRevision
          || current.revision === previous.revision && current.cookieRevision === previous.cookieRevision
            && serialized !== previous.serialized && current.state === "ready") throw new Error("Health revision regressed");
      }
      this.observations.set(account.id, { hostInstance: expectedHost.instanceId, runtimeInstance: result.runtime.instanceId,
        revision: current.revision, cookieRevision: current.cookieRevision, serialized });
      const pin = readPrincipalPin(account.qaHealthPinPath, account.id, expectedHost);
      state = !pin || pin !== current.principalDigest ? "unknown" : !result.acceptingNewAssignments ? "draining" : ready(current, Date.now()) ? "ready"
        : current.state === "signed_out" ? "signed_out" : "unknown";
      admitted = state === "ready";
      if (admitted) this.admissions.set(account.id, { expiresAt: current.expiresAt!, descriptor, principalDigest: pin!, token,
        runtime: result.runtime, host: current });
    } catch { /* A failed observation replaces availability, never renews a ready proof. */ }
    if (this.closed) return false;
    this.states.set(account.id, state);
    if (descriptor) {
      try {
        await jsonPost(descriptor.control.endpoint + "/v1/health/maintenance", descriptor.control.token,
          { accountId: account.id, expectedHost: descriptorHealthHost(descriptor), state }, 1_000);
      } catch { /* Delivery failure is not health evidence; no external notification fallback. */ }
    }
    return admitted && this.eligibleNow(account);
  }
}
