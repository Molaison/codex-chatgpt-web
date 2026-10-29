import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const hostPath = require.resolve(process.env.STANDBY_HOST_SOURCE ?? "../launcher/electron/browser-host.cjs");
const hostModule = { exports: {} as any };
const hostRequire = createRequire(hostPath);
let delayedLoads: Promise<void> | undefined;
let failedRoute: string | undefined;
let viewSerial = 0;
class StandbyTestView {
  webContents: any;
  constructor() {
    const targetId = `pool-target-${++viewSerial}`;
    this.webContents = Object.assign(new EventEmitter(), {
      url: "about:blank", destroyed: false,
      getURL() { return this.url; }, isDestroyed() { return this.destroyed; },
      getOrCreateDevToolsTargetId: () => targetId,
      setZoomFactor() {}, stop() {},
      enableDeviceEmulation() {},
      async insertCSS() { return "viewport-css"; },
      async loadURL(this: any, url: string) {
        if (delayedLoads) await delayedLoads;
        this.url = url;
        this.emit("did-finish-load");
      },
      async executeJavaScript() {
        if (this.url === failedRoute) throw new Error("Injected renderer observation failure");
        return true;
      },
      close(this: any) { this.destroyed = true; this.emit("destroyed"); },
    });
  }
  setBounds() {}
  setVisible() {}
}
new Function("require", "module", "exports", "__dirname", "__filename", readFileSync(hostPath, "utf8"))(
  (id: string) => id === "electron" ? { WebContentsView: StandbyTestView } : hostRequire(id), hostModule, hostModule.exports, dirname(hostPath), hostPath,
);
const { BrowserHost } = hostModule.exports;

