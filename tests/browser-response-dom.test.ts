import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Locator, Page } from "playwright-core";
import { chatGptAttachmentNameMatches, chatGptCompletionStableMs, waitForOperationalChatGptViewport } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_SEND_BUTTON_SELECTOR } from "../src/chatgpt-session";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, ChatGptTurnDomHealthTracker, chatGptTurnIsComplete, ChatGptVisibleTraceTracker, CHATGPT_COMPLETION_SETTLE_MS } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";
import { parseChatGptChartWidgets } from "../src/adapters/chatgpt-web/rich-widget";

test.each([
  ["a.pdf", "a.pdf", true],
  ["a.pdf", "a(1).pdf", true],
  ["a.pdf", "a(12).pdf", true],
  ["a.pdf", "a(1).txt", false],
  ["a.pdf", "xa(1).pdf", false],
  ["a.pdf", "a(1)(2).pdf", false],
  ["a.pdf", "a (1).pdf", false],
  ["a.pdf", "a(1).pdf(2)", false],
  ["a.pdf", "a(-1).pdf", false],
  ["a.pdf", "a().pdf", false],
  ["a.pdf", "a(1).pdf\n", false],
  ["a.pdf", "a(1).PDF", false],
  ["a .pdf", "a (1).pdf", true],
  ["a .pdf", "a(1).pdf", false],
  ["a[1]+.pdf", "a[1]+(12).pdf", true],
  ["a[1]+.pdf", "a1(12).pdf", false],
  ["a.tar.gz", "a.tar(1).gz", true],
  ["a.tar.gz", "a(1).tar.gz", false],
  ["a(1).pdf", "a(1)(2).pdf", true],
  ["README", "README(1)", true],
])("attachment name %s matches %s: %s", (staged, observed, expected) => {
  expect(chatGptAttachmentNameMatches(staged, observed)).toBe(expected);
});

// Exercise attachFiles itself against role/name queries over a composer DOM and owned upload events.
async function attachmentChipFixture(role: "group" | "button", observed: string, filenames = ["a.pdf"]) {
  const { createWindow } = require("@mixmark-io/domino");
  const document: Document = createWindow('<form><input type="file" multiple><button data-testid="send-button"></button></form>').document;
  const chip = document.createElement(role === "button" ? "button" : "div");
  chip.setAttribute("role", role);
  chip.setAttribute("aria-label", observed);
  chip.className = "composer-attachment-surface";
  document.querySelector("form")!.appendChild(chip);
  const calls = { sendEnabled: 0, uploaded: [] as string[], disposed: false, waited: [] as string[] };
  const elements = Array.from(document.querySelector("form")!.children);
  type ChipLocator = {
    matches(element: Element): boolean;
    or(other: ChipLocator): ChipLocator;
    and(other: ChipLocator): ChipLocator;
    waitFor(options: { state: string; timeout: number }): Promise<void>;
  };
  function locator(matches: (element: Element) => boolean): ChipLocator {
    return {
      or(other: ChipLocator): ChipLocator {
        return locator(element => matches(element) || other.matches(element));
      },
      and(other: ChipLocator): ChipLocator {
        return locator(element => matches(element) && other.matches(element));
      },
      matches,
      async waitFor(options: { state: string; timeout: number }) {
        expect(options).toEqual({ state: "visible", timeout: 300_000 });
        const found = elements.filter(matches);
        if (found.length !== 1) throw new Error("attachment chip not found");
        calls.waited.push(found[0]!.getAttribute("aria-label")!);
      },
    };
  }
  let uploadEvent: (event: { method: string; params: unknown }) => void = () => {};
  const form = {
    getByRole(queryRole: string, options: { name: string | RegExp; exact?: boolean }) {
      return locator(element => {
        const elementRole = element.getAttribute("role") ?? (element.tagName === "BUTTON" ? "button" : "");
        const name = element.getAttribute("aria-label") ?? element.textContent ?? "";
        return elementRole === queryRole && (typeof options.name === "string" ? name === options.name : options.name.test(name));
      });
    },
    locator(selector: string) {
      if (selector.startsWith("input")) return {
        waitFor: async (options: unknown) => expect(options).toEqual({ state: "attached", timeout: 20_000 }),
        setInputFiles: async (files: Array<{ name: string }>) => {
          calls.uploaded = files.map(file => file.name);
          for (const file of files) {
            uploadEvent({ method: "Network.requestWillBeSent", params: { frameId: "owned", requestId: file.name,
              request: { method: "POST", url: "https://chatgpt.com/backend-api/files/process_upload_stream", postData: JSON.stringify({ file_name: file.name }) } } });
            uploadEvent({ method: "Network.responseReceived", params: { requestId: file.name, response: { status: 200 } } });
          }
        },
      };
      if (selector === CHATGPT_SEND_BUTTON_SELECTOR) return { isEnabled: async () => { calls.sendEnabled++; return true; } };
      return locator(element => element.matches(selector));
    },
  };
  const page = {
    url: () => "https://chatgpt.com/",
    context: () => ({ newCDPSession: async () => ({
      on: (_event: string, listener: typeof uploadEvent) => { uploadEvent = listener; },
      off: () => {}, detach: async () => { calls.disposed = true; },
      send: async (method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "owned" } } }
        : method === "Network.streamResourceContent" ? { bufferedData: Buffer.from('{"event":"file.processing.completed"}\n').toString("base64") } : {},
    }) }),
    locator: () => ({ allInnerTexts: async () => [] }),
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;
  const result = attachFiles.call({ activeComposer: async () => ({ locator: () => form }) }, page, {
    images: [], files: filenames.map(filename => ({ filename, fileData: Buffer.from("PDF fixture").toString("base64") })),
  });
  return { result, calls };
}

for (const role of ["group", "button"] as const) {
  test.each(["a.pdf", "a(1).pdf", "a(12).pdf"])(`attachFiles accepts ${role} chip %s and reaches send readiness`, async observed => {
    const { result, calls } = await attachmentChipFixture(role, observed);
    await result;
    expect(calls).toEqual({ uploaded: ["a.pdf"], waited: [observed], sendEnabled: 1, disposed: true });
  });
  test.each(["a(1).txt", "xa(1).pdf", "a(1)(2).pdf", "a (1).pdf"])(`attachFiles rejects foreign ${role} chip %s before send`, async observed => {
    const { result, calls } = await attachmentChipFixture(role, observed);
    await expect(result).rejects.toThrow("ChatGPT did not accept all prompt attachments");
    expect(calls.sendEnabled).toBe(0);
    expect(calls.disposed).toBeTrue();
  });
}

test("attachFiles still requires every file chip before send readiness", async () => {
  const { result, calls } = await attachmentChipFixture("group", "a(1).pdf", ["a.pdf", "b.pdf"]);
  await expect(result).rejects.toThrow("ChatGPT did not accept all prompt attachments");
  expect(calls.uploaded).toEqual(["a.pdf", "b.pdf"]);
  expect(calls.sendEnabled).toBe(0);
  expect(calls.disposed).toBeTrue();
});

function viewportPage(initial = { width: 1280, height: 900 }) {
  const events = new EventEmitter();
  const native = new EventEmitter();
  const mainFrame = {};
  const counts = { read: 0, apply: 0, wait: 0, subscribe: 0 };
  const state = { viewport: initial, configured: null as null | { width: number; height: number },
    applyError: undefined as Error | undefined, waitError: undefined as Error | undefined,
    observerError: false, duringSubscribe: undefined as (() => void) | undefined,
    duringRead: undefined as (() => void) | undefined,
    duringWait: undefined as (() => void) | undefined };
  const session = Object.assign(native, {
    send: async (method: string) => {
      expect(method).toBe("Page.enable");
      counts.subscribe++;
      state.duringSubscribe?.();
      if (state.observerError) throw new Error("CDP unavailable");
    },
    detach: async () => {},
  });
  const page = Object.assign(events, {
    mainFrame: () => mainFrame,
    context: () => ({ newCDPSession: async () => session }),
    viewportSize: () => state.configured,
    evaluate: async () => { counts.read++; const result = state.viewport; state.duringRead?.(); return result; },
    setViewportSize: async (size: { width: number; height: number }) => {
      counts.apply++;
      if (state.applyError) throw state.applyError;
      state.configured = size;
      state.viewport = size;
      native.emit("Page.frameResized");
    },
    waitForFunction: async (predicate: Function, size: unknown, options: unknown) => {
      counts.wait++;
      expect(options).toEqual({ polling: 25, timeout: 10_000 });
      if (state.waitError) throw state.waitError;
      expect(runInContext(`(${predicate.toString()})(size)`, createContext({
        innerWidth: state.viewport.width, innerHeight: state.viewport.height, size,
      }))).toBeTrue();
      state.duringWait?.();
    },
  }) as unknown as Page;
  return { page, counts, state, native, events, mainFrame };
}

test("operational viewport proof eliminates all subsequent document round trips", async () => {
  const fixture = viewportPage();
  expect((await waitForOperationalChatGptViewport(fixture.page)).cacheHit).toBeFalse();
  for (let step = 0; step < 3; step++) {
    expect(await waitForOperationalChatGptViewport(fixture.page)).toEqual({
      readMs: 0, applyMs: 0, waitMs: 0, applied: false, cacheHit: true,
      readCount: 0, applyCount: 0, waitCount: 0,
    });
  }
  expect(fixture.counts).toEqual({ read: 1, apply: 0, wait: 0, subscribe: 1 });
});

test("repaired viewport is reused without duplicate resize or wait", async () => {
  const fixture = viewportPage({ width: 0, height: 0 });
  expect((await waitForOperationalChatGptViewport(fixture.page)).applied).toBeTrue();
  expect((await waitForOperationalChatGptViewport(fixture.page)).cacheHit).toBeTrue();
  expect(fixture.counts).toEqual({ read: 1, apply: 1, wait: 1, subscribe: 1 });
});

