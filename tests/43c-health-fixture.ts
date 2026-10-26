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

async function fixture(accountId = "synthetic-offline-only") {
  const root = mkdtempSync(join(tmpdir(), "43b-offline-health-"));
  const key = "test-client-" + "k".repeat(40), token = "t".repeat(43);
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


export { fixture };
