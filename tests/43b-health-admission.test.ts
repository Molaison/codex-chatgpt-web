import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, chmodSync, cpSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Database } from "bun:sqlite";
import { createQaPool } from "../src/qa-pool";
import { QaHealthAdmission, descriptorHealthHost } from "../src/qa-health";
import { installedRuntimeBundleId } from "../src/qa-health-build";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { VERSION } from "../src/version";
mock.module("electron", () => ({}));
const { BrowserHost, IDLE_BROWSER_URL } = require("../launcher/electron/browser-host.cjs");
const { BrowserControlServer } = require("../launcher/electron/control-server.cjs");
const { digestUserId } = require("../launcher/electron/health-identity.cjs");
const { HealthMaintenanceDelivery } = require("../launcher/electron/health-maintenance.cjs");
const { createStateStore } = require("../launcher/electron/state.cjs");

let buildRoot: string, bundled: any, bundleId: string;
beforeAll(async () => {
  buildRoot = mkdtempSync(join(tmpdir(), "43b-offline-build-"));
  const entry = join(buildRoot, "health.ts");
  writeFileSync(entry, "export { createRuntimeQaHealth } from " + JSON.stringify(resolve("src/qa-health.ts")) + ";");
  mkdirSync(join(buildRoot, "runtime/app"), { recursive: true });
  const result = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm",
    outdir: join(buildRoot, "runtime/app"), naming: "cli.js", external: ["playwright-core"] });
  expect(result.success).toBe(true);
  // A real local bundle with a schema2 manifest. This is an offline fixture build,
  // never an enrolled real account or production candidate.
  cpSync(resolve("node_modules/playwright-core"), join(buildRoot, "runtime/app/node_modules/playwright-core"), { recursive: true, dereference: true });
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  const scan = (directory: string, prefix = "") => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + file.name;
      if (file.isDirectory()) scan(join(directory, file.name), name + "/");
      else { const data = readFileSync(join(directory, file.name)); files.push({ path: name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") }); }
    }
  };
  scan(join(buildRoot, "runtime")); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(String(file.size)).update("\0").update(file.sha256).update("\0");
  bundleId = hash.digest("hex");
  writeFileSync(join(buildRoot, "runtime/manifest.json"), JSON.stringify({
    schemaVersion: 2, appVersion: VERSION, platform: process.platform, arch: process.arch,
    entrypoint: "app/cli.js", bundleId, files,
  }));
  bundled = await import(join(buildRoot, "runtime/app/cli.js"));
});
afterAll(() => { if (buildRoot) rmSync(buildRoot, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "43b-offline-health-"));
  const accountId = "synthetic-offline-only", key = "test-client-" + "k".repeat(40), token = "t".repeat(43);
  let userId = "synthetic-principal", authCalls = 0, dispatched = 0, draining = false;
  let corrupt: ((value: any) => any) | undefined, hostReadCorrupt: ((value: any) => any) | undefined;
  const cookies = new EventEmitter();
  const pinPath = join(root, "pin.json"), descriptorPath = join(root, "host.json");
  writeFileSync(pinPath, JSON.stringify({ version: 1, accountId, profile: "development",
    partition: "persist:codex-web-gpt-dev-chatgpt", principalDigest: digestUserId(userId) }), { mode: 0o600 });
  writeFileSync(join(root, "runtime.key"), token, { mode: 0o600 });
  writeFileSync(join(root, "client.key"), key, { mode: 0o600 });
  const stateStore = createStateStore(join(root, "state.json"));
  const delivery = new HealthMaintenanceDelivery({ stateStore, publishOperation() {} });
  const host: any = Object.assign(Object.create(BrowserHost.prototype), {
    observationInstanceId: "A".repeat(32), profile: "development", partition: "persist:codex-web-gpt-dev-chatgpt",
    getAccountId: () => accountId, getHealthPinPath: () => pinPath, getBrowserInteractionMode: () => "automatic",
    turnTabs: new Map([["running", { status: "running", traceId: "original-test-writer" }]]),
    view: { webContents: { isDestroyed: () => false, session: { cookies, fetch: async () => {
      authCalls++; return Response.json({ user: { id: userId } });
    } } } },
    refreshAuthenticationFromSession() {},
    publishHealth: (value: any) => delivery.report(value),
  });
  const read = host.readPassiveHealth.bind(host);
  host.readPassiveHealth = async (request: any) => {
    const value = await read(request);
    return hostReadCorrupt ? hostReadCorrupt(value) : value;
  };
  host.bindAuthenticationChanges();
  const control = new BrowserControlServer({ logger: { info() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}) });
  await control.start();
  const descriptor: any = { version: 3, kind: "codex-web-gpt-launcher", profile: host.profile, pid: process.pid,
    endpoint: control.descriptor().endpoint, control: control.descriptor(), helper: { executable: process.execPath, script: import.meta.path },
    partition: host.partition, idleUrl: IDLE_BROWSER_URL, surfaceId: "S".repeat(32), surfaceTargets: { ["S".repeat(32)]: "fixture-target" },
    createdAt: new Date().toISOString(), observationInstanceId: host.observationInstanceId,
    hostVersion: host.healthIdentity().version, hostClosureDigest: host.healthIdentity().closureDigest };
  const writeDescriptor = () => writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  writeDescriptor();
  const runtimeConfig = { mode: "browser-only", accountId, browserHostDescriptorPath: descriptorPath, qaHealthPinPath: pinPath };
  let producer = bundled.createRuntimeQaHealth(runtimeConfig, () => !draining);
  const runtime = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/admin/qa-health") {
      if (req.headers.get("authorization") !== "Bearer " + token) return new Response("unauthorized", { status: 401 });
      try { const proof = await producer(await req.json()); return Response.json(corrupt ? corrupt(proof) : proof); }
      catch { return new Response("unavailable", { status: 503 }); }
    }
    dispatched++;
    return Response.json({ id: "response-" + dispatched, object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", id: "message-" + dispatched,
        content: [{ type: "output_text", text: "offline fixture", annotations: [] }] }] });
  } });
  const account = { id: accountId, origin: runtime.url.origin, models: ["standard"], sessionModes: true,
    browserHostDescriptorPath: descriptorPath, runtimeControlTokenFile: join(root, "runtime.key"), qaHealthPinPath: pinPath };
  const config = { host: "127.0.0.1", port: 0, databasePath: join(root, "pool.db"),
    clients: [{ id: "test", keyFile: join(root, "client.key") }], accounts: [account] };
  const request = (thread: string, turn: string = thread) => new Request("http://pool/v1/responses", {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: "standard", input: "offline fixture", reasoning: { effort: "high-temporary" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn, request_id: turn }) } }) });
  return { root, host, control, runtime, descriptor, descriptorPath, pinPath, token, runtimeConfig,
    account, config, stateStore, request, dispatched: () => dispatched, authCalls: () => authCalls,
    drain: (v: boolean) => draining = v, corrupt: (f?: (v: any) => any) => corrupt = f,
    corruptHost: (f?: (v: any) => any) => hostReadCorrupt = f,
    switchUser: (v: string) => {
      userId = v; cookies.emit("changed", {}, { httpOnly: true, domain: ".chatgpt.com" }, "explicit", false);
      if (host.passiveHealth) host.passiveHealth.lastAttemptAt = -Infinity;
    },
    restartRuntime: () => { producer = bundled.createRuntimeQaHealth(runtimeConfig, () => !draining); },
    restartHost: () => {
      host.observationInstanceId = "B".repeat(32); host.passiveHealth = undefined;
      descriptor.observationInstanceId = host.observationInstanceId; writeDescriptor();
    },
    async close() { delivery.close(); await runtime.stop(true); control.server.closeAllConnections(); await new Promise<void>(r => control.server.close(r)); rmSync(root, { recursive: true, force: true }); },
  };
}

