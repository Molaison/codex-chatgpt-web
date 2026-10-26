import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ChatGptBrowserWorker, resolveBrowserConfig, restoreSavedChatConversation, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { getConfigDir } from "../src/config";

const executablePath = process.env.CHATGPT_DOM_TEST_BROWSER;
const browserTest = test.skipIf(!executablePath);
const parentUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const childUrl = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const temporaryUrl = "https://chatgpt.com/c/temporary-session?temporary-chat=true";
const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
let browser: Browser;
beforeAll(async () => {
  if (executablePath) browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => { await browser?.close(); });

type Fixture = { root: string; context: BrowserContext; store: ChatGptConversationStore };
async function fixture(run: (value: Fixture) => Promise<void>, behavior = "normal") {
  const root = mkdtempSync(join(tmpdir(), "qa-saved-recovery-"));
  const context = await browser.newContext();
  const store = new ChatGptConversationStore(root, "account-1");
  // Every network request is intercepted; this fixture never reaches the real website.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://chatgpt.com") return route.abort();
    if (url.pathname.startsWith("/c/") && behavior === "deleted") return route.fulfill({ status: 404, body: "Deleted" });
    if (url.pathname.startsWith("/c/") && behavior === "redirect") return route.fulfill({ status: 302, headers: { location: "https://chatgpt.com/" } });
    const history = !url.pathname.startsWith("/c/") || behavior === "empty" ? ""
      : behavior === "assistant-only" ? '<article data-testid="conversation-turn-1" data-turn="assistant"><div class="markdown">Earlier answer</div><button data-testid="copy-turn-action-button">Copy</button></article>'
      : behavior === "grouped-assistant-only" ? '<article data-turn-key="saved-turn"><div data-conversation-role="assistant">Earlier answer</div><div class="turn-action-controls"><button>Copy</button></div></article>'
      : '<article data-user-message-bubble>Earlier question</article><article data-message-author-role="assistant">Earlier answer</article>';
    const composer = behavior === "no-composer" ? "" : '<form><div id="prompt-textarea" contenteditable="true"> </div></form>';
    const save = url.searchParams.has("temporary-chat")
      ? `<button onclick="document.querySelector('[role=dialog]').hidden=false">Save chat</button>
        <div role="dialog" hidden><button onclick="location.href='${parentUrl}'">Save</button></div>` : "";
    return route.fulfill({ contentType: "text/html", body: '<html><body>' + history + composer + save + '</body></html>' });
  });
  try { await run({ root, context, store }); }
  finally { await context.close(); rmSync(root, { recursive: true, force: true }); }
}

test("direct workers retain portable account paths without a global chat-mode setting", () => {
  const base = { adapter: "chatgpt-web" as const, baseUrl: "browser://config-fixture" };
  expect(resolveBrowserConfig(base)).toMatchObject({ accountId: "default",
    conversationStoreDirectory: join(getConfigDir(), "runtime", "conversations") });
  expect(resolveBrowserConfig({ ...base, chatgptWeb: { conversationStoreDirectory: "custom-chats" } }).conversationStoreDirectory)
    .toBe(join(getConfigDir(), "custom-chats"));
  for (const chatgptWeb of [{}, { localToolsEnabled: true }, { browserInteractionMode: "manual" as const }]) {
    expect(resolveBrowserConfig({ ...base, chatgptWeb })).not.toHaveProperty("useSavedChats");
  }
});

browserTest("a closed tab and recreated context restore the same recorded saved chat", async () => {
  await fixture(async ({ context, store, root }) => {
    store.bind("thread", store.reserve("thread"), parentUrl);
    const first = await context.newPage();
    await restoreSavedChatConversation(first, store.lookup("thread")!.url!, { timeoutMs: 2_000 });
    expect(first.url()).toBe(parentUrl);
    await first.close();
    const second = await context.newPage();
    const restartedStore = new ChatGptConversationStore(root, "account-1");
    await restoreSavedChatConversation(second, restartedStore.lookup("thread")!.url!, { timeoutMs: 2_000 });
    expect(second.url()).toBe(parentUrl);
    expect(await second.locator("[data-user-message-bubble]").innerText()).toBe("Earlier question");
  });
});