function standbyFixture() {
  const contents: any = Object.assign(new EventEmitter(), {
    url: "https://chatgpt.com/", destroyed: false, ready: true, probes: 0, loads: 0,
    getURL() { return this.url; }, isDestroyed() { return this.destroyed; },
    getOrCreateDevToolsTargetId: () => "standby-target", setZoomFactor() {},
    async insertCSS() { return "viewport-css"; }, stop() {},
    async loadURL(this: any, url: string) { this.loads++; this.url = url; this.emit("did-finish-load"); },
    async executeJavaScript() { this.probes++; return this.ready; },
  });
  contents.debugger = Object.assign(new EventEmitter(), {
    attached: false, isAttached() { return this.attached; },
    attach() { this.attached = true; },
    async sendCommand(method: string) {
      return method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "frame", loaderId: "loader", url: contents.url } } } : {};
    },
  });
  const view = { webContents: contents };
  const removed: any[] = [];
  const host: any = Object.assign(Object.create(BrowserHost.prototype), {
    profile: "production", partition: "persist:isolated", observationInstanceId: "i".repeat(32),
    turnTabs: new Map(), userCancelledTurnOwners: new Map(), state: { zoomFactor: 1 },
    standbyViews: new Map([["https://chatgpt.com/", { view, ready: true, startedAt: Date.now() - 300_000, targetUrl: "https://chatgpt.com/" }]]),
    syncPowerSaveBlocker() {}, presentTurnView() {}, bindShellZoomShortcuts() {}, bindTurnContents() {},
    markTurnTabSurface: BrowserHost.prototype.markTurnTabSurface, prepareStandbyView: async () => {},
    removeTurnTab(tab: any, abort: boolean) { removed.push({ tab, abort }); this.turnTabs.delete(tab.id); },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return { host, contents, removed };
}

function poolFixture() {
  const { host } = standbyFixture();
  host.standbyViews = new Map();
  host.window = { contentView: { addChildView() {}, removeChildView() {} } };
  host.hiddenTurnBounds = () => ({ x: 0, y: 0, width: 1280, height: 900 });
  host.prepareStandbyView = BrowserHost.prototype.prepareStandbyView;
  host.initializeTurnTab = async (tab: any) => { tab.initializingSurface = false; };
  return host;
}

test("startup and concurrent refill keep both route keys even with five retained tabs", async () => {
  const host = poolFixture();
  host.turnTabs = new Map(Array.from({ length: 5 }, (_, index) => [String(index), { status: "ready" }]));
  const before = viewSerial;
  await Promise.all([host.prepareStandbyView(), host.prepareStandbyView(), host.prepareStandbyView()]);
  expect(viewSerial - before).toBe(3);
  expect(host.standbySnapshot().pages.map((page: any) => [page.targetUrl, page.ready])).toEqual([
    ["https://chatgpt.com/", true], ["https://chatgpt.com/?temporary-chat=true", true],
    ["https://chatgpt.com/", true],
  ]);
  host.discardStandbyView();
  expect(host.standbyViews.size).toBe(0);
});

test("four simultaneous turns consume three distinct spares and fall back once without stealing a refill", async () => {
  const host = poolFixture();
  await host.prepareStandbyView();
  const original = new Map(host.standbyViews);
  let releaseLoads!: () => void;
  let releaseMarks!: () => void;
  delayedLoads = new Promise<void>(resolve => { releaseLoads = resolve; });
  const markGate = new Promise<void>(resolve => { releaseMarks = resolve; });
  const mark = host.markTurnTabSurface.bind(host);
  host.markTurnTabSurface = async (...args: any[]) => { await markGate; return mark(...args); };
  try {
    const first = host.createTurnTab("persist", process.pid, undefined, undefined, undefined, undefined, true);
    const second = host.createTurnTab("temp", process.pid, undefined, undefined, undefined, undefined, true, "https://chatgpt.com/?temporary-chat=true");
    const third = host.createTurnTab("persist-overflow", process.pid, undefined, undefined, undefined, undefined, true);
    const fourth = host.createTurnTab("persist-cold", process.pid, undefined, undefined, undefined, undefined, true);
    expect(host.standbyViews.size).toBe(0);
    const beforeRefill = viewSerial;
    await host.prepareStandbyView();
    expect(viewSerial).toBe(beforeRefill); // Running turns must not start refill traffic.
    releaseMarks();
    const tabs: any[] = await Promise.all([first, second, third, fourth]);
    expect(new Set(tabs.map(tab => tab.view)).size).toBe(4);
    expect(new Set(tabs.map(tab => tab.surfaceId)).size).toBe(4);
    expect(tabs[0].view).toBe((original.get("https://chatgpt.com/") as any).view);
    expect(tabs[1].view).toBe((original.get("https://chatgpt.com/?temporary-chat=true") as any).view);
    expect(tabs[2].view).toBe((original.get("https://chatgpt.com/#spare-2") as any).view);
    expect(tabs[3].bootstrapReady).toBe(false);
    expect(tabs.filter(tab => tab.bootstrapReady)).toHaveLength(3);
    for (const tab of tabs) tab.status = "ready"; // Release the active writers before refilling.
    const refill = host.prepareStandbyView();
    expect(host.standbyViews.size).toBe(1); // Only the first serial load has started.
    const refilling = host.standbyViews.get("https://chatgpt.com/");
    const concurrentRefill = host.prepareStandbyView();
    expect(host.standbyViews.get("https://chatgpt.com/")).toBe(refilling);
    releaseLoads();
    delayedLoads = undefined;
    await Promise.all([refill, concurrentRefill]);
    expect(host.standbyViews.size).toBe(3);
    expect(host.standbySnapshot().pages.every((entry: any) => entry.ready)).toBe(true);
  } finally {
    releaseLoads();
    releaseMarks();
    delayedLoads = undefined;
    host.discardStandbyView();
  }
});

test("same-mode burst claims two persistent documents and never takes the temporary spare", async () => {
  const host = poolFixture();
  await host.prepareStandbyView();
  const temporary = host.standbyViews.get("https://chatgpt.com/?temporary-chat=true");
  let releaseLoads!: () => void;
  delayedLoads = new Promise<void>(resolve => { releaseLoads = resolve; });
  try {
    const tabs: any[] = await Promise.all(["first", "second", "third"].map(trace =>
      host.createTurnTab(trace, process.pid, undefined, undefined, undefined, undefined, true)));
    expect(tabs.filter(tab => tab.bootstrapReady)).toHaveLength(2);
    expect(new Set(tabs.map(tab => tab.view)).size).toBe(3);
    expect(new Set(tabs.map(tab => tab.surfaceId)).size).toBe(3);
    expect(host.standbyViews.get("https://chatgpt.com/?temporary-chat=true")).toBe(temporary);
    expect(host.standbyViews.size).toBe(1); // Keep the temporary spare; pause saved refill.
    for (const tab of tabs) tab.status = "ready";
    const refill = host.prepareStandbyView();
    releaseLoads();
    delayedLoads = undefined;
    await refill;
    expect(host.standbyViews.size).toBe(3);
    expect(host.standbyViews.get("https://chatgpt.com/?temporary-chat=true")).toBe(temporary);
    expect(host.standbySnapshot().pages.filter((page: any) => page.targetUrl === "https://chatgpt.com/" && page.ready)).toHaveLength(2);
  } finally {
    releaseLoads();
    delayedLoads = undefined;
    host.discardStandbyView();
  }
});

test("a stale duplicate cannot discard its healthy sibling", async () => {
  const host = poolFixture();
  await host.prepareStandbyView();
  host.standbyViews.get("https://chatgpt.com/").view.webContents.url = "https://chatgpt.com/c/old-transcript";
  const sibling = host.standbyViews.get("https://chatgpt.com/#spare-2");
  const tab = await host.createTurnTab("healthy-sibling", process.pid, undefined, undefined, undefined, undefined, true);
  expect(tab.view).toBe(sibling.view);
  expect(tab.bootstrapReady).toBe(true);
  await host.prepareStandbyView();
  expect(host.standbyViews.size).toBe(1); // Only the pinned temporary page remains during the turn.
  tab.status = "ready";
  await host.prepareStandbyView();
  expect(host.standbyViews.size).toBe(3);
  host.discardStandbyView();
});

test("failure cooldown belongs to one route and cannot suppress the other route", async () => {
  const host = poolFixture();
  failedRoute = "https://chatgpt.com/";
  try {
    await host.prepareStandbyView();
    expect(host.standbyViews.has("https://chatgpt.com/")).toBe(false);
    expect(host.standbyViews.get("https://chatgpt.com/?temporary-chat=true").ready).toBe(true);
    expect(host.standbyRetryTimer).toBeDefined();
    const before = viewSerial;
    await host.prepareStandbyView();
    expect(viewSerial).toBe(before);
  } finally {
    failedRoute = undefined;
    host.discardStandbyView();
    expect(host.standbyRetryTimer).toBeNull();
  }
});

test("the spare cap is configurable and project allocation cannot evict pinned base routes", async () => {
  const saved = process.env.CODEX_WEB_WARM_SURFACES;
  const host = poolFixture();
  try {
    for (const [value, expected] of [["0", 0], ["1", 1], ["2", 2], ["3", 3], ["50", 3], ["NaN", 3]] as const) {
      host.discardStandbyView();
      process.env.CODEX_WEB_WARM_SURFACES = value;
      host.standbyProjectUrl = "https://chatgpt.com/g/g-p-" + "a".repeat(32) + "/project";
      await host.prepareStandbyView();
      expect(host.standbyViews.size).toBe(expected);
      if (expected >= 2) expect(host.standbyViews.get("https://chatgpt.com/?temporary-chat=true").ready).toBe(true);
    }
  } finally {
    if (saved === undefined) delete process.env.CODEX_WEB_WARM_SURFACES;
    else process.env.CODEX_WEB_WARM_SURFACES = saved;
    host.discardStandbyView();
  }
});

for (const stage of ["mark", "probe"] as const) {
  test(`standby acquisition abort settles while ${stage} remains suspended`, async () => {
    const { host, contents, removed } = standbyFixture();
    const abort = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const suspended = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    if (stage === "mark") host.markTurnTabSurface = async () => { entered(); await suspended; };
    else contents.executeJavaScript = async () => { entered(); await suspended; return true; };
    const pending = host.createTurnTab("trace", process.pid, undefined, undefined, abort.signal, undefined, true);
    await started;
    const tab = [...host.turnTabs.values()][0] as any;
    abort.abort();
    await expect(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("abort did not settle")), 100))]))
      .rejects.toThrow("abort");
    expect(host.turnTabs.size).toBe(0);
    expect(removed).toHaveLength(1);
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    expect(contents.listenerCount("render-process-gone")).toBe(0);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tab.bootstrapReady).toBe(false);
    expect(contents.debugger.attached).toBe(false);
    expect(removed).toHaveLength(1);
  });
}