test("installed manifest verifies actual bytes; same version changed bytes cannot keep bundleId", () => {
  const file = join(buildRoot, "runtime/app/cli.js"), original = readFileSync(file);
  expect(installedRuntimeBundleId(file)).toBe(bundleId);
  writeFileSync(file, Buffer.concat([original, Buffer.from("\n// changed same version\n")]));
  try { expect(installedRuntimeBundleId(file)).toBeNull(); }
  finally { writeFileSync(file, original); }
  const extra = join(buildRoot, "runtime/app/unmanifested.js");
  writeFileSync(extra, "export const unexpected = true;");
  try { expect(installedRuntimeBundleId(file)).toBeNull(); }
  finally { rmSync(extra); }
});

test("actual Host control + bundled runtime proof + QaPool new owner; cookie switch blocks new but receipt and original owner survive", async () => {
  const f = await fixture(), pool = createQaPool(f.config);
  try {
    const first = await pool.fetch(f.request("original"));
    expect(first.status).toBe(200);
    const body = await first.json(); expect(f.dispatched()).toBe(1); expect(f.authCalls()).toBe(1);
    f.switchUser("another-synthetic-principal");
    const rejected = await pool.fetch(f.request("new-after-switch"));
    expect(rejected.status).toBe(503); expect(f.dispatched()).toBe(1);
    const replay = await pool.fetch(f.request("original"));
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(body); expect(f.dispatched()).toBe(1);
    const db = new Database(f.config.databasePath); expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 }); db.close();
    expect(f.host.activeTraceId).toBe("original-test-writer");
    f.switchUser("synthetic-principal");
    expect((await pool.fetch(f.request("healthy-again"))).status).toBe(200);
    f.drain(true);
    expect((await pool.fetch(f.request("admin-drained"))).status).toBe(503);
    expect(f.host.activeTraceId).toBe("original-test-writer");
  } finally { pool.close(); await f.close(); }
});

