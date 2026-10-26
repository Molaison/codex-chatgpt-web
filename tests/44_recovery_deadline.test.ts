import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, restoreSavedChatConversation } from "../src/adapters/chatgpt-web/browser-worker";

test("a stage cannot refund elapsed absolute deadline as host suspension", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const started = Date.now();
  let calls = 0;
  let aborted = false;
  const work = (signal: AbortSignal) => {
    calls++;
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  };
  await expect(worker.runStage("deadline", "fixture", 30_000, work,
    { suspendedMs: () => Date.now() - started }, false, started + 35)).rejects.toThrow("timed out");
  expect(calls).toBe(1);
  expect(aborted).toBe(true);
}, 2000);

test("an expired operation cannot begin another stage or Send", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  let calls = 0;
  await expect(worker.runStage("expired", "send", 1000, async () => { calls++; },
    undefined, false, Date.now() - 1)).rejects.toMatchObject({ code: "chatgpt_recovery_budget_exhausted", retryable: false });
  expect(calls).toBe(0);
});

test("a stricter local stage limit still applies with a later operation deadline", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  let aborted = false;
  await expect(worker.runStage("local", "fixture", 25, (signal: AbortSignal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(() => {});
  }, undefined, false, Date.now() + 30_000)).rejects.toThrow("timed out");
  expect(aborted).toBe(true);
}, 2000);

test("saved-chat restoration shares one deadline across sequential history and composer waits", async () => {
  let waits = 0;
  let retries = 0;
  const locator = {
    filter() { return this; },
    first() { return this; },
    waitFor: async () => {
      waits++;
      if (waits === 1) await new Promise(resolve => setTimeout(resolve, 15));
      else await new Promise(() => {});
    },
  };
  const saved = "https://chatgpt.com/c/original";
  const page = { url: () => saved, locator: () => locator } as any;
  await expect(restoreSavedChatConversation(page, saved, {
    deadlineAt: Date.now() + 60, onRetry: () => { retries++; },
  })).rejects.toMatchObject({ code: "chatgpt_recovery_budget_exhausted", retryable: false });
  expect(waits).toBe(2);
  expect(retries).toBe(0);
}, 2000);