test("an already-loaded standby reaches the real Host watch without a new load event", async () => {
  const { host, contents } = standbyFixture();
  const tab = await host.createTurnTab("trace", process.pid, undefined, undefined, undefined, undefined, true);
  expect(host.standbyViews.size).toBe(0);
  expect(tab.bootstrapReady).toBe(true);
  expect(tab.rendererReady).toBe(true);
  expect(tab.loading).toBe(false);
  expect(tab.url).toBe("https://chatgpt.com/");
  expect(contents.probes).toBe(1);
  expect(contents.loads).toBe(0);
  const scope = { operationId: "op", executionKey: "execution", roundKey: "round", turnId: "turn", traceId: "trace" };
  const watch = await host.nativeSubmissionWatch({ action: "start", traceId: "trace", helperPid: process.pid,
    surfaceId: tab.surfaceId, targetId: contents.getOrCreateDevToolsTargetId(), sendId: randomUUID(), scope,
    slot: { roundKey: "round", stage: { kind: "final" } },
    host: { pid: process.pid, instanceId: host.observationInstanceId, profile: host.profile, partition: host.partition },
  });
  expect(watch.active).toBe(true);
  expect(watch.postCount).toBe(0);
  expect(watch.documentEpoch).toBe(JSON.stringify(["frame", "loader"]));
});

