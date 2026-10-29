import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptConversationStore, hasAcceptedChatGptInstructions } from "../src/adapters/chatgpt-web/conversation-persistence";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_COMPOSER_SELECTOR } from "../src/chatgpt-session";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };

for (const timing of ["before-checkpoint", "during-checkpoint", "after-checkpoint"] as const) {
  test("owned 200 SSE input rejection revokes only instruction reuse: " + timing, async () => {
    const root = mkdtempSync(join(tmpdir(), "instruction-rejection-"));
    const key = "c".repeat(64), fingerprint = "a".repeat(64), history = ["b".repeat(64), "d".repeat(64)];
    const store = new ChatGptConversationStore(root, "isolated");
    const saved = store.recordHistory(key, store.bind(key, store.reserve(key),
      "https://chatgpt.com/c/rejected-fixture"), history.slice(0, 1), "e".repeat(64));
    const worker = ChatGptBrowserWorker.forProvider({
      adapter: "chatgpt-web", baseUrl: "browser://" + root,
      chatgptWeb: { accountId: "isolated", localToolsEnabled: true,
        conversationStoreDirectory: root, browserDiagnosticsPath: join(root, "diagnostics") },
    });
    const locator = {
      evaluateAll: async () => [], count: async () => 0, all: async () => [],
      isVisible: async () => false, waitFor: async () => {},
      filter() { return this; }, first() { return this; }, last() { return this; }, nth() { return this; },
    };
    const composer = { ...locator, count: async () => 1, isVisible: async () => true };
    const frame = {};
    const page = Object.assign(new EventEmitter(), {
      url: () => saved.url!, isClosed: () => false, mainFrame: () => frame,
      evaluate: async () => ({}),
      evaluateHandle: async () => ({ evaluate: async () => false, dispose: async () => {} }),
      locator: (selector: string) => selector === CHATGPT_COMPOSER_SELECTOR ? composer : locator,
      waitForURL: async () => {},
    });
    const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
    let sends = 0, submitted = 0;
    let signal: AbortSignal;
    const rejectInput = async () => {
      page.emit("requestfinished", request);
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      expect(signal.reason).toMatchObject({ code: "context_length_exceeded" });
    };
    Object.assign(worker, {
      runStage: async (_trace: string, _stage: string, _budget: number, action: (signal: AbortSignal) => Promise<unknown>) =>
        action(new AbortController().signal),
      prepareChatSurface: async () => {},
      selectModelAndEffort: async () => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities),
      reconcileSelectedEffortBeforeSend: async (_page: unknown, selected: unknown) => selected,
      captureSubmissionBaseline: async () => ({ initialTurnIdentities: [] }),
      attachFiles: async () => {}, attachPromptWithCompactionRetry: async () => {},
      sendAttachedPrompt: async (_page: unknown, _baseline: unknown, _capture: unknown, abortSignal: AbortSignal,
        _progress: unknown, lifecycle: Pick<BrowserTurn, "onSendActivated" | "onSubmitted">) => {
        signal = abortSignal;
        await lifecycle.onSendActivated?.();
        sends++;
        page.emit("request", request);
        page.emit("response", {
          request: () => request, status: () => 200, headers: () => ({ "content-type": "text/event-stream" }),
          text: async () => 'data: {"error":"Input rejected","error_code":"input_too_large","error_reason":"last_user_message"}\n\ndata: [DONE]\n\n',
        });
        if (timing === "before-checkpoint") await rejectInput();
        await lifecycle.onSubmitted?.();
        if (timing === "after-checkpoint") {
          expect(hasAcceptedChatGptInstructions(store.lookup(key), fingerprint)).toBeTrue();
          await rejectInput();
        }
        throw signal.reason;
      },
    });
    const turn: BrowserTurn = {
      traceId: "instruction-rejection-" + timing, modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low",
      capabilities, retainConversation: true, conversationKey: key, instructionFingerprint: fingerprint,
      canonicalHistory: history, onTextDelta() {},
      prepare: async () => { throw new Error("Unexpected new conversation"); },
      prepareResume: async () => ({ text: "Updated full instructions", images: [], release() {} }),
      onSubmitted: async () => { submitted++; if (timing === "during-checkpoint") await rejectInput(); },
    };
    try {
      const run = worker as unknown as { runBrowserTurn(turn: BrowserTurn, surface: undefined, page: unknown): Promise<string> };
      await expect(run.runBrowserTurn(turn, undefined, page)).rejects.toMatchObject({ code: "context_length_exceeded" });
      const current = store.lookup(key)!;
      expect(current).toEqual({ ...saved, history, instructionFingerprint: undefined, instructionHistoryFingerprint: undefined });
      expect(hasAcceptedChatGptInstructions(current, fingerprint)).toBeFalse();
      expect(hasAcceptedChatGptInstructions(current, "e".repeat(64))).toBeFalse();
      expect(sends).toBe(1);
      expect(submitted).toBe(1);
      expect(page.listenerCount("requestfinished")).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("instruction invalidation preserves the full mapping and rejects a stale checkpoint owner", () => {
  const root = mkdtempSync(join(tmpdir(), "instruction-invalidation-"));
  const store = new ChatGptConversationStore(root, "isolated");
  try {
    const saved = store.bind("thread", store.reserve("thread"), "https://chatgpt.com/c/original",
      { id: "g-p-" + "a".repeat(32), name: "Fixture project" });
    const accepted = store.recordHistory("thread", saved, ["b".repeat(64)], "a".repeat(64));
    const { instructionFingerprint, instructionHistoryFingerprint, ...mapping } = accepted;
    expect(store.invalidateInstructions("thread", accepted)).toEqual(mapping);
    expect(store.lookup("thread")).toEqual(mapping);
    const newer = store.recordHistory("thread", mapping, ["b".repeat(64), "c".repeat(64)], "d".repeat(64));
    expect(() => store.invalidateInstructions("thread", accepted)).toThrow("checkpoint owner");
    expect(store.lookup("thread")).toEqual(newer);
    const recovery = store.recover("thread", newer);
    expect(() => store.invalidateInstructions("thread", newer)).toThrow();
    expect(store.read("thread")).toEqual(recovery);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
