import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { TurnBroker, RemoteTurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { isRecoverableBrowserFailure, ChatGptSubmissionRejectionObserver } from "../src/adapters/chatgpt-web/browser-worker";

test("recovery atomically archives the original mapping and fences a stale writer", () => {
  const root = mkdtempSync(join(tmpdir(), "r42-map-"));
  try {
    const store = new ChatGptConversationStore(root, "isolated-account");
    const old = store.bind("thread", store.reserve("thread"), "https://chatgpt.com/c/original");
    const recovery = store.recover("thread", old);
    expect(() => store.lookup("thread")).toThrow("earlier ChatGPT submission");
    expect(() => store.bind("thread", old, "https://chatgpt.com/c/stale")).toThrow("another submission");
    const bound = store.bind("thread", recovery, "https://chatgpt.com/c/recovered");
    expect(bound.previous).toEqual([{ claim: old.claim, createdAt: old.createdAt, state: "bound", url: old.url }]);
    expect(new ChatGptConversationStore(root, "isolated-account").lookup("thread")).toEqual(bound);
    expect(() => store.recover("thread", old)).toThrow("no longer owns");
  } finally { rmSync(root, { recursive: true }); }
});

test("real broker socket rotates browser ingress but retains native owner and blocks late old claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "r42-rotate-"));
  const endpoint = join(root, "b.sock");
  const broker = TurnBroker.forSocket(endpoint);
  try {
    await broker.listen();
    const remote = new RemoteTurnBroker(endpoint);
    const owner = await remote.register({ cwd: root, roots: [root], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] }, 60_000, "recovery-test");
    const replacement = await remote.rotateForRecovery(owner);
    expect(replacement).toBeString();
    expect(replacement).not.toBe(owner);
    await expect(callTurnBroker(endpoint, { method: "claim", token: owner,
      activityId: "activity_1234567890123456" })).rejects.toThrow();
    expect(await remote.beginCompletionFence(owner)).toBe(0);
    const accepted = await callTurnBroker<{ bindingId: string }>(endpoint, { method: "claim", token: replacement,
      activityId: "activity_abcdefghijklmnop" });
    expect(accepted.bindingId).toBeString();
    // Any MCP activity, including an action whose outcome is not known, prevents another migration.
    expect(await remote.rotateForRecovery(owner)).toBeUndefined();
    expect(await remote.beginCompletionFence(owner)).toBeUndefined();
    await remote.revoke(owner);
    await expect(callTurnBroker(endpoint, { method: "claim", token: replacement,
      activityId: "activity_9876543210987654" })).rejects.toThrow();
  } finally { await broker.close(); rmSync(root, { recursive: true }); }
});

test("only browser/upstream failures are recoverable, never security, authentication or cancellation", () => {
  expect(isRecoverableBrowserFailure(new Error("ChatGPT browser stage timed out: browser_page"))).toBeTrue();
  expect(isRecoverableBrowserFailure(new ChatGptWebAdapterError("upstream", {
    status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true }))).toBeTrue();
  for (const status of [401, 403, 499]) expect(isRecoverableBrowserFailure(new ChatGptWebAdapterError("denied", {
    status, errorType: "error", code: "chatgpt_response_incomplete", retryable: true }))).toBeFalse();
  expect(isRecoverableBrowserFailure(new Error("invalid native permissions"))).toBeFalse();
});

test("owned browser HTTP502 and pre-response network failures terminate observation promptly, foreign requests do not", async () => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame });
  const errors: ChatGptWebAdapterError[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => errors.push(error));
  const makeRequest = (owner = frame) => ({ method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation",
    frame: () => owner, failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }) });
  observer.begin(page as unknown as Page);
  const foreign = makeRequest({}); page.emit("request", foreign);
  page.emit("response", { request: () => foreign, status: () => 502, headers: () => ({}) });
  expect(await observer.failure()).toBeUndefined();
  const request = makeRequest(); page.emit("request", request);
  page.emit("response", { request: () => request, status: () => 502, headers: () => ({}) });
  expect(errors).toHaveLength(1);
  expect(await observer.failure()).toMatchObject({ code: "chatgpt_submission_transient", status: 502, retryable: true });
  observer.begin(page as unknown as Page);
  const network = makeRequest(); page.emit("request", network); page.emit("requestfailed", network);
  expect(errors).toHaveLength(2);
  expect(await observer.failure()).toMatchObject({ code: "chatgpt_submission_transient", status: 502 });
  observer.dispose();
});

test("recovered ingress retains read-only observation proof across a real broker close/reopen without reviving old capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "r42-reopen-"));
  const endpoint = join(root, "b.sock");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const original = TurnBroker.forSocket(endpoint);
  let reopened: TurnBroker | undefined;
  try {
    const owner = await original.register({ cwd: root, roots: [root], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] }, 60_000, "recovered-observer");
    const first = original.rotateForRecovery(owner)!;
    const current = original.rotateForRecovery(owner)!;
    expect(() => original.inspectRetainedObservation(hash(current), "recovered-observer", {})).toThrow("still live");
    await original.close();
    reopened = TurnBroker.forSocket(endpoint);
    expect(reopened).not.toBe(original);
    expect(reopened.inspectRetainedObservation(hash(current), "recovered-observer", {})).toMatchObject({ digest: expect.any(String) });
    for (const stale of [owner, first]) expect(() => reopened!.inspectRetainedObservation(hash(stale), "recovered-observer", {})).toThrow();
    expect(() => reopened!.inspectRetainedObservation(hash(current), "foreign-trace", {})).toThrow();
    await reopened.listen();
    await expect(callTurnBroker(endpoint, { method: "claim", token: current, activityId: "activity_1234567890123456" })).rejects.toThrow();
  } finally { await original.close(); await reopened?.close(); rmSync(root, { recursive: true }); }
});