test("main-frame navigation including same-URL reload invalidates viewport proof", async () => {
  const fixture = viewportPage();
  await waitForOperationalChatGptViewport(fixture.page);
  fixture.events.emit("framenavigated", {}); // An iframe does not change this document.
  expect((await waitForOperationalChatGptViewport(fixture.page)).cacheHit).toBeTrue();
  fixture.state.viewport = { width: 0, height: 0 };
  fixture.events.emit("framenavigated", fixture.mainFrame);
  expect((await waitForOperationalChatGptViewport(fixture.page)).applied).toBeTrue();
  expect(fixture.counts).toEqual({ read: 2, apply: 1, wait: 1, subscribe: 1 });
});

test("native resize and renderer swap invalidate viewport proof", async () => {
  for (const event of ["Page.frameResized", "Page.frameStartedLoading", "Page.frameNavigated", "Page.frameDetached", "crash"]) {
    const fixture = viewportPage();
    await waitForOperationalChatGptViewport(fixture.page);
    fixture.state.viewport = { width: 1, height: 1 };
    if (event === "crash") fixture.events.emit(event);
    else fixture.native.emit(event);
    expect((await waitForOperationalChatGptViewport(fixture.page)).applied).toBeTrue();
    expect(fixture.counts.apply).toBe(1);
  }
});

test("configured size changes are checked even before native resize arrives", async () => {
  const fixture = viewportPage();
  await waitForOperationalChatGptViewport(fixture.page);
  fixture.state.configured = { width: 200, height: 100 };
  fixture.state.viewport = fixture.state.configured;
  expect((await waitForOperationalChatGptViewport(fixture.page)).applied).toBeTrue();
  expect((await waitForOperationalChatGptViewport(fixture.page)).cacheHit).toBeTrue();
});

test("viewport set failures propagate and cannot populate the cache", async () => {
  const fixture = viewportPage({ width: 0, height: 0 });
  fixture.state.applyError = new Error("resize failed");
  await expect(waitForOperationalChatGptViewport(fixture.page)).rejects.toThrow("resize failed");
  fixture.state.applyError = undefined;
  expect((await waitForOperationalChatGptViewport(fixture.page)).applied).toBeTrue();
  expect(fixture.counts).toEqual({ read: 2, apply: 2, wait: 1, subscribe: 1 });
});

test("failed viewport verification keeps its error and is retried after recovery", async () => {
  const fixture = viewportPage({ width: 0, height: 0 });
  fixture.state.waitError = new Error("still hidden");
  await expect(waitForOperationalChatGptViewport(fixture.page)).rejects.toThrow("operational viewport: still hidden");
  fixture.state.waitError = undefined;
  fixture.state.viewport = { width: 0, height: 0 };
  expect((await waitForOperationalChatGptViewport(fixture.page)).applied).toBeTrue();
  expect(fixture.counts.wait).toBe(2);
});

test("navigation racing a viewport read cannot bless the previous document", async () => {
  const fixture = viewportPage();
  fixture.state.duringRead = () => {
    fixture.state.duringRead = undefined;
    fixture.state.viewport = { width: 0, height: 0 };
    fixture.events.emit("framenavigated", fixture.mainFrame);
  };
  const timing = await waitForOperationalChatGptViewport(fixture.page);
  expect(timing.applied).toBeTrue();
  expect([timing.readCount, timing.applyCount, timing.waitCount]).toEqual([2, 1, 1]);
  expect(fixture.counts.read).toBe(2);
});

test("navigation racing a viewport wait cannot bless the previous document", async () => {
  const fixture = viewportPage({ width: 0, height: 0 });
  fixture.state.duringWait = () => {
    fixture.state.duringWait = undefined;
    fixture.state.viewport = { width: 0, height: 0 };
    fixture.events.emit("framenavigated", fixture.mainFrame);
  };
  const timing = await waitForOperationalChatGptViewport(fixture.page);
  expect([timing.readCount, timing.applyCount, timing.waitCount]).toEqual([2, 2, 2]);
  expect(fixture.counts.apply).toBe(2);
  expect((await waitForOperationalChatGptViewport(fixture.page)).cacheHit).toBeTrue();
});

test("observer failure or disconnect falls back to page verification every time", async () => {
  for (const failedSetup of [true, false]) {
    const fixture = viewportPage();
    fixture.state.observerError = failedSetup;
    await waitForOperationalChatGptViewport(fixture.page);
    if (!failedSetup) fixture.native.emit("close");
    await waitForOperationalChatGptViewport(fixture.page);
    expect(fixture.counts.read).toBe(2);
  }
});

test("viewport observer closing during subscription cannot enable stale cache reuse", async () => {
  const fixture = viewportPage();
  fixture.state.duringSubscribe = () => fixture.native.emit("close");
  await waitForOperationalChatGptViewport(fixture.page);
  expect((await waitForOperationalChatGptViewport(fixture.page)).cacheHit).toBeFalse();
  expect(fixture.counts.read).toBe(2);
});

test("aborted viewport cache hits preserve cancellation", async () => {
  const fixture = viewportPage();
  await waitForOperationalChatGptViewport(fixture.page);
  const controller = new AbortController();
  controller.abort();
  await expect(waitForOperationalChatGptViewport(fixture.page, controller.signal)).rejects.toHaveProperty("name", "AbortError");
});

test("native viewport bounds and emulation are applied once until size or document changes", () => {
  // Load the real host with an inert Electron import; no window, network or model.
  const require = createRequire(import.meta.url);
  const hostPath = require.resolve("../launcher/electron/browser-host.cjs");
  const hostRequire = createRequire(hostPath);
  const hostModule = { exports: {} as { BrowserHost?: { prototype: Record<string, Function> } } };
  new Function("require", "module", "exports", readFileSync(hostPath, "utf8"))(
    (name: string) => name === "electron" ? {} : hostRequire(name), hostModule, hostModule.exports,
  );
  const prototype = hostModule.exports.BrowserHost!.prototype;
  const calls = { bounds: 0, emulation: 0 };
  let actual = { x: 900, y: 700, width: 800, height: 600 };
  const view = {
    getBounds: () => actual,
    setBounds: (bounds: typeof actual) => { calls.bounds++; actual = { ...bounds }; },
    setVisible: () => {},
    webContents: { enableDeviceEmulation: () => { calls.emulation++; } },
  };
  const host = { bounds: { x: 0, y: 0, width: 800, height: 600 },
    hiddenTurnBounds: () => ({ x: 900, y: 700, width: host.bounds.width, height: host.bounds.height }),
    enableBrowserViewport: prototype.enableBrowserViewport };
  const tab = { view, rendererReady: true, status: "running", interactionMode: "automatic",
    deviceEmulationDirty: true, deviceEmulationViewport: null };
  prototype.presentTurnView!.call(host, tab, false);
  prototype.presentTurnView!.call(host, tab, false);
  expect(calls).toEqual({ bounds: 0, emulation: 1 });
  host.bounds.width = 900;
  prototype.presentTurnView!.call(host, tab, false);
  prototype.presentTurnView!.call(host, tab, false);
  expect(calls).toEqual({ bounds: 1, emulation: 2 });
  tab.deviceEmulationDirty = true; // Navigation/renderer replacement, same dimensions.
  prototype.presentTurnView!.call(host, tab, false);
  expect(calls).toEqual({ bounds: 1, emulation: 3 });
  prototype.presentTurnView!.call(host, tab, true); // Position is part of native bounds.
  expect(calls).toEqual({ bounds: 2, emulation: 3 });

  tab.deviceEmulationDirty = true;
  const emulate = view.webContents.enableDeviceEmulation;
  view.webContents.enableDeviceEmulation = () => { throw new Error("native emulation failed"); };
  expect(() => prototype.presentTurnView!.call(host, tab, true)).toThrow("native emulation failed");
  expect(tab.deviceEmulationDirty).toBeTrue();
  view.webContents.enableDeviceEmulation = emulate;
  prototype.presentTurnView!.call(host, tab, true);
  expect(calls.emulation).toBe(4);

  const setBounds = view.setBounds;
  host.bounds.width = 1000;
  view.setBounds = () => { throw new Error("native bounds failed"); };
  expect(() => prototype.presentTurnView!.call(host, tab, true)).toThrow("native bounds failed");
  view.setBounds = setBounds;
  prototype.presentTurnView!.call(host, tab, true);
  expect(calls).toEqual({ bounds: 3, emulation: 5 });
});

test("operational viewport skips resizing at the minimum and above", async () => {
  for (const viewport of [{ width: 320, height: 240 }, { width: 1280, height: 900 }]) {
    const page = {
      evaluate: async () => viewport,
      setViewportSize: async () => { throw new Error("unexpected resize"); },
      waitForFunction: async () => { throw new Error("unexpected wait"); },
    } as unknown as Page;
    const timing = await waitForOperationalChatGptViewport(page);
    expect(timing.applied).toBeFalse();
    expect(timing.applyMs).toBe(0);
    expect(timing.waitMs).toBe(0);
  }
});

test("undersized viewport is repaired and its operational dimensions verified", async () => {
  for (const viewport of [{ width: 319, height: 900 }, { width: 1280, height: 239 }]) {
    const operations: unknown[] = [];
    const page = {
      evaluate: async () => viewport,
      setViewportSize: async (size: unknown) => { operations.push(size); },
      waitForFunction: async (predicate: Function, size: unknown, options: unknown) => {
        operations.push({ size, options });
        const context = createContext({ innerWidth: 1280, innerHeight: 900, size });
        expect(runInContext(`(${predicate.toString()})(size)`, context)).toBeTrue();
        expect(runInContext(`(${predicate.toString()})({width:1281,height:900})`, context)).toBeFalse();
        expect(runInContext(`(${predicate.toString()})({width:1280,height:901})`, context)).toBeFalse();
      },
    } as unknown as Page;
    expect((await waitForOperationalChatGptViewport(page)).applied).toBeTrue();
    expect(operations).toEqual([
      { width: 1280, height: 900 },
      { size: { width: 320, height: 240 }, options: { polling: 25, timeout: 10_000 } },
    ]);
  }
});

test("viewport repair cannot silently accept failed verification", async () => {
  const page = {
    evaluate: async () => ({ width: 0, height: 0 }),
    setViewportSize: async () => {},
    waitForFunction: async () => { throw new Error("still hidden"); },
  } as unknown as Page;
  await expect(waitForOperationalChatGptViewport(page)).rejects.toThrow("operational viewport: still hidden");
});

