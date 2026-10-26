import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker, waitForSavedChatUrl } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

const saved = "https://chatgpt.com/c/6addf05e-2498-83e9-a52a-b6f095d05218";

test("saved route uses the original Send budget, not an independent navigation/load deadline", async () => {
  let route = "https://chatgpt.com/";
  const page = {
    url: () => route,
    waitForURL: async (predicate: (url: URL) => boolean, options: unknown) => {
      expect(options).toEqual({ timeout: 0, waitUntil: "commit" });
      expect(predicate(new URL(route))).toBe(false);
      expect(predicate(new URL("https://chatgpt.com/c/local-chatgpt%3Aa9683b7f-113b-4e0e-9a12-880d038fbb64"))).toBe(false);
      expect(predicate(new URL(saved + "?temporary-chat=true"))).toBe(false);
      expect(predicate(new URL("https://example.com/c/foreign"))).toBe(false);
      route = saved + "?model=thinking";
      expect(predicate(new URL(route))).toBe(true);
    },
  } as unknown as Page;
  expect(await waitForSavedChatUrl(page, new AbortController().signal)).toBe(saved);
});

test("the parent acceptance budget cancels a still-pending route without inventing a saved URL", async () => {
  const controller = new AbortController();
  const page = { waitForURL: () => new Promise<void>(() => {}), url: () => "https://chatgpt.com/" } as unknown as Page;
  const result = waitForSavedChatUrl(page, controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});

test("a lost original transport remains an error rather than accepting another page", async () => {
  const lost = new Error("Original owned page closed");
  const page = { waitForURL: async () => { throw lost; } } as unknown as Page;
  await expect(waitForSavedChatUrl(page, new AbortController().signal)).rejects.toBe(lost);
});

test("a changed pre-Send model surface is reselected once and strictly verified again", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const changed = new ChatGptWebAdapterError("changed", { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false, diagnostics: { stage: "model_selection" } });
  const original = { effort: "high", modelFamily: "6" };
  const restored = { ...original, selection: { url: "fresh proof" } };
  let checks = 0, notices = 0, selections = 0;
  worker.assertSelectedEffort = async (_: unknown, mode: unknown) => {
    checks++;
    if (checks === 1) throw changed;
    expect(mode).toBe(restored);
  };
  expect(await worker.reconcileSelectedEffortBeforeSend({}, original, async () => { selections++; return restored; }, () => notices++)).toBe(restored);
  expect({ checks, selections, notices }).toEqual({ checks: 2, selections: 1, notices: 1 });
  worker.assertSelectedEffort = async () => { throw changed; };
  await expect(worker.reconcileSelectedEffortBeforeSend({}, original, async () => restored)).rejects.toBe(changed);
});

test("authentication failures cannot enter pre-Send model reconciliation", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const denied = new ChatGptWebAdapterError("sign in", { status: 401, errorType: "authentication_error", code: "chatgpt_sign_in_required", retryable: false });
  worker.assertSelectedEffort = async () => { throw denied; };
  await expect(worker.reconcileSelectedEffortBeforeSend({}, {}, async () => { throw Error("must not reselect"); })).rejects.toBe(denied);
});