for (const behavior of ["deleted", "redirect", "empty", "no-composer"]) {
  browserTest("unavailable saved chat fails closed and keeps mapping: " + behavior, async () => {
    await fixture(async ({ context, store }) => {
      store.bind("thread", store.reserve("thread"), parentUrl);
      const page = await context.newPage();
      // DOM absence cases start on the recorded URL so navigation cannot mask the intended failure.
      if (behavior === "empty" || behavior === "no-composer") await page.goto(parentUrl);
      await expect(restoreSavedChatConversation(page, parentUrl, { timeoutMs: 1_000 }))
        .rejects.toMatchObject({ code: "saved_conversation_unavailable", retryable: false,
          message: expect.stringContaining(behavior === "empty" ? "during history" : "could not be reopened during ") });
      expect(store.lookup("thread")?.url).toBe(parentUrl);
      expect(readdirSync(store.directory)).toHaveLength(1);
    }, behavior);
  }, 30_000);
}

browserTest("aborted restoration remains an abort and leaves the browser untouched", async () => {
  await fixture(async ({ context }) => {
    const page = await context.newPage();
    const controller = new AbortController(); controller.abort();
    await expect(restoreSavedChatConversation(page, parentUrl, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(page.url()).toBe("about:blank");
  });
});

function prompt(text: string) {
  return { ...compileChatGptWebPrompt({ modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "low" },
    context: { systemPrompt: ["DO_NOT_IMPORT_CODEX_SYSTEM"], messages: [{ role: "user", content: text, timestamp: 1 }] },
  }, capabilities, undefined, { importCodexPrompt: false }), release() {} };
}

function workerHarness(f: Fixture, page: Page, key: string, options: {
  destination?: string; interrupted?: boolean; missingUrl?: boolean; wrongChatBeforeSend?: boolean; beforeSendFailure?: boolean;
  localTools?: boolean; sessionMode?: BrowserTurn["sessionMode"]; reused?: boolean;
} = {}) {
  const turnCapabilities = { ...capabilities, localToolsEnabled: options.localTools === true };
  const saved = options.sessionMode !== "temporary";
  const state = { fresh: 0, full: 0, incremental: 0, sends: 0, attached: "", localTools: false };
  const worker: any = ChatGptBrowserWorker.forProvider({ adapter: "chatgpt-web", baseUrl: "browser://fixture-" + randomUUID(),
    chatgptWeb: { accountId: "account-1", conversationStoreDirectory: f.root,
      browserDiagnosticsPath: join(f.root, "diagnostics"), storageStatePath: join(f.root, "browser-state.json") } });
  const finished = new Error("fixture: submission observed; no inference is performed");
  const interrupted = new Error("fixture: process interrupted after Send activation");
  Object.assign(worker, {
    prepareChatSurface: async (_page: Page, _capture: unknown, _signal: unknown, preparation: { sessionMode?: BrowserTurn["sessionMode"] }) => {
      state.fresh++; expect(preparation.sessionMode !== "temporary").toBe(saved);
      await page.goto(saved ? "https://chatgpt.com/" : "https://chatgpt.com/?temporary-chat=true");
    },
    selectModelAndEffort: async () => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", turnCapabilities),
    assertSelectedEffort: async () => {}, captureSubmissionBaseline: async () => ({}), attachFiles: async () => {},
    attachPromptWithCompactionRetry: async (_page: Page, text: string, localTools: boolean, _compaction: unknown,
      _baseline: unknown, _capture: unknown, _signal: unknown, _refresh: unknown, _budget: unknown, reuseConnector: boolean) => {
      state.attached = text;
      state.localTools = localTools;
      if (options.wrongChatBeforeSend) await page.goto(childUrl);
    },
    sendAttachedPrompt: async (_page: Page, _baseline: unknown, _capture: unknown, _signal: unknown,
      _progress: unknown, lifecycle: Pick<BrowserTurn, "onSendActivated" | "onSubmitted">) => {
      await lifecycle.onSendActivated?.();
      if (saved) expect(f.store.read(key)?.state).toBe(state.fresh ? "pending" : "bound");
      state.sends++;
      if (options.interrupted) throw interrupted;
      if (options.missingUrl) {
        page.waitForURL = async () => { throw new Error("fixture: saved URL never appeared"); };
      } else if (state.fresh) await page.goto(options.destination ?? (saved ? parentUrl : temporaryUrl));
      await lifecycle.onSubmitted?.();
      return "user_turn";
    },
    waitForNewAssistantTurn: async () => { throw finished; },
  });
  const turn: BrowserTurn = { traceId: randomUUID(), modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low", capabilities: turnCapabilities, sessionMode: options.sessionMode,
    retainConversation: true, conversationKey: key, onTextDelta() {},
    ...(options.beforeSendFailure ? { onSendActivated: async () => { throw interrupted; } } : {}),
    prepare: async () => { state.full++; return prompt("FULL: previous user question; previous assistant answer; latest child question"); },
    prepareResume: async () => { state.incremental++; return prompt("INCREMENTAL: latest question only"); },
  };
  return { state, finished, interrupted, run: () => worker.runBrowserTurn(turn, undefined, page, options.reused === true) };
}

browserTest("activation callback failure before Send releases pending reservation for a safe retry", async () => {
  await fixture(async f => {
    const first = workerHarness(f, await f.context.newPage(), "thread", { beforeSendFailure: true });
    await expect(first.run()).rejects.toBe(first.interrupted);
    expect(first.state.sends).toBe(0);
    expect(f.store.lookup("thread")).toBeUndefined();
    const retry = workerHarness(f, await f.context.newPage(), "thread");
    await expect(retry.run()).rejects.toBe(retry.finished);
    expect(retry.state).toMatchObject({ fresh: 1, full: 1, sends: 1 });
    expect(f.store.lookup("thread")?.url).toBe(parentUrl);
  });
}, 20_000);

browserTest("first Send reserves mapping before activation and recreated worker resumes with incremental input", async () => {
  await fixture(async f => {
    const page = await f.context.newPage();
    const first = workerHarness(f, page, "parent");
    await expect(first.run()).rejects.toBe(first.finished);
    expect(first.state).toMatchObject({ fresh: 1, full: 1, incremental: 0, sends: 1 });
    expect(f.store.lookup("parent")?.url).toBe(parentUrl);
    await page.close();
    const next = workerHarness(f, await f.context.newPage(), "parent");
    await expect(next.run()).rejects.toBe(next.finished);
    expect(next.state).toMatchObject({ fresh: 0, full: 0, incremental: 1, sends: 1 });
    expect(next.state.attached).toEndWith("INCREMENTAL: latest question only");
    expect(next.state.attached).not.toContain("DO_NOT_IMPORT_CODEX_SYSTEM");
    expect(f.store.lookup("parent")?.url).toBe(parentUrl);
  });
}, 30_000);

// Two real browser turns include their diagnostics and context cleanup in this case budget.
browserTest("new fork seeds full history once then persists and resumes its independent chat", async () => {
  await fixture(async f => {
    f.store.bind("parent", f.store.reserve("parent"), parentUrl);
    const child = workerHarness(f, await f.context.newPage(), "child", { destination: childUrl });
    await expect(child.run()).rejects.toBe(child.finished);
    expect(child.state).toMatchObject({ fresh: 1, full: 1, incremental: 0 });
    expect(child.state.attached).toContain("previous assistant answer");
    expect(f.store.lookup("parent")?.url).toBe(parentUrl);
    expect(f.store.lookup("child")?.url).toBe(childUrl);
    const next = workerHarness(f, await f.context.newPage(), "child");
    await expect(next.run()).rejects.toBe(next.finished);
    expect(next.state).toMatchObject({ fresh: 0, full: 0, incremental: 1 });
    expect(f.store.lookup("child")?.url).toBe(childUrl);
  });
}, 30_000);

browserTest("navigation away from restored chat blocks Send and preserves original binding", async () => {
  await fixture(async f => {
    f.store.bind("parent", f.store.reserve("parent"), parentUrl);
    const test = workerHarness(f, await f.context.newPage(), "parent", { wrongChatBeforeSend: true });
    await expect(test.run()).rejects.toMatchObject({ code: "saved_conversation_unavailable", retryable: false });
    expect(test.state.sends).toBe(0);
    expect(f.store.lookup("parent")?.url).toBe(parentUrl);
  });
}, 15_000);

for (const failure of ["interrupted", "missingUrl"] as const) {
  browserTest("ambiguous initial submission is never replayed after recreation: " + failure, async () => {
    await fixture(async f => {
      const first = workerHarness(f, await f.context.newPage(), "thread", { [failure]: true });
      if (failure === "interrupted") await expect(first.run()).rejects.toBe(first.interrupted);
      else await expect(first.run()).rejects.toMatchObject({ code: "saved_conversation_unresolved", retryable: false });
      expect(first.state.sends).toBe(1);
      const retry = workerHarness(f, await f.context.newPage(), "thread");
      await expect(retry.run()).rejects.toMatchObject({ code: "saved_conversation_unresolved", retryable: false });
      expect(retry.state).toMatchObject({ fresh: 0, full: 0, incremental: 0, sends: 0 });
      expect(f.store.read("thread")?.state).toBe("pending");
    });
  }, 15_000);
}


// Five real browser turns include their diagnostics and context cleanup in this case budget.
browserTest("Full temporary sessions save only after persistent promotion and reload rebinds tools", async () => {
  await fixture(async f => {
    const page = await f.context.newPage();
    const first = workerHarness(f, page, "full", { localTools: true, sessionMode: "temporary" });
    await expect(first.run()).rejects.toBe(first.finished);
    expect(page.url()).toBe(temporaryUrl);
    expect(f.store.lookup("full")).toBeUndefined();
    expect(first.state).toMatchObject({ full: 1, localTools: true });
    const next = workerHarness(f, page, "full", { localTools: true, sessionMode: "temporary", reused: true });
    await expect(next.run()).rejects.toBe(next.finished);
    expect(next.state).toMatchObject({ incremental: 1, localTools: true });
    expect(page.url()).toBe(temporaryUrl);
    const promote = workerHarness(f, page, "full", { localTools: true, sessionMode: "persistent", reused: true });
    await expect(promote.run()).rejects.toBe(promote.finished);
    expect(promote.state).toMatchObject({ incremental: 1, localTools: true, fresh: 0 });
    expect(f.store.lookup("full")?.url).toBe(parentUrl);
    expect(await page.locator("[data-user-message-bubble]").innerText()).toBe("Earlier question");
    const continued = workerHarness(f, page, "full", { localTools: true, sessionMode: "persistent", reused: true });
    await expect(continued.run()).rejects.toBe(continued.finished);
    expect(continued.state).toMatchObject({ incremental: 1, localTools: true });
    expect(page.url()).toBe(parentUrl);
    await page.close();
    const restored = workerHarness(f, await f.context.newPage(), "full", { localTools: true, sessionMode: "persistent" });
    await expect(restored.run()).rejects.toBe(restored.finished);
    expect(restored.state).toMatchObject({ incremental: 1, fresh: 0, localTools: true });
    expect(f.store.lookup("full")?.url).toBe(parentUrl);
  });
}, 90_000);

browserTest("Full ordinary effort first submission is saved with tools enabled", async () => {
  await fixture(async f => {
    const run = workerHarness(f, await f.context.newPage(), "full-default", { localTools: true });
    await expect(run.run()).rejects.toBe(run.finished);
    expect(run.state).toMatchObject({ fresh: 1, full: 1, localTools: true });
    expect(f.store.lookup("full-default")?.url).toBe(parentUrl);
  });
}, 15_000);

browserTest("an explicit temporary request cannot send on a retained saved-chat surface", async () => {
  await fixture(async f => {
    const original = f.store.bind("thread", f.store.reserve("thread"), parentUrl);
    const page = await f.context.newPage(); await page.goto(parentUrl);
    const attempt = workerHarness(f, page, "thread", { sessionMode: "temporary", reused: true });
    await expect(attempt.run()).rejects.toMatchObject({ code: "chatgpt_temporary_conversation_conflict", retryable: false });
    expect(attempt.state.sends).toBe(0);
    expect(page.url()).toBe(parentUrl);
    expect(f.store.lookup("thread")).toEqual(original);
  });
}, 15_000);


for (const behavior of ["assistant-only", "grouped-assistant-only"]) {
  browserTest("saved history restores with only a rendered assistant turn: " + behavior, async () => {
    await fixture(async ({ context, store }) => {
      store.bind("thread", store.reserve("thread"), parentUrl);
      const page = await context.newPage();
      await restoreSavedChatConversation(page, store.lookup("thread")!.url!, { timeoutMs: 500 });
      expect(page.url()).toBe(parentUrl);
      expect(await page.locator("[data-user-message-bubble], [data-message-author-role=user]").count()).toBe(0);
      expect(store.lookup("thread")?.url).toBe(parentUrl);
    }, behavior);
  });
}