test("only non-Pro low effort uses the 150ms Instant stability window", () => {
  for (const effort of ["low", "high", "max", "medium", undefined]) {
    const stableMs = effort === "low" ? 150 : 1000;
    expect(chatGptCompletionStableMs(effort)).toBe(stableMs);
    const tracker = new ChatGptCompletionTracker(chatGptCompletionStableMs(effort));
    const state = { responsePresent: true, running: false, currentText: "answer", completionActionVisible: true };
    expect(tracker.update(state, 0)).toBeFalse();
    expect(tracker.nextStabilityDelayMs(0)).toBe(stableMs);
    expect(tracker.update(state, stableMs - 1)).toBeFalse();
    expect(tracker.update(state, stableMs)).toBeTrue();
  }
  expect(chatGptCompletionStableMs("low", true)).toBe(1000);
});

test("Instant candidate edits and tool batches restart stability and require a delayed final answer", () => {
  const stableMs = chatGptCompletionStableMs("low");
  const tracker = new ChatGptCompletionTracker(stableMs);
  const state = { responsePresent: true, running: false, currentText: "before tool", currentHtml: "before tool", completionActionVisible: true };
  expect(tracker.update(state, 0)).toBeFalse();
  const edited = { ...state, currentHtml: "<p>before tool</p>" };
  const editAt = stableMs - 1;
  expect(tracker.update(edited, editAt)).toBeFalse();
  expect(tracker.nextStabilityDelayMs(editAt)).toBe(stableMs);
  expect(tracker.nextStabilityDelayMs(editAt + 1)).toBe(stableMs - 1);
  expect(tracker.update(edited, editAt + stableMs - 1)).toBeFalse();
  expect(tracker.update(edited, editAt + stableMs)).toBeTrue();
  expect(tracker.observeToolBatch(1, state.currentText)).toBeTrue();
  const toolAt = editAt + 2 * stableMs;
  expect(tracker.nextStabilityDelayMs(toolAt)).toBeUndefined();
  expect(tracker.update({ ...edited, externalToolCallsInFlight: true }, toolAt)).toBeFalse();
  const idleAt = toolAt + stableMs;
  expect(tracker.update(edited, idleAt)).toBeFalse();
  expect(tracker.update(edited, idleAt + stableMs)).toBeFalse();
  const final = { ...edited, currentText: "final after tool", currentHtml: "<p>final after tool</p>" };
  const finalAt = idleAt + 2 * stableMs;
  expect(tracker.update(final, finalAt)).toBeFalse();
  expect(tracker.nextStabilityDelayMs(finalAt)).toBe(stableMs);
  expect(tracker.update(final, finalAt + stableMs - 1)).toBeFalse();
  expect(tracker.update(final, finalAt + stableMs)).toBeTrue();
});

test("Instant completion still waits for running generation, active streams, tools and completion actions", () => {
  const stableMs = chatGptCompletionStableMs("low");
  const final = { responsePresent: true, running: false, currentText: "final", completionActionVisible: true };
  for (const active of [
    { ...final, running: true },
    { ...final, responseStreamActive: true },
    { ...final, externalToolCallsInFlight: true },
    { ...final, completionActionVisible: false },
    { ...final, responsePresent: false },
  ]) {
    const tracker = new ChatGptCompletionTracker(stableMs);
    expect(tracker.update(final, 0)).toBeFalse();
    expect(tracker.update(active, stableMs)).toBeFalse();
    expect(tracker.nextStabilityDelayMs(stableMs)).toBeUndefined();
    const resumedAt = 2 * stableMs;
    expect(tracker.update(final, resumedAt)).toBeFalse();
    expect(tracker.nextStabilityDelayMs(resumedAt)).toBe(stableMs);
    expect(tracker.update(final, resumedAt + stableMs - 1)).toBeFalse();
    expect(tracker.update(final, resumedAt + stableMs)).toBeTrue();
  }
});

test("completion candidates restart their full window after missing DOM, HTML edits or pending images", () => {
  const final = { responsePresent: true, running: false, currentText: "answer",
    currentHtml: "<p>answer</p>", completionActionVisible: true };
  for (const interruption of [
    { ...final, responsePresent: false },
    { ...final, currentHtml: "<p><b>answer</b></p>" },
    { ...final, pendingImages: true },
  ]) {
    const tracker = new ChatGptCompletionTracker(500);
    expect(tracker.update(final, 0)).toBeFalse();
    expect(tracker.update(interruption, 500)).toBeFalse();
    expect(tracker.update(final, 600)).toBeFalse();
    expect(tracker.nextStabilityDelayMs(600)).toBe(500);
    expect(tracker.update(final, 1099)).toBeFalse();
    expect(tracker.update(final, 1100)).toBeTrue();
  }
});

const smokeHtml = readFileSync(new URL("./fixtures/chatgpt-dil-smoke.html", import.meta.url), "utf8");
const powerCompleteHtml = readFileSync(new URL("./fixtures/chatgpt-power-complete.html", import.meta.url), "utf8");
const powerStreamingHtml = readFileSync(new URL("./fixtures/chatgpt-power-streaming.html", import.meta.url), "utf8");
// These captures are also edited as strings below. Windows checkouts use CRLF;
// normalize before inserting test variants so they exercise the same DOM everywhere.
const powerActivityHtml = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const activitySummariesHtml = readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
type Snapshot = {
  responsePresent: boolean;
  downloadableFiles: string[];
  visibleText: string;
  fullHtml: string;
  richWidgetSources: string[];
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  traceBlocks: { kind: "answer" | "commentary" | "status"; text: string }[];
};
const fileOnlyHtml = readFileSync(new URL("./fixtures/chatgpt-file-only-complete.html", import.meta.url), "utf8");

// Execute the production page callback, with only missing Domino browser APIs supplied.
async function snapshot(html: string): Promise<Snapshot> {
  return (await snapshots(html, []))[0]!;
}

async function snapshots(html: string, changes: Array<(document: Document) => void>): Promise<Snapshot[]> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  const innerText = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText");
  const append = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "append");
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent; },
  });
  Object.defineProperty(window.HTMLElement.prototype, "append", {
    configurable: true, value(this: HTMLElement, ...nodes: Node[]) { nodes.forEach(node => this.appendChild(node)); },
  });
  const collections = [window.document.querySelectorAll("div"), window.document.body.children].map(Object.getPrototypeOf);
  const iterators = collections.map(prototype => Object.getOwnPropertyDescriptor(prototype, Symbol.iterator));
  for (const prototype of collections) Object.defineProperty(prototype, Symbol.iterator, {
    configurable: true, value: Array.prototype[Symbol.iterator],
  });
  try {
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, NodeFilter: window.NodeFilter, performance: { timeOrigin: 1 },
      getComputedStyle: (element: HTMLElement) => ({
        display: element.style.display || "block", visibility: "visible", opacity: "1",
      }),
      MutationObserver: class { observe() {} },
    });
    const errors: unknown[] = [];
    const locator = {
      evaluate: async (callback: Function, options: unknown) => {
        try { return runInContext(`(${callback.toString()})`, context)(window.document.getElementById("turn"), options); }
        catch (error) { errors.push(error); throw error; }
      },
      page: () => ({ isClosed: () => false }),
    } as unknown as Locator;
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      responseDomSnapshot(locator: Locator): Promise<Snapshot>;
    };
    const result = [await worker.responseDomSnapshot(locator)];
    for (const change of changes) {
      change(window.document);
      result.push(await worker.responseDomSnapshot(locator));
    }
    expect(errors).toEqual([]);
    return result;
  } finally {
    collections.forEach((prototype, index) => {
      if (iterators[index]) Object.defineProperty(prototype, Symbol.iterator, iterators[index]!);
      else delete prototype[Symbol.iterator];
    });
    if (innerText) Object.defineProperty(window.HTMLElement.prototype, "innerText", innerText);
    else delete window.HTMLElement.prototype.innerText;
    if (append) Object.defineProperty(window.HTMLElement.prototype, "append", append);
    else delete window.HTMLElement.prototype.append;
  }
}

const followupFixture = (root = 'data-markdown-text-style="assistant-message"') => `<section id="turn"><div data-content-search-unit-key="answer"><h4 data-conversation-role="assistant"></h4><div ${root}>
<p>The report is complete.</p>
<div class="relative min-w-0 px-3"><div class="flex min-w-0 flex-col items-start">
<button class="group/suggested-followup"><span>Clarify the result</span></button>
<button class="group/suggested-followup"><span>Shorten the report</span></button>
</div><div aria-hidden="true" class="pointer-events-none start-0 top-0 w-max">
<div><span>Clarify the result</span><span>Shorten the report</span></div>
</div></div></div></div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></section>`;

test("suggested follow-up sizing copies stay out of the answer", async () => {
  for (const root of ['class="markdown"', 'data-markdown-text-style="assistant-message"']) {
    const result = await snapshot(followupFixture(root));
    expect(result.visibleText).toBe("The report is complete.");
    expect(chatGptHtmlToMarkdown(result.fullHtml)).toBe("The report is complete.");
    expect(result.markdownSegments.map(segment => segment.text).join("\n")).not.toContain("Clarify the result");
    expect(result.fullHtml).not.toContain("Shorten the report");
    expect(result.completionActionVisible).toBeTrue();
  }
});

test("changing follow-up sizing labels cannot rewrite delivered answer text", async () => {
  const [before, after] = await snapshots(followupFixture(), [document => {
    document.querySelector('[aria-hidden="true"] span')!.textContent = "A hydrated suggestion";
  }]);
  expect(before!.visibleText).toBe("The report is complete.");
  expect(after!.visibleText).toBe(before!.visibleText);
  expect(after!.fullHtml).toBe(before!.fullHtml);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe(before!.markdownSegments, 0);
  buffer.observe(after!.markdownSegments, 1);
  expect(buffer.finish().markdown).toBe("The report is complete.");
});

