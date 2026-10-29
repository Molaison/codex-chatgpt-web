const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === "electron" ? {} : originalLoad.call(this, id, ...args); };
const { BrowserHost } = require("../electron/browser-host.cjs");
Module._load = originalLoad;
const { digestUserId, closureDigest } = require("../electron/health-identity.cjs");
const { PassiveSessionHealth } = require("../electron/passive-session-health.cjs");
const { HealthMaintenanceDelivery } = require("../electron/health-maintenance.cjs");
const { createStateStore } = require("../electron/state.cjs");

function fixture() {
  let time = 1_000_000, calls = 0, fault = false, available = true;
  const identity = { accountId: "account-a", host: { instanceId: "A".repeat(32), pid: process.pid,
    profile: "development", partition: "persist:codex-web-gpt-dev-chatgpt", version: "6.1.10", closureDigest: "c".repeat(64) } };
  const session = { async fetch(url, options) {
    calls++; assert.equal(url, "https://chatgpt.com/api/auth/session");
    assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
    if (fault) return new Response("blocked", { status: 403 });
    return Response.json({ user: { id: "never-persist-this-user" } });
  } };
  const health = new PassiveSessionHealth({ identity: () => identity, session: () => session,
    pin: () => digestUserId("never-persist-this-user"), available: () => available, timeoutMs: 5000, now: () => time });
  return { health, session, identity, time: v => time = v, calls: () => calls,
    fault: v => fault = v, available: v => available = v };
}

test("passive proof retains original time/revision, refreshes at20s, no cached ready after fault", async () => {
  const f = fixture(), first = await f.health.read();
  assert.equal(first.state, "ready");
  assert.equal(JSON.stringify(first).includes("never-persist"), false);
  f.time(1_019_999); assert.deepEqual(await f.health.read(), first); assert.equal(f.calls(), 1);
  f.time(1_020_000); const second = await f.health.read();
  assert.equal(second.revision, 2); assert.equal(second.observedAt, 1_020_000);
  f.time(1_040_000); f.fault(true);
  assert.equal((await f.health.read()).state, "unknown");
  f.time(1_041_000); assert.equal((await f.health.read()).state, "unknown"); assert.equal(f.calls(), 3);
});

test("cookie invalidation and old in-flight result never renew ready; no parallel request", async () => {
  const f = fixture(); let finish;
  f.session.fetch = () => new Promise(resolve => { finish = resolve; });
  const a = f.health.read(), b = f.health.read();
  await Promise.resolve();
  f.health.invalidate(); finish(Response.json({ user: { id: "never-persist-this-user" } }));
  assert.equal((await a).state, "unknown"); assert.equal((await b).state, "unknown");
  assert.equal(f.health.proof, null);
  f.session.fetch = async () => Response.json({ user: { id: "never-persist-this-user" } });
  f.time(1_020_000); assert.equal((await f.health.read()).state, "ready");
});

test("expired proof, crashed Host and changed account never inherit prior ready", async () => {
  const f = fixture(); await f.health.read();
  f.time(1_060_000); assert.equal(f.health.current(f.identity).state, "unknown");
  f.available(false); assert.equal((await f.health.read()).state, "unknown");
  f.available(true); f.identity.accountId = "account-b"; f.fault(true);
  const changed = await f.health.read(); assert.equal(changed.state, "unknown"); assert.equal(changed.accountId, "account-b");
});

test("actual Host busy path uses session.fetch only and rejects foreign binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "health-pin-"));
  const pinPath = path.join(root, "pin.json");
  fs.writeFileSync(pinPath, JSON.stringify({ version: 1, accountId: "account-a", profile: "development",
    partition: "persist:codex-web-gpt-dev-chatgpt", principalDigest: digestUserId("secret") }), { mode: 0o600 });
  const events = Object.assign(new EventEmitter(), { get: async () => [] }); let authCalls = 0, pageCalls = 0, refreshCalls = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    observationInstanceId: "A".repeat(32), profile: "development", partition: "persist:codex-web-gpt-dev-chatgpt",
    getHealthPinPath: () => pinPath, getAccountId: () => "account-a", getBrowserInteractionMode: () => "automatic",
    turnTabs: new Map([["busy", { status: "running", traceId: "original-writer" }]]),
    view: { webContents: { isDestroyed: () => false,
      session: { cookies: events, fetch: async () => {
        authCalls++; return Response.json({ user: { id: "secret" } });
      } },
      executeJavaScript: () => { pageCalls++; throw Error("forbidden page probe"); },
      loadURL: () => { pageCalls++; throw Error("forbidden navigation"); },
    } },
    refreshAuthenticationFromSession: () => { refreshCalls++; },
  });
  host.bindAuthenticationChanges();
  const request = { accountId: "account-a", expectedHost: host.healthIdentity() };
  assert.equal((await host.readPassiveHealth(request)).state, "ready");
  assert.equal(host.activeTraceId, "original-writer"); assert.equal(pageCalls, 0); assert.equal(authCalls, 1);
  await assert.rejects(host.readPassiveHealth({ ...request, accountId: "account-b" }), /binding/);
  await assert.rejects(host.readPassiveHealth({ ...request, expectedHost: { ...request.expectedHost, instanceId: "B".repeat(32) } }), /binding/);
  // Even overwrite events invalidate proof, independent of the legacy listener's early return.
  events.emit("changed", {}, { httpOnly: true, domain: ".chatgpt.com" }, "overwrite", true);
  assert.equal(host.passiveHealth.proof, null);
  assert.equal((await host.readPassiveHealth(request)).state, "ready");
  assert.equal(authCalls, 2, "invalidation permits an immediate fresh auth read");
  assert.equal(refreshCalls, 0);
  host.passiveHealth.pending = Promise.resolve();
  events.emit("changed", {}, { httpOnly: true, domain: ".chatgpt.com" }, "explicit", false);
  assert.equal(refreshCalls, 0, "auth cookies from passive reads never start page probe");
  fs.rmSync(root, { recursive: true, force: true });
});

