import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as launcherHost from "../src/launcher-browser-host";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

// CPU-only reproduction. The real accepted-turn observation loop, DOM snapshot
// handling, Markdown buffer and completion tracker run against a fake leased
// transport. No browser, remote endpoint, credentials or model are accessed.
test.each(["recovered", "exhausted", "cancelled", "ambiguous", "missing", "pending"] as const)(
  "MOL185 accepted-response read recovery preserves one Send: %s", async scenario => {
  const root = mkdtempSync(join(tmpdir(), "mol185-observation-proof-"));
  const startedAt = performance.now();
  let failureAt: number | undefined;
  let reboundAt: number | undefined;
  let recovered = false;
  let sends = 0;
  let submitted = 0;
  let snapshotReads = 0;
  let failedReads = 0;
  let countReads = 0;
  const abort = new AbortController();
  let rebinds = 0;
  let released = false;
  const stages: string[] = [];
  const deltas: string[] = [];
  const absent: any = {
    filter() { return this; }, last() { return this; },
    isVisible: async () => false, count: async () => 0,
    evaluateAll: async () => [],
  };
  const snapshot = {
    responsePresent: true, downloadableFiles: [], images: [], pendingImages: false,
    visibleText: "Prefix\n\nRecovered answer", fullHtml: "<p>Prefix</p><p>Recovered answer</p>",
    markdownSegments: [
      { key: "prefix", tag: "p", html: "<p>Prefix</p>", text: "Prefix", streamable: true },
      { key: "answer", tag: "p", html: "<p>Recovered answer</p>", text: "Recovered answer", streamable: true },
    ],
    richWidgetSources: [], completionActionVisible: true, stoppedThinkingVisible: false, traceBlocks: [],
  };
  let page: any;
  const assistant: any = {
    page: () => page,
    count: async () => {
      countReads++;
      // This stop condition depends on observed attempts, not scheduler speed.
      if (failedReads >= 4 && rebinds === 0 && scenario !== "missing") {
        throw new Error("fixture stopped after four unreadable-response probes without recovery");
      }
      return scenario === "ambiguous" ? 2 : scenario === "missing" && failedReads === 1 ? 0 : 1;
    },
    getByText: () => absent, getByTestId: () => absent,
    evaluate: async () => {
      snapshotReads++;
      if ((scenario === "recovered" || scenario === "pending") && !deltas.length) {
        return { key: "same-owned-response:prefix", snapshot: {
          ...snapshot, visibleText: "Prefix", fullHtml: "<p>Prefix</p>",
          markdownSegments: snapshot.markdownSegments.slice(0, 1), completionActionVisible: false,
        } };
      }
      if (scenario === "pending" && !recovered) {
        failureAt ??= performance.now();
        failedReads++;
        return new Promise(() => {});
      }
      if (scenario === "cancelled") abort.abort();
      if (!recovered && !(scenario === "missing" && failedReads > 0)) {
        failureAt ??= performance.now();
        failedReads++;
        throw Object.assign(new Error("Synthetic renderer read timeout"), { name: "TimeoutError" });
      }
      return { key: "same-owned-response:1", snapshot };
    },
  };
  page = Object.assign(new EventEmitter(), {
    isClosed: () => false, mainFrame: () => ({}),
    evaluate: async () => ({ width: 1280, height: 900 }),
    waitForFunction: async () => {},
    locator: (selector: string) => selector.startsWith("[data-turn-id=") ? assistant : absent,
  });
  const notify = spyOn(launcherHost, "notifyLauncherTurn").mockImplementation(async () => ({} as any));
  const connect = spyOn(launcherHost, "connectLauncherBrowserHost").mockImplementation(async (_path, _timeout, surface) => {
    expect(surface).toBe("mol185-owned-surface");
    rebinds++;
    reboundAt = performance.now();
    if (scenario === "recovered" || scenario === "pending") expect(deltas.join("")).toBe("Prefix");
    recovered = scenario !== "exhausted";
    return { browser: { close: async () => {} }, page } as any;
  });
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "fixture", browserDiagnosticsPath: root, browserHostDescriptorPath: "test-only-not-a-file", turnTimeoutMs: 15_000 },
    runStage: async (_trace: string, name: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stages.push(name);
      return action(new AbortController().signal);
    },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async () => resolveChatGptWebModelMode("gpt-5.6-sol", "high", capabilities),
    assertSelectedEffort: async () => {},
    captureSubmissionBaseline: async () => ({ initialTurnIdentities: [], domCache: {} }),
    submissionDomState: async () => ({ turnIdentities: [], userIdentities: [], responseIdentities: [] }),
    attachPromptWithCompactionRetry: async () => {},
    attachFiles: async () => {},
    sendAttachedPrompt: async (_page: unknown, _baseline: unknown, _capture: unknown, _signal: unknown, _progress: unknown,
      lifecycle: { onSendActivated(): Promise<void>; onSubmitted(): Promise<void> }) => {
      sends++;
      await lifecycle.onSendActivated();
      await lifecycle.onSubmitted();
      return "assistant_turn";
    },
    waitForNewAssistantTurn: async () => ({ identity: "conversation-turn-assistant", locator: assistant, acceptedTurnIdentities: [] }),
  });
  try {
    const outcome = await worker.runBrowserTurn({
      abortSignal: abort.signal, traceId: "mol185_observation_proof", modelId: "gpt-5.6-sol", reasoning: "high", capabilities,
      prepare: async () => ({ text: "Synthetic request", images: [], release: () => { released = true; } }),
      onSubmitted: () => { submitted++; }, onTextDelta: (text: string) => deltas.push(text),
    }, "mol185-owned-surface", page).then((answer: string) => ({ answer }), (error: Error) => ({ error: error.message, name: error.name }));
    const finishedAt = performance.now();
    console.info("MOL185_RESPONSE_OBSERVATION_PROOF", JSON.stringify({
      scenario, outcome, sends, submitted, snapshotReads, failedReads, countReads, rebinds, released, stages,
      totalMs: Math.round(finishedAt - startedAt),
      ...(failureAt === undefined ? {} : { faultToTerminalMs: Math.round(finishedAt - failureAt) }),
      ...(failureAt === undefined || reboundAt === undefined ? {} : { faultToRebindMs: Math.round(reboundAt - failureAt) }),
    }));
    if (scenario === "recovered" || scenario === "missing" || scenario === "pending") {
      expect(outcome).toEqual({ answer: "Prefix\n\nRecovered answer" });
      expect(deltas.join("")).toBe("Prefix\n\nRecovered answer");
      expect(rebinds).toBe(scenario === "missing" ? 0 : 1);
    } else if (scenario === "exhausted") {
      expect(outcome).toMatchObject({ error: "ChatGPT browser DOM remained unresponsive after 2 same-page rebinds" });
      expect(rebinds).toBe(2);
      expect(failedReads).toBe(3);
    } else if (scenario === "cancelled") {
      expect(outcome).toMatchObject({ name: "AbortError" });
      expect(rebinds).toBe(0);
    } else {
      expect(outcome).toMatchObject({ error: "ChatGPT exposed 2 DOM nodes for the bound assistant turn" });
      expect(rebinds).toBe(0);
    }
    expect(sends).toBe(1);
    expect(submitted).toBe(1);
    expect(released).toBeTrue();
  } finally {
    notify.mockRestore();
    connect.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