test("follow-up filtering preserves unrelated content and file-reference labels", async () => {
  const html = followupFixture().replace('<p>The report is complete.</p>', `<p>The report is complete.</p>
<p><span aria-hidden="true">Unrelated answer content.</span><button class="behavior-btn entity-underline">report.pdf</button></p>
<pre><code>&lt;button class="group/suggested-followup"&gt;example&lt;/button&gt;</code></pre>`);
  const result = await snapshot(html);
  expect(result.visibleText).toContain("Unrelated answer content.");
  expect(result.visibleText).toContain("report.pdf");
  expect(chatGptHtmlToMarkdown(result.fullHtml)).toContain('class="group/suggested-followup"');
  expect(result.visibleText).not.toContain("Clarify the result");
});

test("captured Activity progress is commentary before any assistant answer exists", async () => {
  const progress = await snapshot(powerActivityHtml);
  expect(progress.responsePresent).toBeTrue();
  expect(progress.markdownSegments).toEqual([]);
  expect(progress.completionActionVisible).toBeFalse();
  expect(progress.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text)).toEqual(["Text 5\nText 6\nText 4\nText 8"]);
  const marker = '<span hidden="" data-chatgpt-agent-turn-start="">\n</span>';
  expect(powerActivityHtml).toContain(marker);
  const combined = powerActivityHtml.replace(marker, marker + '<div data-content-search-unit-key="answer"><h4 data-conversation-role="assistant"></h4><div data-markdown-text-style="assistant-message"><p>Final answer.</p></div></div>');
  const answer = await snapshot(combined);
  expect(answer.visibleText).toBe("Final answer.");
  expect(answer.traceBlocks.some(block => block.kind === "commentary")).toBeTrue();
});

test("captured activity summaries use the status stream and keep actual commentary and answers separate", async () => {
  const result = await snapshot(activitySummariesHtml);
  expect(result.visibleText).toBe("answer 1");
  expect(result.traceBlocks.filter(block => block.kind === "status").map(block => block.text))
    .toEqual(Array.from({ length: 10 }, (_, index) => `status ${index + 1}`));
  expect(result.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text))
    .toEqual(["commentary 1", "commentary 2"]);
  const tracker = new ChatGptVisibleTraceTracker(0);
  const events = tracker.observe(result.traceBlocks, true);
  expect(events.map(event => event.kind)).toEqual([
    "reasoning", "commentary", ...Array(8).fill("reasoning"), "commentary", "reasoning",
  ]);
  expect(tracker.observe(result.traceBlocks, true)).toEqual([]);

  // Text, colour, and header placement do not determine the channel. The final
  // answer owns its own unit even if its renderer uses the same tone attribute.
  const changed = await snapshot(activitySummariesHtml
    .replaceAll("status 1", "commentary 1")
    .replace('data-markdown-text-style="assistant-message">\n<p>answer 1',
      'data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">\n<p>answer 1'));
  expect(changed.visibleText).toBe("answer 1");
  expect(changed.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text))
    .toEqual(["commentary 1", "commentary 2"]);
  expect(changed.traceBlocks.find(block => block.kind === "status")?.text).toBe("commentary 1");

  const hidden = await snapshot(activitySummariesHtml
    .replace('<div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">',
      '<div style="display:none"><div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">')
    .replace('<p>status 1</p>\n</div>', '<p>status 1</p>\n</div></div>'));
  expect(hidden.traceBlocks.some(block => block.text === "status 1")).toBeFalse();
});

test("keeps an unfinished hyperlink buffered and detects changed destinations after delivery", async () => {
  const page = (href: string) => `<section id="turn"><div class="markdown"><p data-start="0" data-end="99"><strong><a${href}>Open report</a></strong>.</p><p data-start="100" data-end="115">Next paragraph.</p></div></section>`;
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const pending = await snapshot(page(""));
  expect(buffer.observe(pending.markdownSegments, 0)).toBe("");
  const linked = await snapshot(page(' href="https://example.com/report#details"'));
  expect(buffer.observe(linked.markdownSegments, 1000)).toBe("**[Open report](https://example.com/report#details)**.");
  expect(buffer.finish().markdown).toBe("**[Open report](https://example.com/report#details)**.\n\nNext paragraph.");
  const changed = await snapshot(page(' href="https://example.com/different"'));
  buffer.observe(changed.markdownSegments, 2000);
  expect(buffer.currentSnapshotIsConsistent()).toBeFalse();
  expect(() => buffer.finish()).toThrow("completed text block");
});

test("observed resource preview hydration cannot rewrite delivered answer text", async () => {
  // Structural fragment supplied in #769; only the title/filename/type are generic.
  for (const root of ['class="markdown"', 'data-markdown-text-style="assistant-message"']) {
    const page = (label: string, type: string) => `<section id="turn"><div data-content-search-unit-key="answer">
      <h4 data-conversation-role="assistant"></h4><div ${root}>
      <p>The layout was updated.</p>
      <div data-chatgpt-copy-reference="0" data-markdown-copy="contents">
        <div><span><span class="group/resource-row relative"><span>
          <span title="${label}">${label}</span><span>${type}</span>
        </span></span></span></div>
      </div><p>Validation completed.</p>
    </div></div><button aria-label="Copy"></button></section>`;
    const before = await snapshot(page("Layout", ""));
    const after = await snapshot(page("candidate-overview.png", "PNG"));
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    expect(buffer.observe(before.markdownSegments, 0)).toBe("The layout was updated.");
    expect(buffer.observe(after.markdownSegments, 1)).toBe("");
    expect(buffer.finish().markdown).toBe("The layout was updated.\n\nValidation completed.");
    // These snapshots use different documents; node identities must not be reused.
    expect(before.markdownSegments.map(({ key, ...content }) => content))
      .toEqual(after.markdownSegments.map(({ key, ...content }) => content));
    expect(after.markdownSegments.map(segment => segment.html).join("")).not.toContain("candidate-overview.png");
    expect(after.fullHtml).not.toContain("candidate-overview.png");
    await snapshots(page("candidate-overview.png", "PNG"), [doc => {
      // Only the readback is projected; the actual browser document stays intact.
      expect(doc.getElementById("turn")!.innerHTML).toContain("candidate-overview.png");
    }]);

    buffer.observe((await snapshot(page("Layout", "").replace("The layout was updated.", "Changed answer."))).markdownSegments, 2);
    expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
  }
});

test("file preview removal preserves a pending paragraph through movement and remounting", async () => {
  for (const remount of [false, true]) {
    const html = `<div id="turn"><div class="markdown">
      <p>Report saved:</p><p id="file">report.md</p><p id="tail">Validation completed.</p>
    </div><button aria-label="Copy"></button></div>`;
    const [before, moved, repeated, continued, changed] = await snapshots(html, [
      document => {
        const root = document.querySelector(".markdown")!;
        const file = document.querySelector("#file")!;
        root.parentElement!.appendChild(file);
        if (remount) root.innerHTML = root.innerHTML;
      },
      () => {},
      document => {
        const next = document.createElement("p");
        next.textContent = "The task is finished.";
        document.querySelector(".markdown")!.appendChild(next);
      },
      document => { document.querySelector(".markdown p")!.textContent = "A changed report."; },
    ]);
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    expect(buffer.observe(before!.markdownSegments, 0)).toBe("Report saved:\n\nreport.md");
    expect(buffer.observe(moved!.markdownSegments, 1)).toBe("");
    expect(buffer.observe(repeated!.markdownSegments, 2)).toBe("");
    if (!remount) expect(moved!.markdownSegments.at(-1)!.key).toBe(before!.markdownSegments.at(-1)!.key);
    expect(buffer.observe(continued!.markdownSegments, 3)).toBe("\n\nValidation completed.");
    expect(buffer.finish().markdown).toBe("Report saved:\n\nreport.md\n\nValidation completed.\n\nThe task is finished.");
    buffer.observe(changed!.markdownSegments, 4);
    expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
  }
});

test("resource preview filtering preserves actual links, plain file labels and ordinary wrappers", async () => {
  const result = await snapshot(`<section id="turn"><div class="markdown">
    <div data-markdown-copy="contents">Ordinary content.</div>
    <div data-chatgpt-copy-reference="0" data-markdown-copy="contents">report.md</div>
    <div><span class="group/resource-row">Ordinary label.</span></div>
    <div data-chatgpt-copy-reference="1" data-markdown-copy="contents">
      <span class="group/resource-row"><a href="https://example.com/report">Download report</a></span>
    </div><p>Done.</p>
  </div><button aria-label="Copy"></button></section>`);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe(result.markdownSegments, 0);
  expect(buffer.finish().markdown).toBe("Ordinary content.\n\nreport.md\n\nOrdinary label.\n\n[Download report](https://example.com/report)\n\nDone.");
});

