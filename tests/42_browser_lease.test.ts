import { expect, test, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, LauncherBrowserWriterConflictError, notifyLauncherTurn } from "../src/launcher-browser-host";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
// No desktop process is started; only Electron surfaces are replaced in this owner/control fixture.
mock.module("electron", () => ({}));
const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
const { BrowserControlServer } = require("../launcher/electron/control-server.cjs");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const key = "a".repeat(64), otherKey = "b".repeat(64);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(), logger,
    snapshot: () => ({}), writeDescriptor() {}, syncViewVisibility() {}, syncPowerSaveBlocker() {}, show() {}, hide() {},
    browserInteractionMode: () => "automatic", markTurnTabSurface: async () => {},
    removeTurnTab(tab: any) { host.turnTabs.delete(tab.id); },
    async createTurnTab(traceId: string, helperPid: number, conversationKey: string, connectorIdentity: string, signal: AbortSignal, conversationId: string, leaseFencing: boolean) {
      const tab = { id: randomBytes(12).toString("base64url"), surfaceId: randomBytes(24).toString("base64url"),
        traceId, helperPid, conversationKey, connectorIdentity, conversationId, leaseFencing, status: "running", interactionMode: "automatic",
        view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } }, initializingSurface: true };
      host.turnTabs.set(tab.id, tab);
      if (host.initializing) await host.initializing;
      signal?.throwIfAborted(); tab.initializingSurface = false;
      return tab;
    },
  });
  return host;
}
async function serverFixture(run: (host: any, descriptor: string) => Promise<void>) {
  const host = fixture();
  host.usageReceipts = [];
  const server = await new BrowserControlServer({ logger, getBrowserHost: () => host, getPreferences: () => ({}),
    limits: { enabled: () => true, record: (receipt: any) => { host.usageReceipts.push(receipt); return true; } } }).start();
  const root = mkdtempSync(join(tmpdir(), "42-browser-lease-")), path = join(root, "descriptor.json");
  writeFileSync(path, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39110", control: server.descriptor(), helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" }, createdAt: new Date().toISOString() }), { mode: 0o600 });
  try { await run(host, path); } finally { await new Promise<void>(resolve => server.server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
}
const start = (path: string, traceId: string, conversationKey = key, connectorIdentity?: string, conversationUrl?: string) => notifyLauncherTurn(path, {
  phase: "start", traceId, helperPid: process.pid, conversationKey, connectorIdentity, conversationUrl, leaseFencing: true,
});
test("actual control route fences duplicate starts across QA/Full while independent tabs run", async () => {
  await serverFixture(async (host, path) => {
    const first = await start(path, "qa-trace", key);
    await expect(start(path, "full-trace", key, "Full")).rejects.toBeInstanceOf(LauncherBrowserWriterConflictError);
    await expect(start(path, "qa-trace", key)).rejects.toBeInstanceOf(LauncherBrowserWriterConflictError);
    const independent = await start(path, "other-trace", otherKey, "Full");
    expect(independent.surfaceId).not.toBe(first.surfaceId); expect(host.turnTabs.size).toBe(2);
  });
});
test("same saved conversation with different keys/project slugs is still one writer", async () => {
  await serverFixture(async (host, path) => {
    await start(path, "qa-trace", key, undefined, "https://chatgpt.com/c/shared");
    await expect(start(path, "full-trace", otherKey, "Full", `https://chatgpt.com/g/g-p-${"a".repeat(32)}-title/c/shared`)).rejects.toBeInstanceOf(LauncherBrowserWriterConflictError);
    expect(host.turnTabs.size).toBe(1);
  });
});
test("initialization reserves ownership before its first await; late completion cannot publish a removed tab", async () => {
  const host = fixture(), gate = deferred(); host.initializing = gate.promise;
  const first = host.beginTurn("first-trace", false, process.pid, key, undefined, false, undefined, undefined, true);
  await expect(host.beginTurn("second-trace", false, process.pid, key, "Full")).rejects.toMatchObject({ code: "browser_writer_conflict" });
  host.turnTabs.clear(); gate.resolve();
  await expect(first).rejects.toMatchObject({ code: "browser_writer_conflict" }); expect(host.selectedTabId).toBeUndefined();
});
test("surface rotates on retained same-trace reuse; old/missing fence cannot heartbeat, release, approve, or charge", async () => {
  await serverFixture(async (host, path) => {
    const first = await start(path, "qa-trace");
    await notifyLauncherTurn(path, { phase: "end", traceId: "qa-trace", helperPid: process.pid, surfaceId: first.surfaceId, status: "completed", retain: true });
    const next = await start(path, "qa-trace");
    expect(next.reused).toBe(true); expect(next.surfaceId).not.toBe(first.surfaceId);
    for (const surfaceId of [first.surfaceId, undefined]) {
      for (const activity of [
        { phase: "heartbeat", refreshViewport: true }, { phase: "end", status: "completed" },
        { phase: "approval", pending: true }, { phase: "usage", trackingError: "account-unavailable" },
      ]) await expect(notifyLauncherTurn(path, { ...activity, traceId: "qa-trace", helperPid: process.pid, surfaceId } as any)).rejects.toBeInstanceOf(LauncherBrowserWriterConflictError);
    }
    expect([...host.turnTabs.values()][0].status).toBe("running");
    await notifyLauncherTurn(path, { phase: "heartbeat", traceId: "qa-trace", helperPid: process.pid, surfaceId: next.surfaceId });
    await notifyLauncherTurn(path, { phase: "end", traceId: "qa-trace", helperPid: process.pid, surfaceId: next.surfaceId, status: "completed" });
    expect(host.turnTabs.size).toBe(0);
  });
});
test("worker waits for durable hook and refuses a late send callback after its surface was replaced", async () => {
  await serverFixture(async (host, path) => {
    const gate = deferred(), entered = deferred(); let sends = 0;
    const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: path },
      runBrowserTurn: async (turn: any) => { await turn.onSendActivated(); sends++; return "done"; },
    });
    const running = worker.runExclusive({ traceId: "durable-trace", conversationKey: key, capabilities: { localToolsEnabled: false },
      onSendActivated: async () => { entered.resolve(); await gate.promise; } });
    const checked = running.catch((error: unknown) => error);
    await entered.promise; expect(sends).toBe(0);
    const tab: any = [...host.turnTabs.values()][0]; tab.surfaceId = randomBytes(24).toString("base64url");
    gate.resolve(); expect(await checked).toMatchObject({ code: "browser_writer_conflict", status: 409, retryable: false }); expect(sends).toBe(0); expect(tab.status).toBe("running");
  });
});
test("retained next turn registers its new observation while the prior checkpoint stays fenced", async () => {
  await serverFixture(async (host, path) => {
    Object.assign(host, { profile: "production", partition: "test-partition", observationInstanceId: "host-instance" });
    const url = "https://chatgpt.com/c/retained-observation";
    const first = await start(path, "old-trace", key, undefined, url);
    const tab: any = [...host.turnTabs.values()][0];
    Object.assign(tab.view.webContents, { getURL: () => url, getOrCreateDevToolsTargetId: () => "same-target" });
    const observation = (traceId: string, surfaceId: string) => ({ version: 1,
      identity: { operationId: traceId, executionKey: traceId, roundKey: traceId, threadId: "same-thread", turnId: traceId },
      traceId, host: { pid: process.pid, instanceId: host.observationInstanceId, profile: host.profile, partition: host.partition },
      lease: { helperPid: process.pid, surfaceId, targetId: "same-target" }, conversation: { key, url }, submission: {} });
    const old = observation("old-trace", first.surfaceId!);
    await notifyLauncherTurn(path, { phase: "observe-ready", traceId: "old-trace", helperPid: process.pid,
      surfaceId: first.surfaceId, observation: old } as any);
    expect(tab.observationDigest).toBeString();
    await notifyLauncherTurn(path, { phase: "end", traceId: "old-trace", helperPid: process.pid,
      surfaceId: first.surfaceId, status: "completed", retain: true });
    const next = await start(path, "new-trace", key, undefined, url);
    expect(next.reused).toBe(true);
    expect(tab.observationDigest).toBeUndefined();
    await expect(notifyLauncherTurn(path, { phase: "observe", traceId: "old-trace", helperPid: process.pid,
      surfaceId: first.surfaceId, observation: old } as any)).rejects.toBeInstanceOf(LauncherBrowserWriterConflictError);
    const current = observation("new-trace", next.surfaceId!);
    await notifyLauncherTurn(path, { phase: "observe-ready", traceId: "new-trace", helperPid: process.pid,
      surfaceId: next.surfaceId, observation: current } as any);
    await notifyLauncherTurn(path, { phase: "observe", traceId: "new-trace", helperPid: process.pid,
      surfaceId: next.surfaceId, observation: current } as any);
    expect(host.turnTabs.size).toBe(1);
  });
});
test("multipart and final send callbacks both await the existing durable hook", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const stage = source.slice(source.indexOf("{ onSubmitted: recordStageUsage, onSendActivated: async () => {"), source.indexOf("const acknowledgedResponse ="));
  expect(stage).toContain("await turn.onSendActivated?.()");
  const send = source.slice(source.indexOf("  private async sendAttachedPrompt("), source.indexOf("  private async waitForMultipartAcknowledgement("));
  expect(send.indexOf("await submissionLifecycle?.onSendActivated?.()")).toBeLessThan(send.indexOf("sendButton.click("));
  expect(send).toContain("await submissionLifecycle?.onSubmitted?.()");
});

