const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture(tab) {
  const state = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id, manualOperation: null, window: { contentView: { removeChildView() {} } },
    syncPowerSaveBlocker() {}, syncViewVisibility() {}, publishState() {}, writeDescriptor() {},
    snapshot: () => ({}), logger: { info() {}, warn() {}, error() {} },
    async createTurnTab(traceId, helperPid, conversationKey) {
      const fresh = { id: "fresh", surfaceId: "new-surface", traceId, helperPid, conversationKey,
        interactionMode: "automatic", status: "running" };
      this.turnTabs.set(fresh.id, fresh); return fresh;
    },
  });
  return state;
}

for (const condition of ["missing", "destroyed"]) {
  test("a retained " + condition + " WebContents cannot poison the next saved-chat lease", async () => {
    const tab = { id: "old", traceId: "previous", helperPid: 123, interactionMode: "automatic", status: "ready",
      conversationKey: "a".repeat(64), view: condition === "missing" ? {} : { webContents: { isDestroyed: () => true } } };
    const host = fixture(tab);
    const lease = await host.beginTurn("next-turn", false, process.pid, tab.conversationKey);
    assert.equal(lease.reused, false);
    assert.equal(lease.surfaceId, "new-surface");
    assert.equal(host.turnTabs.has("old"), false);
    assert.equal(host.turnTabs.get("fresh").conversationKey, tab.conversationKey);
  });
}

test("a closed required native conversation still fails instead of acquiring an unrelated chat", async () => {
  const tab = { id: "old", traceId: "previous", helperPid: 123, interactionMode: "automatic", status: "ready",
    conversationKey: "a".repeat(64), view: {} };
  const host = fixture(tab);
  await assert.rejects(host.beginTurn("next-turn", false, process.pid, tab.conversationKey, undefined, true),
    error => error.code === "retained_conversation_unavailable");
  assert.equal(host.turnTabs.size, 0);
});

test("destroyed event removes exactly its owned tab even after Electron clears webContents", () => {
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
  const tab = { id: "old", traceId: "previous", helperPid: 123, interactionMode: "automatic", status: "ready",
    view: { webContents: contents } };
  const host = fixture(tab);
  const other = { id: "other", status: "ready" };
  host.turnTabs.set(other.id, other);
  host.bindTurnContents(tab);
  delete tab.view.webContents;
  contents.emit("destroyed");
  assert.equal(host.turnTabs.has(tab.id), false);
  assert.equal(host.turnTabs.get(other.id), other);
  // Duplicate lifecycle notification is harmless and cannot remove another tab.
  contents.emit("destroyed");
  assert.equal(host.turnTabs.size, 1);
});

test("destruction of an active tab preserves its exact closed owner for endTurn", async () => {
  const tab = { id: "old", traceId: "active", helperPid: process.pid, interactionMode: "automatic", status: "running", view: {} };
  const host = fixture(tab);
  host.removeTurnTab(tab, true);
  assert.equal(host.closedTurnOwners.get("active"), process.pid);
  assert.deepEqual(await host.endTurn("active", process.pid, "failed", false), { cancelledByUser: false });
  assert.equal(host.closedTurnOwners.size, 0);
});

test("launcher shutdown owns cleanup and destroyed callbacks cannot republish its descriptor", () => {
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
  const tab = { id: "old", status: "ready", view: { webContents: contents } };
  const host = fixture(tab);
  host.removeTurnTab = () => { throw new Error("Shutdown must not publish tab state or rewrite its descriptor"); };
  host.bindTurnContents(tab);
  host.destroyed = true;
  delete tab.view.webContents;
  assert.doesNotThrow(() => contents.emit("destroyed"));
});