test("passive auth uses one five-second deadline across both transport attempts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let calls = 0;
  const health = new PassiveSessionHealth({ identity: () => ({ accountId: "a", host: {} }), available: () => true,
    timeoutMs: 5000, session: () => ({ fetch: (_url, { signal }) => {
      calls++; if (calls === 1) return Promise.reject(Error("temporary"));
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("deadline"))));
    } }) });
  const pending = health.read(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.equal((await pending).state, "unknown"); assert.equal(calls, 2);
});

function deliveryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "health-delivery-"));
  const stateStore = createStateStore(path.join(root, "state.json"));
  const queue = new Map(), deliveries = []; let id = 0;
  const options = { stateStore, publishOperation: value => deliveries.push(value), now: () => 1_000_000,
    schedule: cb => { queue.set(++id, cb); return id; }, cancel: id => queue.delete(id) };
  return { root, options, queue, deliveries, stateStore, tick() {
    const tasks = [...queue.values()]; queue.clear(); for (const task of tasks) task();
  }, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test("maintenance persists before delivery, retries bounded across restart, no fake ACK", () => {
  const f = deliveryFixture();
  try {
    let d = new HealthMaintenanceDelivery(f.options);
    const registered = d.report({ accountId: "private-account", state: "signed_out" });
    assert.equal(registered.acknowledged, false); assert.equal(f.deliveries.length, 1);
    assert.equal(JSON.stringify(f.deliveries).includes("private-account"), false);
    assert.equal(f.stateStore.read().maintenanceDelivery.attempts, 1);
    assert.equal(d.acknowledge("wrong-id"), false);
    d.close(); d = new HealthMaintenanceDelivery(f.options);
    f.tick(); f.tick(); f.tick(); assert.equal(f.deliveries.length, 3);
    assert.equal(d.report({ accountId: "private-account", state: "signed_out" }).attempts, 3);
    assert.equal(d.acknowledge(registered.eventId), true);
    assert.equal(d.acknowledge(registered.eventId), true);
    const recovery = d.report({ accountId: "private-account", state: "ready" });
    assert.notEqual(recovery.eventId, registered.eventId); assert.equal(d.acknowledge(registered.eventId), false);
    assert.equal(f.stateStore.read().maintenanceDelivery.acknowledgedAt, null);
    d.close();
  } finally { f.close(); }
});
test("failed maintenance persistence cannot publish or claim receiver ACK", () => {
  const f = deliveryFixture(); let fail = true;
  const update = f.stateStore.update.bind(f.stateStore);
  f.stateStore.update = value => { if (fail) throw Error("disk"); return update(value); };
  const d = new HealthMaintenanceDelivery(f.options);
  try {
    assert.throws(() => d.report({ accountId: "a", state: "unknown" }), /disk/);
    assert.equal(f.deliveries.length, 0);
    fail = false; const record = d.report({ accountId: "a", state: "unknown" }); fail = true;
    assert.throws(() => d.acknowledge(record.eventId), /disk/);
    assert.equal(d.status().acknowledged, false);
  } finally { d.close(); f.close(); }
});


test("no pin, absent stable user id and a cookie account switch cannot enroll themselves", async () => {
  const f = fixture();
  f.health.pin = () => null;
  const enrollment = await f.health.read();
  assert.equal(enrollment.state, "unknown");
  assert.equal(enrollment.principalDigest, digestUserId("never-persist-this-user"));
  f.health.pin = () => digestUserId("never-persist-this-user");
  assert.equal((await f.health.read()).state, "ready");
  f.health.invalidate(); f.time(1_020_000);
  f.session.fetch = async () => Response.json({ user: { id: "different-account" } });
  assert.equal((await f.health.read()).state, "unknown");
  f.time(1_040_000);
  f.session.fetch = async () => Response.json({ user: { email: "not-an-identity-fallback" } });
  assert.equal((await f.health.read()).principalDigest, null);
});

test("same version with changed Launcher closure changes content identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "health-build-"));
  try {
    const dir = path.join(root, "electron"); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "6.1.10" }));
    fs.writeFileSync(path.join(dir, "main.cjs"), "module.exports = 1;");
    const first = closureDigest(dir);
    fs.writeFileSync(path.join(dir, "main.cjs"), "module.exports = 2;");
    assert.notEqual(closureDigest(dir), first);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