test("captured DIL smoke response reaches Markdown delivery and stable completion", async () => {
  // Also cover a changed CSS module hash and nested Markdown without duplicate delivery.
  for (const html of [
    smokeHtml,
    smokeHtml.replaceAll("fv0XaG_", "changed_"),
    smokeHtml.replace('<p class="w6asjq_TextBase _85PZeG_Text">', '<p class="markdown">'),
    '<section id="turn"><div class="markdown"><p>CODEX WEB GPT READY</p></div><button data-testid="copy-turn-action-button"></button></section>',
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("CODEX WEB GPT READY");
    expect(response.completionActionVisible).toBeTrue();
    const buffer = new ChatGptMarkdownBuffer();
    buffer.observe(response.markdownSegments, 0);
    expect(buffer.finish().markdown).toBe("CODEX WEB GPT READY");
    const tracker = new ChatGptCompletionTracker();
    const state = { ...response, running: false, currentText: response.visibleText, currentHtml: response.fullHtml };
    expect(tracker.update({ ...state, running: true }, 0)).toBeFalse();
    expect(tracker.update(state, 1)).toBeFalse();
    expect(tracker.update(state, 1 + CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
    expect(response.traceBlocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "answer", text: "CODEX WEB GPT READY" },
    ]);
  }
});

test("captured power UI excludes the user footer during streaming and completes the assistant answer", async () => {
  // Captured from the same live DEV turn on 2026-09-25. The user already has Copy/Share
  // controls while the assistant streams; both live under one data-turn-key.
  const streaming = await snapshot(powerStreamingHtml);
  expect(streaming.visibleText).toContain("How a Rainbow Begins");
  expect(streaming.visibleText).not.toContain("No tools or apps");
  expect(streaming.completionActionVisible).toBeFalse();
  const complete = await snapshot(powerCompleteHtml);
  expect(complete.visibleText).toEndWith("STREAM_END_927");
  expect(complete.completionActionVisible).toBeTrue();
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(complete.markdownSegments, 0);
  const markdown = buffer.finish().markdown;
  expect(markdown).toContain("## How a Rainbow Begins");
  expect(markdown).toContain("1. Sunlight enters the droplet and refracts.");
  expect(markdown).toEndWith("STREAM\\_END\\_927");
  const translated = await snapshot(powerCompleteHtml.replaceAll('aria-label="Copy"', 'aria-label="복사"'));
  expect(translated.completionActionVisible).toBeTrue();
  const noAssistant = await snapshot(powerCompleteHtml.replaceAll('data-conversation-role="assistant"', 'data-conversation-role="user"'));
  expect(noAssistant.visibleText).toBe("");
  expect(noAssistant.completionActionVisible).toBeFalse();
  const userMarkdown = await snapshot(powerCompleteHtml.replace('data-user-message-bubble="true">',
    'data-user-message-bubble="true"><div class="markdown">USER CONTENT</div>'));
  expect(userMarkdown.visibleText).toBe(complete.visibleText);
});

test("captured power response keeps its Markdown ledger through final rendering", async () => {
  const streaming = await snapshot(powerStreamingHtml);
  const complete = await snapshot(powerCompleteHtml);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(streaming.markdownSegments, 0);
  buffer.observe(complete.markdownSegments, 1000);
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish().markdown).toEndWith("STREAM\\_END\\_927");
});

test("reported code-block containers preserve code while their localized toolbar changes", async () => {
  // #631 supplied the finished structure: a generic DIV around
  // [data-markdown-copy="code-block"] > DIV > CODE, without a PRE.
  // Exercise changing UI text inside that container through the production extraction callback.
  const code = '  first = "コード"\n\n  print(first)\n  # ```\n';
  for (const block of ["div", "pre"]) {
    for (const label of ["コード", "Code", "代码"]) {
      const html = (toolbar: string, value = code) => `<section id="turn" data-turn-key="response">
        <div data-content-search-unit-key="response:assistant"><h4 data-conversation-role="assistant">ChatGPT said:</h4>
        <div data-markdown-text-style="assistant-message">
          <p data-start="0" data-end="10">Example</p>
          <div data-start="12" data-end="100"><${block} data-markdown-copy="code-block">
            ${toolbar}<div class="overflow-auto p-2"><code class="language-python whitespace-pre block"><span>${value}</span></code></div>
          </${block}></div>
          <p data-start="102" data-end="120">Done.</p>
        </div></div></section>`;
      const during = await snapshot(html(`<div>${label}<button>Copy</button></div>`));
      const after = await snapshot(html(""));
      expect(during.markdownSegments[1]?.text).toBe(code.trim());
      expect(after.markdownSegments[1]?.text).toBe(code.trim());
      expect(during.markdownSegments[1]).toMatchObject({ sourceStart: 12, sourceEnd: 100 });
      const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
      buffer.observe(during.markdownSegments, 0);
      buffer.observe(after.markdownSegments, 1000);
      expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
      expect(buffer.finish().markdown).toBe(`Example\n\n\`\`\`python\n${code}\`\`\`\n\nDone.`);

      // Ignore the toolbar, never an actual change to code already sent to Codex.
      const changed = await snapshot(html("", code.replace("print(first)", "print(other)")));
      buffer.observe(changed.markdownSegments, 2000);
      expect(() => buffer.finish()).toThrow("ChatGPT changed a completed text block");
    }
  }
});

test("captured CodeMirror reply preserves its language, fences and line boundaries", async () => {
  const html = readFileSync(new URL("./fixtures/chatgpt-codemirror-reply-2026-10-11.html", import.meta.url), "utf8");
  const captured = await snapshot(html);
  expect(chatGptHtmlToMarkdown(captured.fullHtml)).toBe("# Probe\n\n- First item\n- Second item\n\n```python\nprint(1)\n```");
  const code = 'def sample():\n    value = "日本語 & <x>"\n\n    return value\n';
  const frames = await snapshots(html, [
    doc => {
      const editor = doc.querySelector(".cm-content")!;
      editor.textContent = "";
      for (const text of code.split("\n")) {
        const line = doc.createElement("div"); line.className = "cm-line";
        if (text) line.textContent = text; else line.appendChild(doc.createElement("br"));
        editor.appendChild(line);
      }
    },
    doc => { doc.querySelector('[data-markdown-copy="exclude"]')!.textContent = "コード"; },
  ]);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(frames[1]!.markdownSegments, 0);
  buffer.observe(frames[2]!.markdownSegments, 1000);
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish().markdown).toBe(`# Probe\n\n- First item\n- Second item\n\n\`\`\`python\n${code}\`\`\``);
  expect(frames[2]!.fullHtml).not.toContain("コード");
  expect(frames[2]!.fullHtml).not.toContain("cm-content");
});

test("CodeMirror source changes remain real answer edits and incomplete editors fail explicitly", async () => {
  const html = readFileSync(new URL("./fixtures/chatgpt-codemirror-reply-2026-10-11.html", import.meta.url), "utf8");
  const frames = await snapshots(html, [
    doc => { doc.querySelector(".cm-line")!.textContent = "print(2)"; },
  ]);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(frames[0]!.markdownSegments, 0);
  buffer.finish();
  buffer.observe(frames[1]!.markdownSegments, 1000);
  expect(() => buffer.finish()).toThrow("ChatGPT changed a completed text block");
  for (const missingSource of [
    html.replace('<div class="cm-line">', '<div style="height:200px"></div><div class="cm-line">'),
    html.replace('<div class="cm-line">', '<div class="cm-content" data-language="python"></div><div class="cm-line">'),
  ]) {
    await expect(snapshot(missingSource)).rejects.toThrow("one complete set of code lines");
  }
});

