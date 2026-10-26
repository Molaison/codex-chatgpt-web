const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("../../node_modules/typescript");
const React = require("react");
const domino = require("../../node_modules/@mixmark-io/domino");

test("actual App applies maintenance DOM before ACK, including retried delivery and saved snapshot", async () => {
  const window = domino.createWindow("<!doctype html><html><body><div id='root'></div></body></html>");
  global.window = window; global.document = window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require("react-dom/client");
  const acknowledgements = [], listeners = new Map();
  const initial = { eventId: "11111111-1111-1111-1111-111111111111", accountKey: "a".repeat(16), state: "unknown", observedAt: 1 };
  const api = {
    snapshot: async () => ({ state: { language: "en", onboardingComplete: false, maintenanceDelivery: { event: initial } },
      operation: { name: "qa-health", status: "failed", message: "private upstream maintenance detail" },
      browser: null, logs: [], connectorNames: {}, platform: "linux", profile: "development" }),
    acknowledgeMaintenance: async ({ eventId }) => {
      assert.ok(window.document.querySelector('[data-maintenance-event="' + eventId + '"]'), "ACK needs actual committed DOM");
      acknowledgements.push(eventId); return true;
    },
  };
  for (const name of ["onStateChanged", "onConnectorNamesChanged", "onBrowserState", "onOperation", "onLog", "onUpdateState"]) {
    api[name] = handler => { listeners.set(name, handler); return () => listeners.delete(name); };
  }
  const source = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  const app = source.slice(source.indexOf("export function App()"), source.indexOf("\nfunction Onboarding("))
    .replace("export function", "function") + "\nmodule.exports = App;";
  const compiled = ts.transpileModule(app, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const context = { ...React, api, document: window.document, module, exports: module.exports, require,
    copyFor: () => ({ accountHealthReady: "服务端账号已恢复。", accountHealthPaused: "服务端正在检查账号，新任务将等待可用账号。" }),
    AnimatePresence: ({ children }) => children,
    FatalMessage: () => null, LaunchLoading: () => null, Onboarding: () => null, LauncherShell: () => null,
    ErrorToast: ({ message }) => React.createElement("div", { "data-error-toast": true }, message),
    messageOf: String };
  vm.runInNewContext(compiled, context);
  const root = createRoot(window.document.getElementById("root"));
  try {
    await React.act(async () => { root.render(React.createElement(module.exports)); });
    assert.deepEqual(acknowledgements, [initial.eventId]);
    assert.match(window.document.body.textContent, /服务端正在检查账号/);
    assert.equal(window.document.body.textContent.includes(initial.accountKey), false, "internal account hash is not customer status copy");
    assert.equal(Boolean(window.document.querySelector("[data-error-toast]")), false, "background health failure is a status");
    const next = { ...initial, eventId: "22222222-2222-2222-2222-222222222222", state: "ready" };
    await React.act(async () => {
      listeners.get("onOperation")({ name: "qa-health", status: "completed", message: "ready", maintenance: next });
      assert.deepEqual(acknowledgements, [initial.eventId], "receiving IPC is not applied ACK");
    });
    assert.deepEqual(acknowledgements, [initial.eventId, next.eventId]);
    assert.match(window.document.body.textContent, /服务端账号已恢复/);
    await React.act(async () => { listeners.get("onOperation")({ name: "qa-health", status: "completed", message: "ready", maintenance: next }); });
    assert.equal(acknowledgements.length, 3, "bounded sender retry can recover a lost ACK");
    await React.act(async () => {
      listeners.get("onOperation")({ name: "qa-health", status: "failed", message: "private probe failure", maintenance: { ...initial } });
    });
    assert.equal(Boolean(window.document.querySelector("[data-error-toast]")), false);
    await React.act(async () => {
      listeners.get("onOperation")({ name: "install", status: "failed", message: "installation failed" });
    });
    assert.equal(window.document.querySelector("[data-error-toast]").textContent, "installation failed");
  } finally { await React.act(async () => root.unmount()); delete global.window; delete global.document; delete global.IS_REACT_ACT_ENVIRONMENT; }
});

test("actual main IPC rejects foreign renderer/frame and only acknowledges matching current event", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf('  handle("launcher:maintenance-ack"');
  const end = source.indexOf('  handle("launcher:limits"', start);
  const handlers = new Map(), accepted = [];
  const sender = { mainFrame: {} }, mainWindow = { webContents: sender };
  vm.runInNewContext(source.slice(start, end), { handle: (name, fn) => handlers.set(name, fn), mainWindow,
    maintenanceDelivery: { acknowledge: id => { accepted.push(id); return id === "current"; } } });
  const ack = handlers.get("launcher:maintenance-ack");
  assert.equal(ack({ sender: {}, senderFrame: sender.mainFrame }, { eventId: "current" }), false);
  assert.equal(ack({ sender, senderFrame: {} }, { eventId: "current" }), false);
  assert.equal(ack({ sender, senderFrame: sender.mainFrame }, { eventId: "old" }), false);
  assert.equal(ack({ sender, senderFrame: sender.mainFrame }, { eventId: "current" }), true);
  assert.deepEqual(accepted, ["old", "current"]);
});
