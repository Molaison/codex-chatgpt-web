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
new Function("require", "module", "exports", "__dirname", "__filename", readFileSync(hostPath, "utf8"))(
  (id: string) => id === "electron" ? {} : hostRequire(id), hostModule, hostModule.exports, dirname(hostPath), hostPath,
);
const { BrowserHost } = hostModule.exports;

function standbyFixture() {
  const contents: any = Object.assign(new EventEmitter(), {
    url: "https://chatgpt.com/", destroyed: false, ready: true, probes: 0,
    getURL() { return this.url; }, isDestroyed() { return this.destroyed; },
    getOrCreateDevToolsTargetId: () => "standby-target", setZoomFactor() {},
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
    standbyView: { view, ready: true, startedAt: Date.now() - 300_000 },
    syncPowerSaveBlocker() {}, presentTurnView() {}, bindShellZoomShortcuts() {}, bindTurnContents() {},
    markTurnTabSurface: async () => {}, prepareStandbyView: async () => {},
    removeTurnTab(tab: any, abort: boolean) { removed.push({ tab, abort }); this.turnTabs.delete(tab.id); },
    logger: { info() {}, warn() {}, debug() {} },
  });
  return { host, contents, removed };
}

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
  expect(host.standbyView).toBeNull();
  expect(tab.bootstrapReady).toBe(true);
  expect(tab.rendererReady).toBe(true);
  expect(tab.loading).toBe(false);
  expect(tab.url).toBe("https://chatgpt.com/");
  expect(contents.probes).toBe(1);
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

for (const fault of ["not-ready", "navigation", "destroyed", "lost-owner", "aborted"] as const) {
  test(`standby admission preserves the fence when ${fault}`, async () => {
    const { host, contents, removed } = standbyFixture();
    const abort = new AbortController();
    host.markTurnTabSurface = async (tab: any) => {
      if (fault === "not-ready") contents.ready = false;
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