test("known rich-content controls cannot keep a finished answer waiting, but answer edits restart settling", async () => {
  // Chart and preview boundaries were captured in DEV; their controls can change
  // after generation has stopped. Completion must use the same content as delivery.
  const html = `<section id="turn"><div class="markdown">
    <p id="prose">Here is the chart.</p><pre><code class="language-json">{"mark":"line"}</code></pre>
    <div class="chart-widget-container" id="chart"><div role="status">Creating chart</div></div>
    <div data-code-block-preview-pane="vega-lite" id="preview">Loading preview</div>
    <p>Done.</p></div><button data-testid="copy-turn-action-button"></button></section>`;
  const frames = await snapshots(html, [
    doc => {
      doc.getElementById("chart")!.innerHTML = '<button>Chart options</button><svg><text>Day 1 Day 2</text></svg>';
      doc.getElementById("preview")!.innerHTML = '<iframe title="Preview"></iframe>';
    },
    doc => { doc.getElementById("chart")!.innerHTML = '<button>Chart options</button><svg><text>Day 3 Day 4</text></svg>'; },
    doc => { doc.getElementById("prose")!.textContent = "Here is the revised chart."; },
  ]);
  const state = (frame: Snapshot) => ({ ...frame, running: false,
    currentText: frame.visibleText, currentHtml: frame.fullHtml });
  const tracker = new ChatGptCompletionTracker();
  expect(frames.every(frame => frame.completionActionVisible)).toBeTrue();
  expect(tracker.update({ ...state(frames[0]!), running: true }, 0)).toBeFalse();
  expect(tracker.update(state(frames[0]!), 1)).toBeFalse();
  expect(frames[1]!.visibleText).toBe(frames[0]!.visibleText);
  expect(frames[2]!.fullHtml).toBe(frames[0]!.fullHtml);
  expect(frames[2]!.fullHtml).not.toContain("Chart options");
  expect(frames[2]!.fullHtml).toContain('{"mark":"line"}');
  expect(tracker.update(state(frames[1]!), 1000)).toBeFalse();
  expect(tracker.update(state(frames[2]!), 1 + CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
  expect(tracker.update(state(frames[3]!), 2 + CHATGPT_COMPLETION_SETTLE_MS)).toBeFalse();
  expect(tracker.update(state(frames[3]!), 2 + 2 * CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
  // A widget refreshing after a tool call is not a new answer from the model.
  const afterTool = new ChatGptCompletionTracker();
  afterTool.observeToolBatch(1, frames[0]!.visibleText);
  expect(afterTool.update(state(frames[1]!), 0)).toBeFalse();
  expect(afterTool.update(state(frames[2]!), CHATGPT_COMPLETION_SETTLE_MS)).toBeFalse();
  expect(afterTool.update(state(frames[3]!), 1 + CHATGPT_COMPLETION_SETTLE_MS)).toBeFalse();
  expect(afterTool.update(state(frames[3]!), 1 + 2 * CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
});

test("writing card controls cannot rewrite delivered content, but edited email text still can", async () => {
  const html = (toolbar: string, body = "Hello <strong>Alex</strong>.") => `<section id="turn"><div class="markdown">
    <p data-start="0" data-end="10">Drafts</p>
    <div data-markdown-copy="rich-block" data-start="12" data-end="200">
      <div>${toolbar}<button>Copy</button></div>
      <div data-markdown-copy-content="true"><p>${body}</p><p>See <a href="https://example.com/">details</a>.</p>
        <pre><code class="language-text">line 1\n  line 2</code></pre></div>
      <footer>Email format</footer>
    </div><p data-start="202" data-end="220">Done.</p></div></section>`;
  const during = await snapshot(html("メール"));
  const complete = await snapshot(html(""));
  // These snapshots use separate documents; their DOM node identities differ.
  expect(during.markdownSegments.map(({ key, ...content }) => content))
    .toEqual(complete.markdownSegments.map(({ key, ...content }) => content));
  expect(during.markdownSegments.map(segment => segment.text).join("\n")).not.toContain("メール");
  expect(during.markdownSegments.map(segment => segment.text).join("\n")).not.toContain("Email format");
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(during.markdownSegments, 0);
  buffer.observe(complete.markdownSegments, 1000);
  const output = buffer.finish().markdown;
  expect(output).toContain("Hello **Alex**.");
  expect(output).toContain("[details](https://example.com/)");
  expect(output).toContain("line 1\n  line 2");
  buffer.observe((await snapshot(html("", "Hello Sam."))).markdownSegments, 2000);
  expect(() => buffer.finish()).toThrow("ChatGPT changed a completed text block");
});

test("nested writing cards keep the outer prose and cards without a unique body lose nothing", async () => {
  const response = await snapshot(`<section id="turn"><div class="markdown">
    <div data-markdown-copy="rich-block"><p>Outer prose</p>
      <div data-markdown-copy="rich-block"><div>Toolbar</div>
        <div data-markdown-copy-content="true"><p>Inner body</p></div></div></div>
    <div data-markdown-copy="rich-block"><div data-markdown-copy-content="true">First</div>
      <div data-markdown-copy-content="true">Second</div></div>
    <p>End</p></div></section>`);
  const text = response.markdownSegments.map(segment => segment.text).join("\n");
  expect(text).toContain("Outer prose");
  expect(text).toContain("Inner body");
  expect(text).toContain("First");
  expect(text).toContain("Second");
  expect(text).not.toContain("Toolbar");
});

test("ordinary prose, inline code and legacy fenced code keep their meaning", async () => {
  const response = await snapshot(`<section id="turn" data-turn="assistant">
    <div data-message-author-role="assistant"><div class="markdown">
      <p>Code: <code>/tmp/file.ts</code></p>
      <pre data-start="30" data-end="80"><code class="language-text">/tmp/file.ts\n\n[[note]]\n\`\`\`\nend</code></pre>
      <p>Done.</p>
    </div></div></section>`);
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(response.markdownSegments, 0);
  expect(buffer.finish().markdown).toBe("Code: [/tmp/file.ts](</tmp/file.ts>)\n\n````text\n/tmp/file.ts\n\n[[note]]\n```\nend\n````\n\nDone.");
});

test("DIL response extraction preserves ownership, commentary and completion boundaries", async () => {
  for (const html of [
    smokeHtml.replace('data-message-author-role="assistant"', 'data-message-author-role="user"'),
    smokeHtml.replace("fv0XaG_DilResponseRoot", "unrelated-widget"),
    smokeHtml.replace('dir="auto"', 'dir="auto" style="display:none"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-streaming-response-status="thinking"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-testid="cot-v5"'),
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("");
    expect(response.completionActionVisible).toBeFalse();
  }
  const noCopy = await snapshot(smokeHtml.replace('data-testid="copy-turn-action-button"', 'data-testid="other-action"'));
  expect(noCopy.visibleText).toBe("CODEX WEB GPT READY");
  expect(noCopy.completionActionVisible).toBeFalse();
});

const fileCompletionState = (value: Snapshot) => ({
  responsePresent: value.responsePresent,
  running: false,
  currentText: value.visibleText,
  currentHtml: value.fullHtml,
  completionActionVisible: value.completionActionVisible,
  downloadableFiles: value.downloadableFiles,
  allowFileOnlyCompletion: true,
});

test("native file-only answer completes using card evidence without fabricating answer text", async () => {
  const value = await snapshot(fileOnlyHtml);
  expect(value.downloadableFiles).toEqual(["report.csv"]);
  expect(value.visibleText).toBe("");
  expect(value.completionActionVisible).toBeTrue();
  const buffer = new ChatGptMarkdownBuffer();
  expect(buffer.observe(value.markdownSegments)).toBe("");
  expect(buffer.finish().markdown).toBe("");
  const state = fileCompletionState(value);
  expect(chatGptTurnIsComplete(state)).toBeTrue();
  const completion = new ChatGptCompletionTracker(500);
  expect(completion.update(state, 0)).toBeFalse();
  expect(completion.update(state, 499)).toBeFalse();
  expect(completion.update(state, 500)).toBeTrue();
  const health = new ChatGptTurnDomHealthTracker(1000, 500);
  expect(health.update(state, 0)).toBeUndefined();
  expect(health.update(state, 1500)).toBeUndefined();
});

test("file-only answers still require enabled QA downloads and real completed-turn evidence", async () => {
  const state = fileCompletionState(await snapshot(fileOnlyHtml));
  for (const variant of [
    { ...state, allowFileOnlyCompletion: false },
    { ...state, allowFileOnlyCompletion: undefined },
    { ...state, downloadableFiles: [] },
    { ...state, responsePresent: false },
    { ...state, running: true },
    { ...state, completionActionVisible: false },
  ]) expect(chatGptTurnIsComplete(variant)).toBeFalse();
  const health = new ChatGptTurnDomHealthTracker(1000, 500);
  const disabled = { ...state, allowFileOnlyCompletion: false };
  expect(health.update(disabled, 0)).toBeUndefined();
  expect(health.update(disabled, 501)).toContain("completed without a final answer");
  const empty = { ...state, downloadableFiles: [] };
  const emptyHealth = new ChatGptTurnDomHealthTracker(1000, 500);
  expect(emptyHealth.update(empty, 0)).toBeUndefined();
  expect(emptyHealth.update(empty, 501)).toContain("completed without a final answer");
});

test("active file generation and external work reset the completion stability window", async () => {
  const state = fileCompletionState(await snapshot(fileOnlyHtml));
  for (const active of [{ ...state, running: true }, { ...state, externalToolCallsInFlight: true }]) {
    const completion = new ChatGptCompletionTracker(500);
    expect(completion.update(state, 0)).toBeFalse();
    expect(completion.update(active, 501)).toBeFalse();
    expect(completion.update(state, 1000)).toBeFalse();
    expect(completion.update(state, 1499)).toBeFalse();
    expect(completion.update(state, 1500)).toBeTrue();
  }
  const tracker = new ChatGptCompletionTracker(500);
  expect(tracker.update(state, 0)).toBeFalse();
  const changed = { ...state, downloadableFiles: ["finished.csv"] };
  expect(tracker.update(changed, 500)).toBeFalse();
  expect(tracker.update(changed, 1000)).toBeTrue();
});

test("file-only completion requires a following action inside the bound response", async () => {
  const action = '<button type="button" data-testid="copy-turn-action-button"></button>';
  for (const html of [
    fileOnlyHtml.replace(action, ""),
    fileOnlyHtml.replace(action, "").replace('<section id="turn"', action + '<section id="turn"'),
    fileOnlyHtml.replace(action, "").replace('  <div data-content-search-unit-key=', action + '<div data-content-search-unit-key='),
  ]) {
    const value = await snapshot(html);
    expect(value.downloadableFiles).toEqual(["report.csv"]);
    expect(value.completionActionVisible).toBeFalse();
    expect(chatGptTurnIsComplete(fileCompletionState(value))).toBeFalse();
  }
  const withoutMarkdown = fileOnlyHtml.replace('<div data-markdown-text-style="assistant-message"><div><button aria-label="查看分析"></button></div></div>', "");
  const value = await snapshot(withoutMarkdown);
  expect(value.visibleText).toBe("");
  expect(value.downloadableFiles).toEqual(["report.csv"]);
  expect(value.completionActionVisible).toBeTrue();
});

test("user uploads prior turns and unavailable controls cannot qualify as a file answer", async () => {
  const outside = fileOnlyHtml.replace('id="turn"', 'id="previous"');
  const current = '<section id="turn"><div data-message-author-role="assistant"><div class="markdown"></div></div><button data-testid="copy-turn-action-button"></button></section>';
  expect((await snapshot(outside + current)).downloadableFiles).toEqual([]);
  for (const html of [
    fileOnlyHtml.replace('fixture:1:assistant', 'fixture:1:user').replace('data-conversation-role="assistant"', 'data-conversation-role="user"'),
    fileOnlyHtml.replace('class="resource-card"', 'class="resource-card" data-user-message-bubble'),
    fileOnlyHtml.replace('class="resource-card"', 'class="resource-card" data-streaming-response-status'),
    fileOnlyHtml.replace('class="resource-card"', 'class="resource-card" hidden'),
    fileOnlyHtml.replace('class="resource-card"', 'class="resource-card" style="display:none"'),
    fileOnlyHtml.replace('title="report.csv"', ''),
    fileOnlyHtml.replace('aria-label="下载文件"', 'aria-label="Open preview"'),
    ...['disabled', 'aria-disabled="true"', 'aria-busy="true"', 'hidden', 'aria-hidden="true"'].map(attribute => fileOnlyHtml.replace('aria-label="下载文件"', 'aria-label="下载文件" ' + attribute)),
    fileOnlyHtml.replace('aria-label="下载文件"></button>', 'aria-label="下载文件"></button><button aria-label="Download file"></button>'),
  ]) {
    const value = await snapshot(html);
    expect(value.downloadableFiles).toEqual([]);
    expect(chatGptTurnIsComplete(fileCompletionState(value))).toBeFalse();
  }
});
test("KaTeX hydration keeps the same formula identity while real formula edits still fail", async () => {
  const html = (rendered: string, source = "x_1") => `<section id="turn"><div class="markdown">
    <p>Value <span class="katex"><span class="katex-mathml"><math><semantics>
      <mrow><mi>x</mi><mn>1</mn></mrow><annotation encoding="application/x-tex">${source}</annotation>
    </semantics></math></span><span class="katex-html" aria-hidden="true">${rendered}</span></span>.</p>
    <p>Done.</p></div></section>`;
  const initial = await snapshot(html("x 1"));
  const hydrated = await snapshot(html("x1"));
  expect(initial.markdownSegments[0]?.text).toBe("Value x_1.");
  expect(hydrated.markdownSegments[0]?.text).toBe(initial.markdownSegments[0]?.text);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe(initial.markdownSegments, 0);
  buffer.observe(hydrated.markdownSegments, 1);
  expect(buffer.finish().markdown).toBe(String.raw`Value \(x_1\).` + "\n\nDone.");
  buffer.observe((await snapshot(html("x2", "x_2"))).markdownSegments, 2);
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});


// #788 captures the same reference first as text, then an empty loading control.
test("mutable references buffer from the preview while preceding paragraphs keep streaming", async () => {
  const html = `<section id="turn"><div class="markdown"><p>Intro.</p>
    <div id="preview" data-chatgpt-copy-reference="0" data-markdown-copy="contents">View</div>
    <p>Closing note.</p></div><button aria-label="Copy"></button></section>`;
  const frames = await snapshots(html, [
    doc => { doc.getElementById("preview")!.innerHTML = '<div class="motion-safe:animate-spin"></div>'; },
    doc => { doc.getElementById("preview")!.innerHTML = '<span class="group/resource-row">report.pdfPDF</span>'; },
    doc => { doc.getElementById("preview")!.innerHTML = '<span class="group/resource-row"><a href="https://example.com/report">Download report</a></span>'; },
  ]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  expect(buffer.observe(frames[0]!.markdownSegments, 0)).toBe("Intro.");
  for (const frame of frames.slice(1)) expect(buffer.observe(frame.markdownSegments, 1)).toBe("");
  expect(buffer.finish()).toEqual({
    markdown: "Intro.\n\n[Download report](https://example.com/report)\n\nClosing note.",
    delta: "\n\n[Download report](https://example.com/report)\n\nClosing note.",
  });
});

test("a removed preview cannot release its pending tail even if the prefix was still settling", async () => {
  const html = `<section id="turn"><div class="markdown"><p>Intro.</p>
    <div id="preview" data-chatgpt-copy-reference="0" data-markdown-copy="contents">View</div>
    <p>Pending tail.</p><p>Closing.</p></div></section>`;
  const [first, removed, remounted, edited] = await snapshots(html, [
    doc => { doc.getElementById("preview")!.remove(); },
    doc => { doc.querySelector(".markdown")!.outerHTML = html.match(/<div class="markdown">.*<\/div>/s)![0]; },
    doc => { doc.querySelector("p")!.textContent = "Real edit."; },
  ]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 750);
  expect(buffer.observe(first!.markdownSegments, 0)).toBe("");
  expect(buffer.observe(removed!.markdownSegments, 1000)).toBe("Intro.");
  expect(buffer.observe(removed!.markdownSegments, 2000)).toBe("");
  expect(buffer.observe(remounted!.markdownSegments, 3000)).toBe("");
  buffer.observe(edited!.markdownSegments, 4000);
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});

test("an empty preview that owns its own Markdown root still holds back following text", async () => {
  for (const marker of ['div class="markdown"', 'span']) {
    const html = `<section id="turn"><div class="markdown"><p>Intro.</p></div>
      <${marker} id="preview" data-chatgpt-copy-reference="0" data-markdown-copy="contents"><span class="group/resource-row">preview.pngPNG</span></${marker.split(' ')[0]}>
      <div class="markdown"><p>Tail.</p><p>End.</p></div></section>`;
    // A span belongs inside its containing answer rather than being a separate renderer root.
    const owned = marker === 'span' ? html.replace('</div>\n      <span', '\n      <span').replace('</span>\n      <div class="markdown">', '</span>') : html;
    const [before, after] = await snapshots(owned, [doc => {
      doc.getElementById("preview")!.innerHTML = '<a href="https://example.com/file">File</a>';
    }]);
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    expect(buffer.observe(before!.markdownSegments, 0)).toBe("Intro.");
    expect(buffer.observe(after!.markdownSegments, 1)).toBe("");
    expect(buffer.finish().markdown).toBe("Intro.\n\n[File](https://example.com/file)\n\nTail.\n\nEnd.");
  }
});

test("unmatched final blocks report structural evidence without exposing answer contents", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe([{ key: "original", tag: "p", html: "<p>Private answer</p>", text: "Private answer", streamable: true }]);
  buffer.observe([{ key: "remounted", tag: "div", html: "<div>Private replacement</div>", text: "Private replacement", streamable: false }]);
  try {
    buffer.finish();
    throw new Error("Expected a consistency error");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptMarkdownConsistencyError);
    const diagnostic = (error as ChatGptMarkdownConsistencyError).diagnostic;
    expect(diagnostic).toMatchObject({ reason: "unanchored_block", observedTag: "div", committedTag: "p", observedKeyMode: "dom-node", committedKeyMode: "dom-node", observedIndex: 0, committedIndex: 0 });
    expect(JSON.stringify(diagnostic)).not.toContain("Private");
  }
});

test("recreated horizontal rules preserve their Markdown and position among delivered paragraphs", async () => {
  const html = `<section id="turn"><div class="markdown"><p>First.</p><hr><p>Middle.</p><hr><p>Last.</p><p>Pending.</p></div></section>`;
  const frames = await snapshots(html, [doc => {
    for (const hr of Array.from(doc.querySelectorAll("hr"))) hr.replaceWith(doc.createElement("hr"));
  }, doc => {
    doc.querySelector(".markdown")!.firstElementChild!.remove();
    doc.querySelector("p")!.textContent = "Changed delivered text.";
  }]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const streamed = buffer.observe(frames[0]!.markdownSegments, 0);
  expect(streamed).toContain("First.");
  expect(streamed.match(/\* \* \*/g)).toHaveLength(2);
  expect(buffer.observe(frames[1]!.markdownSegments, 1)).toBe("");
  expect(buffer.finish().markdown).toBe(chatGptHtmlToMarkdown(html));
  buffer.observe(frames[2]!.markdownSegments, 2);
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});

test("repeated rules need ordered anchors and an inserted rule cannot masquerade as delivered content", () => {
  const p = (key: string, text: string): ChatGptMarkdownSegment => ({ key, tag: "p", html: `<p>${text}</p>`, text, streamable: true });
  const hr = (key: string): ChatGptMarkdownSegment => ({ key, tag: "hr", html: "<hr>", text: "", streamable: true });
  const original = [p("a", "First"), hr("r1"), p("b", "Middle"), hr("r2"), p("c", "Last")];
  for (const observed of [
    [hr("new"), p("c", "Last")], // Either rule could be the remounted one.
    [p("b", "Middle"), hr("new"), p("a", "First")], // Real reordering stays invalid.
  ]) {
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    buffer.observe(original, 0);
    buffer.observe(observed, 1);
    expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
  }
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe([p("a", "First"), p("c", "Last")], 0);
  buffer.observe([p("a", "First"), hr("inserted"), p("c", "Last")], 1);
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});

test("late source ranges preserve the same answer blocks across subsequent remounts", async () => {
  const html = `<section id="turn" data-turn-key="response">
    <div data-content-search-unit-key="response:assistant"><h4 data-conversation-role="assistant">Assistant</h4>
      <div data-markdown-text-style="assistant-message">
        <p id="first">First paragraph.</p><p id="tail">Tail.</p>
      </div>
    </div></section>`;
  const frames = await snapshots(html, [doc => {
    for (const [id, start, end] of [["first", "0", "16"], ["tail", "18", "23"]]) {
      doc.getElementById(id!)!.setAttribute("data-start", start!);
      doc.getElementById(id!)!.setAttribute("data-end", end!);
    }
  }, doc => {
    const answer = doc.querySelector('[data-markdown-text-style="assistant-message"]')!;
    answer.innerHTML = answer.innerHTML;
  }, doc => {
    doc.getElementById("first")!.remove();
    doc.getElementById("tail")!.textContent = "Tail extended.";
    doc.getElementById("tail")!.setAttribute("data-end", "32");
  }]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  expect(buffer.observe(frames[0]!.markdownSegments, 0)).toBe("First paragraph.");
  for (const [index, frame] of frames.slice(1).entries()) {
    expect(buffer.observe(frame.markdownSegments, index + 1)).toBe("");
    expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  }
  expect(buffer.finish()).toEqual({ markdown: "First paragraph.\n\nTail extended.", delta: "\n\nTail extended." });
});

test("late source ranges cannot disguise edits, reordered blocks or unknown node replacements", async () => {
  for (const change of ["text", "link", "order", "remount", "overlap"] as const) {
    const html = `<section id="turn"><div class="markdown">
      <p id="first"><a href="https://example.com/original">First</a></p>
      <p id="second">Second.</p><p id="tail">Tail.</p>
    </div></section>`;
    const [before, after] = await snapshots(html, [doc => {
      if (change === "remount") {
        const answer = doc.querySelector(".markdown")!;
        answer.innerHTML = answer.innerHTML;
      }
      if (change === "text") doc.getElementById("first")!.textContent = "Changed.";
      if (change === "link") doc.querySelector("a")!.setAttribute("href", "https://example.com/changed");
      if (change === "order") doc.querySelector(".markdown")!.insertBefore(doc.getElementById("second")!, doc.getElementById("first")!);
      Array.from(doc.querySelectorAll("p")).forEach((node, index) => {
        node.setAttribute("data-start", String(index * 20));
        node.setAttribute("data-end", String(index * 20 + 10));
      });
      if (change === "overlap") doc.getElementById("tail")!.setAttribute("data-start", "25");
    }]);
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    expect(buffer.observe(before!.markdownSegments, 0)).toBe("[First](https://example.com/original)\n\nSecond.");
    expect(buffer.observe(after!.markdownSegments, 1)).toBe("");
    expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
  }
});

test("a known answer node cannot move its source range and be emitted again", async () => {
  const [before, shifted] = await snapshots(`<section id="turn"><div class="markdown">
    <p id="first" data-start="0" data-end="16">First paragraph.</p><p>Tail.</p>
  </div></section>`, [doc => {
    doc.getElementById("first")!.setAttribute("data-start", "50");
    doc.getElementById("first")!.setAttribute("data-end", "66");
  }]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  expect(buffer.observe(before!.markdownSegments, 0)).toBe("First paragraph.");
  expect(buffer.observe(shifted!.markdownSegments, 1)).toBe("");
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});

test("repeated text cannot rebind a known node to another committed source range", async () => {
  const [before, shifted] = await snapshots(`<section id="turn"><div class="markdown">
    <p id="first" data-start="0" data-end="8">Repeated.</p>
    <p id="second" data-start="10" data-end="18">Repeated.</p><p>Tail.</p>
  </div></section>`, [doc => {
    doc.getElementById("first")!.remove();
    doc.getElementById("second")!.setAttribute("data-start", "0");
    doc.getElementById("second")!.setAttribute("data-end", "8");
  }]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  expect(buffer.observe(before!.markdownSegments, 0)).toBe("Repeated.\n\nRepeated.");
  expect(buffer.observe(shifted!.markdownSegments, 1)).toBe("");
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});


test("chart DOM transports data while the Markdown view excludes renderer controls", async () => {
  const spec = JSON.stringify({
    mark: "bar", title: "Enzyme activity",
    encoding: { x: { field: "variant" }, y: { field: "activity" }, color: { field: "sample" } },
    data: { values: [{ variant: "WT", activity: 1.4, sample: "A" }, { variant: "mut", activity: 2.3, sample: "B" }] },
  });
  const page = `<section id="turn"><div class="markdown"><p>Activity by variant.</p>
    <div class="chart-widget-container"><pre><code class="language-vega-lite">${spec}</code></pre><button>Zoom</button></div>
    <p>Two variants shown.</p></div><button aria-label="Copy"></button></section>`;
  const result = await snapshot(page);
  expect(result.richWidgetSources).toEqual([spec]);
  const widgets = parseChatGptChartWidgets(result.richWidgetSources);
  expect(widgets).toEqual([{
    version: 1, kind: "cartesian_chart", id: "chart-1", mark: "bar",
    title: "Enzyme activity", xField: "variant", yField: "activity", seriesField: "sample",
    points: [{ x: "WT", y: 1.4, series: "A" }, { x: "mut", y: 2.3, series: "B" }],
  }]);
  expect(result.markdownSegments.map(segment => segment.html).join("")).not.toContain("chart-widget-container");
  expect(result.markdownSegments.map(segment => segment.html).join("")).not.toContain("Zoom");
  expect(parseChatGptChartWidgets(['{"mark":"bar","data":{"values":[{"x":"v","y":1}]}, "encoding":{"x":{"field":"x"},"y":{"field":"y"}},"transform":[{"calculate":"alert(1)"}]}'])[0])
    .toEqual({version: 1, kind: "cartesian_chart", id: "chart-1", mark: "bar", title: "", xField: "x", yField: "y", points: [{x:"v",y:1}]});
});

test("unwitnessed repeated-text remount cannot establish identity from a complete text prefix", async () => {
  const html = `<section id="turn"><div class="markdown"><p>Repeated.</p><p>Repeated.</p><p>Number 03 <a href="https://example.com/3">link</a>.</p><p>Growing.</p></div></section>`;
  const frames = await snapshots(html, [doc => {
    const root = doc.querySelector(".markdown")!;
    root.innerHTML = root.innerHTML;
    root.lastElementChild!.textContent = "Growing answer.";
    root.innerHTML += "<p>Final.</p>";
  }]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  expect(buffer.observe(frames[0]!.markdownSegments, 0).length).toBeGreaterThan(0);
  expect(buffer.observe(frames[1]!.markdownSegments, 1)).toBe("");
  expect(buffer.currentSnapshotIsConsistent()).toBeFalse();
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});

test("complete-prefix remount cannot hide changed links, text, order or missing repeated occurrences", async () => {
  const html = `<section id="turn"><div class="markdown"><p>Repeated.</p><p>Repeated.</p><p>Number 03 <a href="https://example.com/3">link</a>.</p><p>Pending.</p></div></section>`;
  for (const mutation of ["link", "text", "order", "missing"] as const) {
    const [first, changed] = await snapshots(html, [doc => {
      const root = doc.querySelector(".markdown")!;
      root.innerHTML = root.innerHTML;
      if (mutation === "link") root.querySelector("a")!.setAttribute("href", "https://example.com/other");
      if (mutation === "text") root.firstElementChild!.textContent = "Changed.";
      if (mutation === "order") root.insertBefore(root.children[2]!, root.children[1]!);
      if (mutation === "missing") root.firstElementChild!.remove();
    }]);
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    buffer.observe(first!.markdownSegments, 0);
    buffer.observe(changed!.markdownSegments, 1);
    expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
  }
});

const unwrappedCompleteHtml = readFileSync(new URL("./fixtures/chatgpt-unwrapped-complete-2026-10-28.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const unwrappedAnswer = "Configuration checked.\n\nThe configured model matches the requested model.";

test("synthetic unwrapped reply requires a following completion action before delivery", async () => {
  const complete = await snapshot(unwrappedCompleteHtml);
  expect(complete.visibleText).toBe(unwrappedAnswer);
  expect(complete.visibleText).not.toContain("go on");
  expect(complete.completionActionVisible).toBeTrue();
  expect(complete.traceBlocks.length).toBe(2);
  expect(complete.traceBlocks.every(block => block.kind === "answer")).toBeTrue();
  const tracker = new ChatGptCompletionTracker();
  const state = { ...complete, running: false, currentText: complete.visibleText, currentHtml: complete.fullHtml };
  expect(tracker.update(state, 0)).toBeFalse();
  expect(tracker.update(state, CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
});

test("streaming commentary without the site completion action is not promoted to an answer", async () => {
  const streaming = await snapshot(unwrappedCompleteHtml
    .replace(/<!--ASSISTANT_ACTIONS_START-->[\s\S]*?<!--ASSISTANT_ACTIONS_END-->/, ""));
  expect(streaming.visibleText).toBe("");
  expect(streaming.completionActionVisible).toBeFalse();
});

test("a completion action before the assistant message cannot prove it finished", async () => {
  const actions = unwrappedCompleteHtml.match(/<!--ASSISTANT_ACTIONS_START-->[\s\S]*?<!--ASSISTANT_ACTIONS_END-->/)![0];
  const moved = unwrappedCompleteHtml
    .replace(actions, "")
    .replace('<span hidden="" data-chatgpt-agent-turn-start=""></span>',
      actions.replace(/<!--ASSISTANT_ACTIONS_(START|END)-->/g, "")
      + '<span hidden="" data-chatgpt-agent-turn-start=""></span>');
  const result = await snapshot(moved);
  expect(result.visibleText).toBe("");
  expect(result.completionActionVisible).toBeFalse();
});

test("legacy assistant turn markup still completes through the copied action", async () => {
  const legacy = '<section id="turn"><div data-testid="conversation-turn-1" data-turn="assistant">'
    + '<div class="markdown"><p>Legacy answer</p></div>'
    + '<button data-testid="copy-turn-action-button"></button></div></section>';
  const result = await snapshot(legacy);
  expect(result.visibleText).toBe("Legacy answer");
  expect(result.completionActionVisible).toBeTrue();
});

test("activity commentary with a preceding user footer and an alert is not a final answer", async () => {
  const html = '<div id="turn" data-turn-key="captured-failure-shape">'
    + '<div data-user-message-bubble>Long submitted prompt</div>'
    + '<div class="turn-action-controls"><button aria-label="复制消息"></button>'
    + '<button aria-label="共享提示"></button><button aria-label="编辑消息"></button></div>'
    + '<div><span hidden data-chatgpt-agent-turn-start></span>'
    + '<div data-markdown-text-style="assistant-message"><p>Continuing the check.</p></div>'
    + '<div data-markdown-text-style="assistant-message"><p>I will inspect the configuration.</p></div></div>'
    + '<div role="alert">Upstream response failed.</div></div>';
  const result = await snapshot(html);
  expect(result.visibleText).toBe("");
  expect(result.completionActionVisible).toBeFalse();
  expect(result.traceBlocks.filter(block => block.kind === "commentary")).toHaveLength(2);
  expect(chatGptTurnIsComplete({
    responsePresent: result.responsePresent, running: false, currentText: result.visibleText,
    completionActionVisible: result.completionActionVisible,
  })).toBeFalse();
});

test("activity, reasoning and user roots are not promoted by a following footer", async () => {
  for (const wrapper of [
    '<div><span hidden data-chatgpt-agent-turn-start></span>CONTENT</div>',
    '<div data-streaming-response-status>CONTENT</div>',
    '<div data-testid="cot-v5-content">CONTENT</div>',
    '<div data-user-message-bubble>CONTENT</div>',
    '<div data-content-search-unit-key="reply:user">CONTENT</div>',
  ]) {
    const content = '<div data-markdown-text-style="assistant-message"><p>Not a final answer.</p></div>';
    const result = await snapshot('<div id="turn" data-turn-key="negative">'
      + wrapper.replace("CONTENT", content)
      + '<div class="turn-action-controls"><button aria-label="复制"></button></div></div>');
    expect(result.visibleText).toBe("");
    expect(result.completionActionVisible).toBeFalse();
  }
});

test("unwrapped completion fails closed on an alert or a disabled or hidden action", async () => {
  for (const html of [
    unwrappedCompleteHtml.replace('<!--ASSISTANT_ACTIONS_START-->', '<div role="alert">Failure</div>'),
    unwrappedCompleteHtml.replaceAll('type="button" aria-label="复制"', 'type="button" disabled aria-label="复制"')
      .replaceAll('type="button" aria-label="重新生成回复"', 'type="button" disabled aria-label="重新生成回复"'),
    unwrappedCompleteHtml.replaceAll('type="button" aria-label="复制"', 'type="button" hidden aria-label="复制"')
      .replaceAll('type="button" aria-label="重新生成回复"', 'type="button" hidden aria-label="重新生成回复"'),
  ]) {
    const result = await snapshot(html);
    expect(result.visibleText).toBe("");
    expect(result.completionActionVisible).toBeFalse();
  }
});

test("an action outside the bound turn cannot complete another turn", async () => {
  const result = await snapshot('<div id="turn" data-turn-key="owned">'
    + '<span hidden data-chatgpt-agent-turn-start></span>'
    + '<div data-markdown-text-style="assistant-message"><p>Unfinished.</p></div></div>'
    + '<div data-turn-key="foreign"><div class="turn-action-controls">'
    + '<button aria-label="复制"></button></div></div>');
  expect(result.visibleText).toBe("");
  expect(result.completionActionVisible).toBeFalse();
});
