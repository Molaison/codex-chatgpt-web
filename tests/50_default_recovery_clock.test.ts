import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHATGPT_RECOVERY_TIME_ALLOWANCE_MS } from "../src/adapters/chatgpt-web/retry-policy";
import { DurableOperation, OperationJournal, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import { ChatGptBrowserWorker, ChatGptBrowserObservationTimeoutError, resolveBrowserConfig, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chromium } from "playwright-core";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

function fixture(startedAt = 1000) {
  mkdirSync(process.env.Q39_TEST_ROOT!, { recursive: true });
  const root = mkdtempSync(join(process.env.Q39_TEST_ROOT!, "default-clock-"));
  const record: OperationRecord = { version: 1, operationId: "op_clock", executionKey: "clock", traceId: "clock_trace",
    requestIds: [], submission: "prepared", generation: "not_started", delivery: "attached", recovery: "none",
    seq: 0, attempt: 1, startedAt, updatedAt: startedAt, rounds: {} };
  const journal = new OperationJournal(root);
  const operation = new DurableOperation(journal, record);
  operation.freezeRecoveryBudget();
  return { root, record, journal, operation };
}

test("unset turnTimeoutMs bounds recovery and leaves healthy generation and running tools outside its clock", async () => {
  const f = fixture();
  try {
    const hoursLater = 1000 + 10 * 60 * 60_000;
    expect(f.record.recoveryBudget!.deadlineAt).toBeUndefined();
    expect(f.operation.recoveryAvailable(hoursLater)).toBe(true);
    f.operation.reserveRecovery("transport_retry", hoursLater);
    expect(f.operation.recoveryState()).toEqual({ epoch: 1, deadlineAt: hoursLater + CHATGPT_RECOVERY_TIME_ALLOWANCE_MS });
    f.operation.confirmRecovery(1, hoursLater + 500);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = {};
    let originalExecutions = 0;
    worker.runExclusive = async () => { originalExecutions++; return "original long generation and running handle retained"; };
    expect(await worker.runWithRecovery({ traceId: "normal", recoveryState: f.operation.recoveryState() })).toContain("retained");
    expect(originalExecutions).toBe(1);
    expect(f.record.recoveryBudget!.clock!.spentMs).toBe(500);
    expect(f.operation.recoveryState().deadlineAt).toBeUndefined();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("mixed and nested recovery paths share the remaining time and never double-charge overlapping intervals", () => {
  const f = fixture();
  try {
    f.operation.reserveRecovery("transport_retry", 2000);
    f.operation.reserveRecovery("context_recovery", 2400);
    expect(f.operation.recoveryState().epoch).toBe(1);
    expect(f.operation.recoveryState().deadlineAt).toBe(2000 + CHATGPT_RECOVERY_TIME_ALLOWANCE_MS);
    f.operation.confirmRecovery(1, 3000);
    expect(f.record.recoveryBudget!.clock!.spentMs).toBe(1000);
    const later = 100_000_000;
    f.operation.reserveRecovery("observer_reconnect", later);
    expect(f.operation.recoveryState()).toEqual({ epoch: 2, deadlineAt: later + CHATGPT_RECOVERY_TIME_ALLOWANCE_MS - 1000 });
    expect(() => f.operation.confirmRecovery(1, later + 50)).toThrow("episode");
    f.operation.confirmRecovery(2, later + 100);
    expect(f.record.recoveryBudget!.clock!.spentMs).toBe(1100);
    expect(f.record.recoveryBudget!.used).toBe(3);
    expect(f.operation.recoveryState().deadlineAt).toBeUndefined();
    expect(() => f.operation.reserveRecovery("http_retry", later + 200)).toThrow("exhausted");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("restart preserves active default expiry and expired recovery cannot activate Send or confirm success", () => {
  const f = fixture();
  try {
    f.operation.reserveRecovery("http_retry", 2000);
    const deadline = f.operation.recoveryState().deadlineAt!;
    const restored = new DurableOperation(f.journal, f.journal.read<OperationRecord>("clock")!);
    restored.freezeRecoveryBudget(9_999_999);
    expect(restored.recoveryState().deadlineAt).toBe(deadline);
    expect(restored.recoveryAvailable(deadline)).toBe(false);
    expect(() => restored.reserveRecovery("observer_reconnect", deadline)).toThrow("exhausted");
    expect(() => restored.confirmRecovery(1, deadline)).toThrow("episode");
    expect(() => restored.beforeSend()).toThrow("deadline");
    expect(restored.record.submission).toBe("prepared");
    expect(restored.record.recoveryBudget!.used).toBe(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a legacy spent count without timing evidence cannot replenish default recovery", () => {
  const f = fixture();
  try {
    f.record.recoveryBudget!.used = 1;
    delete f.record.recoveryBudget!.clock;
    f.operation.freezeRecoveryBudget();
    expect(f.operation.recoveryAvailable()).toBe(false);
    expect(() => f.operation.reserveRecovery("transport_retry")).toThrow("exhausted");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("real helper IPC preserves selected multipart input and acknowledges the exact recovery epoch", async () => {
  const f = fixture(Date.now());
  const helper = join(f.root, "helper.ts"), descriptor = join(f.root, "launcher.json");
  const workerModule = new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href;
  const helperModule = new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href;
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(workerModule)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      await turn.onPreparedSelected(false);
      const original = await turn.prepare();
      if (turn.recoveryState.deadlineAt !== undefined) throw new Error("Healthy execution has a recovery deadline");
      if (!await turn.authorizeRecovery("transport_retry")) throw new Error("Denied original recovery");
      if (turn.recoveryState.epoch !== 1 || !turn.recoveryState.deadlineAt) throw new Error("Recovery grant lost");
      if ((await turn.prepare()).text !== original.text) throw new Error("Selected input replaced");
      if (!await turn.authorizeRecovery("recovery_verified", 1)) throw new Error("Verified recovery rejected");
      if (turn.recoveryState.deadlineAt !== undefined) throw new Error("Normal generation still charged");
      if (!await turn.authorizeRecovery("transport_retry")) throw new Error("Second recovery denied");
      if (turn.recoveryState.epoch !== 2) throw new Error("Recovery epoch reused");
      if ((await turn.prepare()).multipart.parts.length !== 6) throw new Error("Accepted parts lost");
      return "same original submission";
    };
    await import(${JSON.stringify(helperModule)});
  `);
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39110", control: { endpoint: "http://127.0.0.1:39111", token: "t".repeat(64) },
    helper: { executable: process.execPath, script: helper }, partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "s".repeat(32), surfaceTargets: { ["s".repeat(32)]: "target" }, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient(resolveBrowserConfig({ adapter: "chatgpt-web", baseUrl: "browser://clock-fixture",
    chatgptWeb: { accountId: "account2", browserHost: "launcher", browserHostDescriptorPath: descriptor, browserHelperScriptPath: helper, useSavedChats: false } }));
  const state = f.operation.recoveryState();
  let preparations = 0;
  const signals: Array<string | undefined> = [];
  const originalSend = (client as any).send.bind(client);
  let injected = false;
  (client as any).send = async (message: any) => {
    if (message.type === "recovery_fence_ack" && !injected) {
      injected = true;
      await originalSend({ ...message, requestId: message.requestId - 1 });
      await new Promise(resolve => setTimeout(resolve, 15));
      expect(signals).toEqual(["transport_retry"]);
    }
    return originalSend(message);
  };
  const turn: BrowserTurn = { traceId: "clock_trace", modelId: "gpt-5.6-sol", recoveryState: state,
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => { preparations++; return { text: "original question", images: [], multipart: { parts: ["1", "2", "3", "4", "5", "6"], commit: "original question" }, release() {} }; },
    authorizeRecovery: async (reason, epoch) => {
      signals.push(reason);
      if (reason === "transport_retry") f.operation.reserveRecovery("transport_retry");
      else if (reason === "recovery_verified" && epoch !== undefined) f.operation.confirmRecovery(epoch);
      else return false;
      delete state.deadlineAt; Object.assign(state, f.operation.recoveryState()); return true;
    }, onTextDelta() {} };
  try {
    expect(await client.run(turn)).toBe("same original submission");
    expect(preparations).toBe(1);
    expect(f.record.recoveryBudget!.used).toBe(2);
    expect(f.operation.recoveryState().epoch).toBe(2);
    expect(f.record.recoveryBudget!.clock!.spentMs).toBeGreaterThanOrEqual(0);
  } finally { await client.close(); rmSync(f.root, { recursive: true, force: true }); }
}, 15000);

function movingDeadline() {
  let at: number | undefined;
  const listeners = new Set<() => void>();
  const read = Object.assign(() => at, { subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } });
  return { read, listeners, begin() { at = Date.now() + 35; for (const notify of listeners) notify(); } };
}

test("recovery beginning inside a normal stage rearms its timer and cleans its subscription", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const clock = movingDeadline();
  let aborted = false;
  await expect(worker.runStage("dynamic", "fixture", 30_000, (signal: AbortSignal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    clock.begin();
    return new Promise(() => {});
  }, undefined, false, clock.read)).rejects.toThrow("timed out");
  expect(aborted).toBe(true);
  expect(clock.listeners.size).toBe(0);
}, 2000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("assistant observation sees a recovery clock first granted inside its rebind", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="markdown"></div>');
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.submissionDomState = async () => { throw new ChatGptBrowserObservationTimeoutError(1); };
    const clock = movingDeadline();
    let rebinds = 0;
    await expect(worker.waitForNewAssistantTurn(page, { initialTurnIdentities: [], domCache: {} }, clock.read,
      undefined, undefined, 0, undefined, async () => {
        rebinds++;
        clock.begin();
        return new Promise(() => {});
      }, { active: () => true, progress() {} })).rejects.toMatchObject({ code: "chatgpt_recovery_budget_exhausted", retryable: false });
    expect(rebinds).toBe(1);
    expect(clock.listeners.size).toBe(0);
  } finally { await browser.close(); }
}, 10000);

test("the outer launcher path retains an expired recovery and preserves explicit cancellation", async () => {
  for (const expired of [true, false]) {
    const f = fixture(Date.now());
    const phases: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const activity = await request.json() as { phase: string };
      phases.push(activity.phase);
      return Response.json(activity.phase === "start"
        ? { surfaceId: "s".repeat(32), reused: false, connectorBound: false }
        : { cancelledByUser: false });
    } });
    const descriptor = join(f.root, "control.json");
    writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
      endpoint: "http://127.0.0.1:39110", control: { endpoint: String(server.url).replace(/\/$/, ""), token: "t".repeat(64) },
      helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "s".repeat(32), surfaceTargets: { ["s".repeat(32)]: "target" }, createdAt: new Date().toISOString() }), { mode: 0o600 });
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { browserHost: "launcher", browserHostDescriptorPath: descriptor, useSavedChats: false, appName: "Codex Native2" };
    worker.runBrowserTurn = async () => {
      if (expired) throw new ChatGptWebAdapterError("Recovery expired with original execution retained", {
        status: 503, errorType: "server_error", code: "chatgpt_recovery_budget_exhausted", retryable: false,
      });
      throw new DOMException("Explicit caller cancellation", "AbortError");
    };
    try {
      await expect(worker.runExclusive({ traceId: "outer_clock", modelId: "gpt-5.6-sol",
        capabilities: { localToolsEnabled: false }, prepare: async () => ({ text: "original", images: [], release() {} }), onTextDelta() {} })).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(phases.filter(phase => phase === "start")).toHaveLength(1);
      expect(phases.filter(phase => phase === "end")).toHaveLength(expired ? 0 : 1);
    } finally { server.stop(true); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("a core budget refusal detaches the helper and preserves the original typed failure", async () => {
  const client = new LauncherBrowserHelperClient({ appName: "Codex Native2", browserHost: "launcher",
    browserHostDescriptorPath: "/private/unused.json", storageStatePath: "/private/state.json", headed: true,
    autoApproveToolCalls: false, useSavedChats: false } as any);
  const internal = client as any;
  const child = {};
  internal.child = child;
  const frames: Array<Record<string, unknown>> = [];
  internal.send = async (frame: Record<string, unknown>) => { frames.push(frame); };
  const failure = new ChatGptWebAdapterError("Shared recovery exhausted", {
    status: 503, errorType: "server_error", code: "chatgpt_recovery_budget_exhausted", retryable: false,
  });
  const result = new Promise((resolve, reject) => internal.pending.set("retained", {
    turn: { traceId: "retained", authorizeRecovery: async () => { throw failure; } }, resolve, reject,
  }));
  internal.handleLine(child, JSON.stringify({ type: "event", id: "retained", event: "recovery_fence", requestId: 1, reason: "transport_retry" }));
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(frames).toEqual([{ type: "abort", id: "retained", reason: "recovery_budget_retained" }]);
  internal.handleLine(child, JSON.stringify({ type: "error", id: "retained", message: "Observer detached" }));
  await expect(result).rejects.toBe(failure);
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("default expiry detaches multipart observation without pressing Stop or resending a stage", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent('<button aria-label="Stop generating" onkeydown="window.stopPresses=(window.stopPresses||0)+1"></button><section id="answer"></section>');
    const clock = movingDeadline();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    let snapshots = 0;
    worker.responseDomSnapshot = async () => {
      if (snapshots++ === 0) clock.begin();
      return { responsePresent: true, stoppedThinkingVisible: false, visibleText: "", fullHtml: "", traceBlocks: [], images: [], completionActionVisible: false };
    };
    await expect(worker.waitForMultipartAcknowledgement(page, { identity: "original", locator: page.locator("#answer") },
      {}, { acknowledgement: "ORIGINAL_ACK" }, clock.read)).rejects.toMatchObject({ code: "chatgpt_recovery_budget_exhausted" });
    await new Promise(resolve => setTimeout(resolve, 140));
    expect(await page.evaluate(() => (window as any).stopPresses ?? 0)).toBe(0);
    expect(page.isClosed()).toBe(false);
    expect(clock.listeners.size).toBe(0);
  } finally { await browser.close(); }
}, 10000);