test("an invalid empty-page claim falls back to synchronous initialization", async () => {
  const { host, contents, removed } = standbyFixture();
  contents.ready = false;
  let initializations = 0;
  let initializationTarget: string | undefined;
  host.initializeTurnTab = async (tab: any, _signal: AbortSignal | undefined, targetUrl: string) => {
    initializations++;
    initializationTarget = targetUrl;
    tab.url = "about:blank";
    tab.initializingSurface = false;
  };
  const tab = await host.createTurnTab("trace", process.pid, undefined, undefined, undefined, undefined, true);
  expect(initializations).toBe(1);
  expect(initializationTarget).toBe("https://chatgpt.com/");
  expect(tab.bootstrapReady).toBe(false);
  expect(tab.url).toBe("about:blank");
  expect(removed).toHaveLength(0);
});

test("a cold target that requires sign-in remains owned for the normal authentication release", async () => {
  const { host, contents, removed } = standbyFixture();
  host.standbyViews = new Map();
  contents.loadURL = async () => { throw new Error("sign-in redirect blocked"); };
  const tab: any = {
    id: "cold-auth", traceId: "trace", surfaceId: "s".repeat(32), initializingSurface: true,
    authenticationRequired: true, view: { webContents: contents },
  };
  host.turnTabs.set(tab.id, tab);
  await expect(host.initializeTurnTab(tab, undefined, "https://chatgpt.com/"))
    .resolves.toBeUndefined();
  expect(host.turnTabs.get(tab.id)).toBe(tab);
  expect(tab.initializingSurface).toBe(false);
  expect(removed).toHaveLength(0);
});

for (const targetUrl of ["https://chatgpt.com/", "https://chatgpt.com/?temporary-chat=true", "https://chatgpt.com/g/g-p-" + "a".repeat(32) + "/project"]) {
  test(`a cold turn initializes directly on its requested route ${targetUrl}`, async () => {
    const host = poolFixture();
    host.prepareStandbyView = async () => {};
    host.initializeTurnTab = BrowserHost.prototype.initializeTurnTab;
    const tab = await host.createTurnTab("trace", process.pid, undefined, undefined, undefined, undefined, true, targetUrl);
    expect(tab.view.webContents.url).toBe(targetUrl);
    expect(tab.initializingSurface).toBe(false);
    expect(host.standbyViews.size).toBe(0);
  });
}

for (const targetUrl of ["https://chatgpt.com/?temporary-chat=true", "https://chatgpt.com/g/g-p-" + "a".repeat(32) + "/project"]) {
  test(`a fresh matching standby leases the requested route ${targetUrl}`, async () => {
    const { host, contents } = standbyFixture();
    contents.url = targetUrl;
    const standby = host.standbyViews.get("https://chatgpt.com/");
    host.standbyViews.clear();
    host.standbyViews.set(targetUrl, { ...standby, targetUrl });
    const tab = await host.createTurnTab("trace", process.pid, undefined, undefined, undefined, undefined, true, targetUrl);
    expect(tab.url).toBe(targetUrl);
    expect(tab.bootstrapReady).toBe(true);
    expect(contents.probes).toBe(1);
    expect(contents.loads).toBe(0);
    expect(host.standbyViews.size).toBe(0);
  });
}