test("legacy usage without a surface remains valid only for a legacy activation", async () => {
  await serverFixture(async (host, path) => {
    await notifyLauncherTurn(path, { phase: "start", traceId: "legacy-trace", helperPid: process.pid, conversationKey: key });
    await notifyLauncherTurn(path, { phase: "usage", traceId: "legacy-trace", helperPid: process.pid, trackingError: "account-unavailable" });
    expect(host.usageReceipts).toHaveLength(1);
    await notifyLauncherTurn(path, { phase: "end", traceId: "legacy-trace", helperPid: process.pid, status: "completed", retain: true });
    const next = await start(path, "legacy-trace");
    await expect(notifyLauncherTurn(path, { phase: "usage", traceId: "legacy-trace", helperPid: process.pid, trackingError: "account-unavailable" })).rejects.toBeInstanceOf(LauncherBrowserWriterConflictError);
    await notifyLauncherTurn(path, { phase: "usage", traceId: "legacy-trace", helperPid: process.pid, surfaceId: next.surfaceId, trackingError: "account-unavailable" });
    expect(host.usageReceipts).toHaveLength(2);
  });
});

test("five-tab capacity still reports retryable 429 rather than a writer conflict", async () => {
  const gate = deferred();
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome", standardConcurrencyLimit: 5 }, activeRuns: new Map(),
    runExclusive: () => gate.promise.then(() => "done"),
  });
  const turn = (traceId: string) => ({ traceId, capabilities: { localToolsEnabled: false } });
  const running = Array.from({ length: 5 }, (_, i) => worker.run(turn(`capacity-${i}`)));
  try { await expect(worker.run(turn("capacity-exceeded"))).rejects.toMatchObject({ status: 429, code: "concurrency_limit_exceeded", retryable: true }); }
  finally { gate.resolve(); await Promise.all(running); }
});
