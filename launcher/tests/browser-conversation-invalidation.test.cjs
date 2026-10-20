const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const originalLoad = Module._load;
let BrowserHost;
try {
  Module._load = function(name, ...args) {
    if (name === "electron") return { shell: { openExternal() {} } };
    return originalLoad.call(this, name, ...args);
  };
  ({ BrowserHost } = require("../electron/browser-host.cjs"));
} finally { Module._load = originalLoad; }

function fixture() {
  let closed = false;
  const cancellations = [];
  const contents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler() {}, setBackgroundThrottling() {},
    isDestroyed: () => closed, getURL: () => "https://chatgpt.com/",
    close() { closed = true; contents.emit("destroyed"); },
  });
  const tab = {
    id: "retained", traceId: "old", surfaceId: "owned-surface", helperPid: process.pid,
    status: "ready", interactionMode: "automatic", conversationKey: "key",
    connectorIdentity: "Codex", connectorBound: true, conversationObserved: false,
    view: { webContents: contents },
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id, manualOperation: null,
    window: { contentView: { removeChildView() {} } },
    logger: { info() {}, warn() {}, error() {} }, snapshot: () => ({}), publishState() {},
    syncPowerSaveBlocker() {}, syncViewVisibility() {}, writeDescriptor() {},
    cancelTurn: async traceId => { cancellations.push(traceId); },
  });
  host.bindTurnContents(tab);
  const navigate = (url, mainFrame = true) => contents.emit("did-navigate-in-page", {}, url, mainFrame);
  return { host, tab, contents, navigate, cancellations, closed: () => closed };
}

const project = "https://chatgpt.com/g/g-p-" + "a".repeat(32);

test("project chat changes invalidate idle retained history and connector binding", async () => {
  const { host, tab, navigate, closed } = fixture();
  navigate(project + "-papers/c/chat-a");
  navigate(project + "/c/chat-b");
  assert.equal(tab.status, "error");
  assert.equal(tab.conversationKey, undefined);
  assert.equal(tab.connectorBound, false);
  assert.equal(closed(), false);
  await assert.rejects(host.beginTurn("next", false, process.pid, "key", "Codex", true),
    error => error.code === "retained_conversation_unavailable");
});

for (const event of ["did-start-navigation", "did-navigate-in-page"]) {
  test(event + " revokes an already leased page and preserves exact retirement ownership", async () => {
    const { host, tab, contents, navigate, cancellations, closed } = fixture();
    navigate(project + "/c/chat-a");
    const lease = await host.beginTurn("next", false, process.pid, "key", "Codex");
    assert.equal(lease.reused, true);
    if (event === "did-start-navigation") contents.emit(event, {}, project + "/c/chat-b", false, true);
    else navigate(project + "/c/chat-b");
    assert.equal(closed(), true, "an in-flight helper must lose the native document");
    assert.equal(host.turnTabs.has(tab.id), false);
    assert.equal(tab.status, "aborted");
    assert.equal(host.closedTurnOwners.get("next"), process.pid);
    await Promise.resolve();
    assert.deepEqual(cancellations, ["next"]);
    await assert.rejects(host.endTurn("next", process.pid + 1, "failed", false), /ownership mismatch/);
    assert.deepEqual(await host.endTurn("next", process.pid, "failed", false), { cancelledByUser: false });
    assert.equal(host.closedTurnOwners.size, 0);
  });
}

test("first chat creation, same-chat reload and subframe navigation preserve a live lease", async () => {
  const { host, tab, contents, navigate, cancellations, closed } = fixture();
  tab.status = "running";
  navigate(project + "-old-name/c/chat-a");
  contents.emit("did-start-navigation", {}, project + "-new-name/c/chat-a/", false, true);
  navigate("https://chatgpt.com/c/chat-a");
  navigate("https://chatgpt.com/c/another", false);
  assert.equal(tab.conversationKey, "key");
  assert.equal(tab.connectorBound, true);
  assert.equal(tab.status, "running");
  assert.equal(host.turnTabs.get(tab.id), tab);
  assert.equal(closed(), false);
  assert.deepEqual(cancellations, []);
});