test("standby routes cannot navigate to an external site or an old transcript", async () => {
  for (const targetUrl of ["https://example.com/", "https://chatgpt.com/c/foreign", "https://chatgpt.com/?temporary-chat=false"]) {
    const { host } = standbyFixture();
    await expect(host.createTurnTab("trace", process.pid, undefined, undefined, undefined, undefined, true, targetUrl)).rejects.toThrow("Invalid");
    expect(host.turnTabs.size).toBe(0);
  }
});

for (const fault of ["navigation", "destroyed", "lost-owner", "aborted"] as const) {
  test(`standby admission preserves the fence when ${fault}`, async () => {
    const { host, contents, removed } = standbyFixture();
    const abort = new AbortController();
    host.markTurnTabSurface = async (tab: any) => {
      if (fault === "navigation") contents.url = "https://chatgpt.com/c/foreign";
      if (fault === "destroyed") contents.destroyed = true;
      if (fault === "lost-owner") host.turnTabs.delete(tab.id);
      if (fault === "aborted") abort.abort();
    };
    await expect(host.createTurnTab("trace", process.pid, undefined, undefined, abort.signal, undefined, true))
      .rejects.toThrow();
    expect(removed).toHaveLength(fault === "lost-owner" ? 0 : 1);
    expect(host.turnTabs.size).toBe(0);
    expect(contents.debugger.attached).toBe(false);
  });
}

for (const fault of ["same-url-navigation", "renderer-gone", "aborted", "replaced-owner"] as const) {
  test(`a stale standby readiness reply cannot authorize ${fault}`, async () => {
    const { host, contents, removed } = standbyFixture();
    const abort = new AbortController();
    let release!: (ready: boolean) => void;
    let observed!: () => void;
    const probe = new Promise<boolean>(resolve => { release = resolve; });
    const probing = new Promise<void>(resolve => { observed = resolve; });
    contents.executeJavaScript = () => { observed(); return probe; };
    const pending = host.createTurnTab("trace", process.pid, undefined, undefined, abort.signal, undefined, true);
    await probing;
    const tab = [...host.turnTabs.values()][0] as any;
    const replacement = { ...tab, helperPid: process.pid + 1 };
    if (fault === "same-url-navigation") contents.emit("did-start-navigation", {}, contents.url, false, true);
    if (fault === "renderer-gone") contents.emit("render-process-gone", {}, { reason: "crashed" });
    if (fault === "aborted") abort.abort();
    if (fault === "replaced-owner") host.turnTabs.set(tab.id, replacement);
    release(true);
    await expect(pending).rejects.toThrow();
    expect(tab.bootstrapReady).toBe(false);
    expect(tab.rendererReady).toBe(false);
    expect(removed).toHaveLength(fault === "replaced-owner" ? 0 : 1);
    if (fault === "replaced-owner") expect(host.turnTabs.get(tab.id)).toBe(replacement);
    expect(contents.debugger.attached).toBe(false);
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    expect(contents.listenerCount("render-process-gone")).toBe(0);
  });
}

test("abort in the readiness continuation wins before committing standby readiness", async () => {
  const { host, contents, removed } = standbyFixture();
  const abort = new AbortController();
  let release!: (ready: boolean) => void;
  let entered!: () => void;
  const probe = new Promise<boolean>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  contents.executeJavaScript = () => { entered(); return probe; };
  const pending = host.createTurnTab("trace", process.pid, undefined, undefined, abort.signal, undefined, true);
  await started;
  const tab = [...host.turnTabs.values()][0] as any;
  probe.then(() => abort.abort());
  release(true);
  await expect(pending).rejects.toThrow("abort");
  expect(tab.bootstrapReady).toBe(false);
  expect(tab.rendererReady).toBe(false);
  expect(host.turnTabs.size).toBe(0);
  expect(removed).toHaveLength(1);
});
