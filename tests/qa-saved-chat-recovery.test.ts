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
    const history = url.pathname.startsWith("/c/") && behavior !== "empty"
      ? '<article data-user-message-bubble>Earlier question</article><article data-message-author-role="assistant">Earlier answer</article>' : "";
    const composer = behavior === "no-composer" ? "" : '<form><div id="prompt-textarea" contenteditable="true"> </div></form>';
    return route.fulfill({ contentType: "text/html", body: '<html><body>' + history + composer + '</body></html>' });
  });
  try { await run({ root, context, store }); }
  finally { await context.close(); rmSync(root, { recursive: true, force: true }); }
}

test("direct QA workers use portable config defaults and preserve explicit Temporary Chat opt-out", () => {
  const base = { adapter: "chatgpt-web" as const, baseUrl: "browser://config-fixture" };
  expect(resolveBrowserConfig(base)).toMatchObject({ accountId: "default", useSavedChats: true,
    conversationStoreDirectory: join(getConfigDir(), "runtime", "conversations") });
  expect(resolveBrowserConfig({ ...base, chatgptWeb: { conversationStoreDirectory: "custom-chats" } }).conversationStoreDirectory)
    .toBe(join(getConfigDir(), "custom-chats"));
  for (const chatgptWeb of [{ useSavedChats: false }, { browserInteractionMode: "manual" as const }, { localToolsEnabled: true }]) {
    expect(resolveBrowserConfig({ ...base, chatgptWeb }).useSavedChats).toBeFalse();
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
      await expect(restoreSavedChatConversation(page, parentUrl, { timeoutMs: 250 }))
        .rejects.toMatchObject({ code: "saved_conversation_unavailable", retryable: false });
      expect(store.lookup("thread")?.url).toBe(parentUrl);
      expect(readdirSync(store.directory)).toHaveLength(1);
    }, behavior);
  });
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
  destination?: string; interrupted?: boolean; missingUrl?: boolean; wrongChatBeforeSend?: boolean; saved?: boolean; beforeSendFailure?: boolean;
} = {}) {
  const state = { fresh: 0, full: 0, incremental: 0, sends: 0, attached: "" };
  const worker: any = ChatGptBrowserWorker.forProvider({ adapter: "chatgpt-web", baseUrl: "browser://fixture-" + randomUUID(),
    chatgptWeb: { accountId: "account-1", useSavedChats: options.saved !== false, conversationStoreDirectory: f.root,
      browserDiagnosticsPath: join(f.root, "diagnostics"), storageStatePath: join(f.root, "browser-state.json") } });
  const finished = new Error("fixture: submission observed; no inference is performed");
  const interrupted = new Error("fixture: process interrupted after Send activation");
  Object.assign(worker, {
    prepareChatSurface: async (_page: Page, _capture: unknown, saved: boolean) => {
      state.fresh++; expect(saved).toBe(options.saved !== false); await page.goto("https://chatgpt.com/");
    },
    selectModelAndEffort: async () => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities),
    assertSelectedEffort: async () => {}, captureSubmissionBaseline: async () => ({}), attachFiles: async () => {},
    attachPromptWithCompactionRetry: async (_page: Page, text: string) => {
      state.attached = text;
      if (options.wrongChatBeforeSend) await page.goto(childUrl);
    },
    sendAttachedPrompt: async (_page: Page, _baseline: unknown, _capture: unknown, _signal: unknown,
      _progress: unknown, lifecycle: Pick<BrowserTurn, "onSendActivated" | "onSubmitted">) => {
      await lifecycle.onSendActivated?.();
      if (options.saved !== false) expect(f.store.read(key)?.state).toBe(state.fresh ? "pending" : "bound");
      state.sends++;
      if (options.interrupted) throw interrupted;
      if (options.missingUrl) {
        page.waitForURL = async () => { throw new Error("fixture: saved URL never appeared"); };
      } else if (state.fresh) await page.goto(options.destination ?? parentUrl);
      await lifecycle.onSubmitted?.();
      return "user_turn";
    },
    waitForNewAssistantTurn: async () => { throw finished; },
  });
  const turn: BrowserTurn = { traceId: randomUUID(), modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low", capabilities,
    retainConversation: true, conversationKey: key, onTextDelta() {},
    ...(options.beforeSendFailure ? { onSendActivated: async () => { throw interrupted; } } : {}),
    prepare: async () => { state.full++; return prompt("FULL: previous user question; previous assistant answer; latest child question"); },
    prepareResume: async () => { state.incremental++; return prompt("INCREMENTAL: latest question only"); },
  };
  return { state, finished, interrupted, run: () => worker.runBrowserTurn(turn, undefined, page) };
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
    expect(next.state).toMatchObject({ fresh: 0, full: 0, incremental: 1, sends: 1, attached: "INCREMENTAL: latest question only" });
    expect(next.state.attached).not.toContain("DO_NOT_IMPORT_CODEX_SYSTEM");
    expect(f.store.lookup("parent")?.url).toBe(parentUrl);
  });
}, 20_000);

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
}, 20_000);

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
