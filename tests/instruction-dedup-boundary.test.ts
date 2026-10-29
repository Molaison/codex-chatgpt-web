import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptConversationStore, hasAcceptedChatGptInstructions } from "../src/adapters/chatgpt-web/conversation-persistence";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };

for (const boundary of ["before-send", "ambiguous", "accepted-then-model-failure"] as const) {
  test("actual worker persists instruction state only after accepted Send: " + boundary, async () => {
    const root = mkdtempSync(join(tmpdir(), "instruction-boundary-"));
    const store = new ChatGptConversationStore(root, "isolated");
    const fingerprint = "a".repeat(64);
    const failure = new Error("fixture: terminal boundary " + boundary);
    const worker = ChatGptBrowserWorker.forProvider({
      adapter: "chatgpt-web", baseUrl: "browser://" + root,
      chatgptWeb: { accountId: "isolated", localToolsEnabled: true,
        conversationStoreDirectory: root, browserDiagnosticsPath: join(root, "diagnostics") },
    });
    const locator = {
      evaluateAll: async () => [], count: async () => 0, all: async () => [],
      isVisible: async () => false, filter() { return this; }, first() { return this; }, last() { return this; },
    };
    const page = { url: () => "https://chatgpt.com/c/accepted-fixture", isClosed: () => false,
      evaluate: async () => ({}),
      evaluateHandle: async () => ({ evaluate: async () => false, dispose: async () => {} }),
      locator: () => locator, on() {}, off() {}, waitForURL: async () => {} };
    let sends = 0;
    Object.assign(worker, {
      runStage: async (_trace: string, _stage: string, _budget: number, action: (signal: AbortSignal) => Promise<unknown>) =>
        action(new AbortController().signal),
      prepareChatSurface: async () => {},
      selectModelAndEffort: async () => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities),
      reconcileSelectedEffortBeforeSend: async (_page: unknown, selected: unknown) => selected,
      captureSubmissionBaseline: async () => ({ initialTurnIdentities: [] }),
      attachFiles: async () => {},
      attachPromptWithCompactionRetry: async () => {},
      sendAttachedPrompt: async (_page: unknown, _baseline: unknown, _capture: unknown, _signal: unknown,
        _progress: unknown, lifecycle: Pick<BrowserTurn, "onSendActivated" | "onSubmitted">) => {
        await lifecycle.onSendActivated?.();
        sends++;
        if (boundary === "ambiguous") throw failure;
        await lifecycle.onSubmitted?.();
        return "user_turn";
      },
      waitForNewAssistantTurn: async () => { throw failure; },
    });
    const turn: BrowserTurn = {
      traceId: "instruction-boundary-" + boundary, modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low",
      capabilities, retainConversation: true, conversationKey: "c".repeat(64), instructionFingerprint: fingerprint,
      canonicalHistory: ["b".repeat(64)], onTextDelta() {},
      prepare: async () => ({ text: "Full system and contract", images: [], release() {} }),
      ...(boundary === "before-send" ? { onSendActivated: async () => { throw failure; } } : {}),
    };
    try {
      const run = worker as unknown as { runBrowserTurn(turn: BrowserTurn, surface: undefined, page: unknown): Promise<string> };
      await expect(run.runBrowserTurn(turn, undefined, page)).rejects.toBe(failure);
      expect(sends).toBe(boundary === "before-send" ? 0 : 1);
      if (boundary === "before-send") expect(store.read(turn.conversationKey!)).toBeUndefined();
      if (boundary === "ambiguous") {
        expect(store.read(turn.conversationKey!)?.state).toBe("pending");
        expect(store.read(turn.conversationKey!)?.instructionFingerprint).toBeUndefined();
        expect(() => store.lookup(turn.conversationKey!)).toThrow();
      }
      if (boundary === "accepted-then-model-failure") {
        expect(hasAcceptedChatGptInstructions(store.lookup(turn.conversationKey!), fingerprint)).toBeTrue();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("reused worker with missing prepareResume fails closed before preparing or sending", async () => {
  const worker = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web", baseUrl: "browser://missing-instruction-resume",
    chatgptWeb: {},
  }) as unknown as {
    runBrowserTurn(turn: BrowserTurn, surface: undefined, page: unknown, reused: boolean): Promise<string>;
  };
  const turn: BrowserTurn = {
    traceId: "missing-resume", modelId: CHATGPT_WEB_MODEL_ID, capabilities,
    prepare: async () => { throw new Error("Unexpected fresh preparation"); }, onTextDelta() {},
  };
  await expect(worker.runBrowserTurn(turn, undefined, {}, true))
    .rejects.toThrow("The retained ChatGPT conversation has no continuation prompt");
});
