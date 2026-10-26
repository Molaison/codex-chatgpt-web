const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HealthMaintenanceDelivery, RETRY_MS, STORAGE_RECOVERY_MS, MAX_STORAGE_FAILURES } = require("../electron/health-maintenance.cjs");
const { createStateStore } = require("../electron/state.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "43c-maintenance-"));
  const store = createStateStore(path.join(root, "state.json"));
  let now = 1000000, index = 0, writes = 0, fail = false;
  const tasks = new Map(), sent = [];
  const update = store.update.bind(store);
  store.update = patch => { writes++; if (fail) throw Error("storage unavailable"); return update(patch); };
  const options = { stateStore: store, now: () => now, publishOperation: value => sent.push(value),
    schedule: (fn, delay) => { assert.ok(delay >= RETRY_MS); tasks.set(++index, { fn, at: now + delay }); return index; },
    cancel: id => tasks.delete(id) };
  const delivery = new HealthMaintenanceDelivery(options);
  return { store, delivery, options, tasks, sent, writes: () => writes, fail: value => { fail = value; },
    advance(ms) { now += ms; for (const [id, item] of [...tasks]) if (item.at <= now) { tasks.delete(id); item.fn(); } },
    close() { delivery.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("attempt-save outage is bounded and repeated same-state reports cannot spin; later report recovers same event within three deliveries", () => {
  const f = fixture(), request = { accountId: "offline-account", state: "unknown" };
  const update = f.store.update;
  let first = true;
  f.store.update = value => {
    const result = update(value);
    if (first) { first = false; f.fail(true); }
    return result;
  };
  try {
    assert.throws(() => f.delivery.report(request), /storage unavailable/);
    const id = f.store.read().maintenanceDelivery.event.eventId;
    const writes = f.writes();
    for (let n = 0; n < 100; n++) f.delivery.report(request);
    assert.equal(f.writes(), writes); assert.equal(f.sent.length, 0);
    for (let n = 1; n < MAX_STORAGE_FAILURES; n++) f.advance(RETRY_MS);
    assert.equal(f.writes(), 1 + MAX_STORAGE_FAILURES);
    assert.equal(f.tasks.size, 0);
    for (let n = 0; n < 100; n++) f.delivery.report(request);
    assert.equal(f.writes(), 1 + MAX_STORAGE_FAILURES);
    assert.equal(f.store.read().maintenanceDelivery.attempts, 0);
    f.fail(false); f.advance(STORAGE_RECOVERY_MS);
    const restored = f.delivery.report(request);
    assert.equal(restored.eventId, id); assert.equal(restored.attempts, 1);
    for (let n = 0; n < 10; n++) f.advance(RETRY_MS);
    assert.equal(f.sent.length, 3); assert.equal(f.tasks.size, 0);
    assert.equal(f.store.read().maintenanceDelivery.attempts, 3);
    assert.equal(f.store.read().maintenanceDelivery.acknowledgedAt, null);
    f.delivery.close();
    const restarted = new HealthMaintenanceDelivery(f.options);
    assert.equal(restarted.report(request).eventId, id);
    assert.equal(f.sent.length, 3);
    assert.equal(restarted.acknowledge(id), true); assert.ok(f.store.read().maintenanceDelivery.acknowledgedAt);
    restarted.close();
  } finally { f.close(); }
});

test("second attempt save fails after one delivery; recovery and ACK never reset persisted budget", () => {
  const f = fixture(), request = { accountId: "offline-account", state: "signed_out" };
  try {
    const first = f.delivery.report(request);
    f.fail(true); f.advance(RETRY_MS);
    assert.equal(f.sent.length, 1); assert.equal(f.store.read().maintenanceDelivery.attempts, 1);
    f.fail(false); f.advance(RETRY_MS);
    assert.equal(f.sent.length, 2); assert.equal(f.store.read().maintenanceDelivery.attempts, 2);
    assert.equal(f.delivery.acknowledge(first.eventId), true);
    f.advance(RETRY_MS * 4);
    assert.equal(f.sent.length, 2); assert.equal(f.tasks.size, 0);
    assert.equal(f.sent[0].maintenance.eventId, f.sent[1].maintenance.eventId);
  } finally { f.close(); }
});

test("new state supersedes failed attempt without stale timer or ACK; closed delivery cannot restart", () => {
  const f = fixture();
  try {
    const first = f.delivery.report({ accountId: "offline-account", state: "unknown" });
    f.fail(true); f.advance(RETRY_MS);
    f.fail(false);
    const next = f.delivery.report({ accountId: "offline-account", state: "ready" });
    assert.notEqual(first.eventId, next.eventId); assert.equal(f.delivery.acknowledge(first.eventId), false);
    f.delivery.close();
    const writes = f.writes(), sent = f.sent.length;
    f.advance(RETRY_MS * 10);
    assert.equal(f.writes(), writes); assert.equal(f.sent.length, sent);
    assert.throws(() => f.delivery.report({ accountId: "offline-account", state: "ready" }), /closed/);
    assert.equal(f.delivery.acknowledge(next.eventId), false);
  } finally { f.close(); }
});