test("a failed runtime cancellation cannot restore a revoked native document", async () => {
  const { host, tab, navigate, contents, closed } = fixture();
  const errors = [];
  host.cancelTurn = async () => { throw new Error("runtime unavailable"); };
  host.logger.error = (event, details) => errors.push([event, details]);
  navigate("https://chatgpt.com/c/chat-a");
  await host.beginTurn("next", false, process.pid, "key", "Codex");
  navigate("https://chatgpt.com/");
  host.markTurnTabSurface = async () => { throw new Error("a removed document cannot be marked owned again"); };
  contents.emit("did-finish-load");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed(), true);
  assert.equal(host.turnTabs.has(tab.id), false);
  assert.equal(errors[0][0], "browser.invalidated_turn_cancellation_failed");
  assert.equal(errors[0][1].traceId, "next");
  assert.deepEqual(await host.endTurn("next", process.pid, "failed", false), { cancelledByUser: false });
});

for (const resumed of [false, true]) {
  for (const destination of ["https://chatgpt.com/c/another-chat", "https://chatgpt.com/?temporary-chat=true"]) {
    test(`a ${resumed ? "resumed" : "retained"} temporary conversation rejects document navigation to ${destination}`, async () => {
      const { host, tab, contents, navigate, closed } = fixture();
      tab.status = "running";
      navigate("https://chatgpt.com/?temporary-chat=true");
      await host.endTurn("old", process.pid, "completed", false, undefined, true, true);
      if (resumed) {
        const lease = await host.beginTurn("next", false, process.pid, "key", "Codex");
        assert.equal(lease.reused, true);
      }
      contents.emit("did-start-navigation", {}, destination, false, true);
      assert.equal(tab.conversationKey, undefined);
      assert.equal(tab.connectorBound, false);
      assert.equal(closed(), resumed);
      if (resumed) {
        assert.deepEqual(await host.endTurn("next", process.pid, "failed", false), { cancelledByUser: false });
      } else {
        await assert.rejects(host.beginTurn("next", false, process.pid, "key", "Codex", true),
          error => error.code === "retained_conversation_unavailable");
      }
    });
  }

  test(`a ${resumed ? "resumed" : "retained"} temporary conversation preserves same-document hash navigation`, async () => {
    const { host, tab, contents, navigate, closed } = fixture();
    tab.status = "running";
    const url = "https://chatgpt.com/?temporary-chat=true";
    contents.emit("did-start-navigation", {}, url, false, true);
    await host.endTurn("old", process.pid, "completed", false, undefined, true, true);
    if (resumed) await host.beginTurn("next", false, process.pid, "key", "Codex");
    contents.emit("did-start-navigation", {}, url + "#answer", true, true);
    navigate(url + "#answer");
    navigate(url + "#answer");
    assert.equal(tab.conversationKey, "key");
    assert.equal(tab.connectorBound, true);
    assert.equal(closed(), false);
  });
}

test("connector-free QA can promote its retained temporary chat and reload the saved identity", async () => {
  const { host, tab, contents, navigate, closed } = fixture();
  tab.status = "running";
  tab.connectorIdentity = undefined;
  tab.connectorBound = false;
  navigate("https://chatgpt.com/?temporary-chat=true");
  await host.endTurn("old", process.pid, "completed", false, undefined, true, false);
  const lease = await host.beginTurn("next", false, process.pid, "key");
  assert.equal(lease.reused, true);
  assert.equal(lease.connectorBound, false);
  const savedUrl = project + "/c/promoted-chat";
  navigate(savedUrl);
  contents.emit("did-start-navigation", {}, savedUrl, false, true);
  assert.equal(tab.conversationKey, "key");
  assert.equal(tab.chatConversationId, "promoted-chat");
  assert.equal(tab.status, "running");
  assert.equal(closed(), false);
});