test("missing pin, missing control config, wrong digest/profile/account, forged runtime and stale proof fail closed", async () => {
  const f = await fixture(), health = new QaHealthAdmission([f.account]);
  try {
    expect(await health.check(f.account)).toBe(true);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try { expect(health.eligibleNow(f.account)).toBe(false); } finally { clock.mockRestore(); }
    const pin = readFileSync(f.pinPath);
    chmodSync(f.pinPath, 0o644); expect(health.eligibleNow(f.account)).toBe(false); expect(await health.check(f.account)).toBe(false);
    chmodSync(f.pinPath, 0o600);
    for (const changes of [{ principalDigest: "f".repeat(64) }, { accountId: "other" }, { profile: "production" }]) {
      writeFileSync(f.pinPath, JSON.stringify({ ...JSON.parse(pin.toString()), ...changes }));
      expect(await health.check(f.account)).toBe(false);
    }
    rmSync(f.pinPath); expect(await health.check(f.account)).toBe(false);
    writeFileSync(f.pinPath, pin, { mode: 0o600 });
    expect(await health.check({ ...f.account, runtimeControlTokenFile: undefined })).toBe(false);
    for (const corrupt of [
      (p: any) => ({ ...p, probeId: randomUUID() }),
      (p: any) => ({ ...p, runtime: { ...p.runtime, accountId: "foreign" } }),
      (p: any) => ({ ...p, runtime: { ...p.runtime, bundleId: null } }),
      (p: any) => ({ ...p, host: { ...p.host, host: { ...p.host.host, closureDigest: "0".repeat(64) } } }),
    ]) { f.corrupt(corrupt); expect(await health.check(f.account)).toBe(false); }
    f.corrupt();
    f.corruptHost((p: any) => ({ ...p, observedAt: Date.now() - 70_000, expiresAt: Date.now() - 10_000 }));
    expect(await health.check(f.account)).toBe(false); f.corruptHost();
    f.switchUser("synthetic-principal"); expect(await health.check(f.account)).toBe(true);
    f.restartRuntime(); expect(await health.check(f.account)).toBe(true);
    const old = await f.host.readPassiveHealth({ accountId: f.account.id, expectedHost: f.host.healthIdentity() });
    f.restartHost();
    f.corrupt((proof: any) => ({ ...proof, host: old }));
    expect(await health.check(f.account)).toBe(false);
    f.corrupt(); expect(await health.check(f.account)).toBe(true);
    f.drain(true); expect(await health.check(f.account)).toBe(false);
    f.switchUser("synthetic-principal"); expect(await health.check(f.account)).toBe(false);
  } finally { health.close(); await f.close(); }
});

test("real server route requires control credentials; source version cannot impersonate installed bundle", async () => {
  const f = await fixture();
  const config = { ...defaultConfig("browser-only"), port: 0, accountId: f.account.id,
    browserHostDescriptorPath: f.descriptorPath, qaHealthPinPath: f.pinPath, controlToken: f.token };
  const server = startServer(config);
  const request = () => JSON.stringify({ accountId: f.account.id, expectedHost: descriptorHealthHost(f.descriptor), probeId: randomUUID() });
  try {
    expect((await fetch(server.url.origin + "/admin/qa-health", { method: "POST", body: request() })).status).toBe(401);
    const read = () => fetch(server.url.origin + "/admin/qa-health", { method: "POST",
      headers: { authorization: "Bearer " + f.token }, body: request() });
    const result: any = await (await read()).json();
    expect(result.runtime.version).toBe(VERSION); expect(result.runtime.bundleId).toBeNull();
    await fetch(server.url.origin + "/admin/drain", { method: "POST", headers: { authorization: "Bearer " + f.token } });
    expect((await (await read()).json() as any).acceptingNewAssignments).toBe(false);
    expect((await fetch(server.url.origin + "/admin/qa-health", { method: "POST", headers: {
      authorization: "Bearer " + f.token, origin: "https://foreign.invalid" }, body: request() })).status).toBe(403);
  } finally { await server.stop(true); await f.close(); }
});


test("Host auth control rejects untrusted read and runtime failure reaches only persisted Launcher maintenance", async () => {
  const f = await fixture();
  const health = new QaHealthAdmission([f.account]);
  try {
    expect(await health.check(f.account)).toBe(true);
    const endpoint = f.control.descriptor().endpoint;
    expect((await fetch(endpoint + "/v1/health/read", { method: "POST", body: "{}" })).status).toBe(401);
    const before = f.authCalls();
    const bad = await fetch(endpoint + "/v1/health/read", { method: "POST", headers: { authorization: "Bearer " + f.control.descriptor().token },
      body: JSON.stringify({ accountId: f.account.id, expectedHost: { ...f.host.healthIdentity(), profile: "production" } }) });
    expect(bad.ok).toBe(false); expect(f.authCalls()).toBe(before);
    await f.runtime.stop(true);
    expect(await health.check(f.account)).toBe(false);
    const event = f.stateStore.read().maintenanceDelivery;
    expect(event.event.state).toBe("runtime_unavailable"); expect(event.acknowledgedAt).toBeNull();
    expect(f.stateStore.read().maintenanceHistory.length).toBeGreaterThan(0);
    expect(f.dispatched()).toBe(0); expect(f.host.activeTraceId).toBe("original-test-writer");
  } finally { health.close(); await f.close(); }
});
