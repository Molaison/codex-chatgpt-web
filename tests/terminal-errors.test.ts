import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { chromium, type Browser, type Page } from "playwright-core";
import { ChatGptSubmissionRejectionObserver, isRecoverableBrowserFailure, throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { readChatGptOwnedSseError } from "../src/adapters/chatgpt-web/browser-terminal-error";
import { retainsBrowserExecution } from "../src/adapters/chatgpt-web/submission-identity";

const fixture = readFileSync(new URL("./fixtures/chatgpt-terminal-error-shape-2026-10-28.html", import.meta.url), "utf8");
let browser: Browser;
beforeAll(async () => {
  if (process.env.CHATGPT_DOM_TEST_BROWSER) {
    browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  }
});
afterAll(async () => { await browser?.close(); });

const incomplete = { code: "chatgpt_bound_turn_incomplete", status: 502, retryable: false };

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("captured error ownership shape rejects localized retry without clicking or replaying", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const clicked: string[] = [];
    await page.exposeFunction("recordClick", (label: string) => { clicked.push(label); });
    await page.evaluate(() => document.addEventListener("click", event => {
      (globalThis as any).recordClick((event.target as Element).textContent ?? "");
    }));
    const failure = await throwIfChatGptTerminalErrorAlert(page.locator("#turn")).catch(error => error);
    expect(failure).toMatchObject(incomplete);
    expect(failure.message).toContain("signal=semantic-retry");
    expect(failure.message).not.toContain("生成回答");
    expect(isRecoverableBrowserFailure(failure)).toBeFalse();
    expect(retainsBrowserExecution(failure)).toBeTrue();
    expect(clicked).toEqual([]);
  } finally { await page.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("localized error without a legacy testid or retry action is detected", async () => {
  const page = await browser.newPage();
  try {
    for (const text of ["生成回答时出错，请稍后再试。", "發生錯誤，請稍後再試。", "An error occurred while generating the response."]) {
      await page.setContent(fixture);
      await page.locator("#failure button").evaluate(button => button.remove());
      await page.locator("#error-text").evaluate((node, value) => { node.textContent = value; }, text);
      const failure = await throwIfChatGptTerminalErrorAlert(page.locator("#turn")).catch(error => error);
      expect(failure).toMatchObject(incomplete);
      expect(failure.message).toContain("signal=localized-error");
    }
  } finally { await page.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("semantic retry in a small error panel works without role=alert", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture.replace('role="alert"', 'class="error-panel"'));
    const failure = await throwIfChatGptTerminalErrorAlert(page.locator("#turn")).catch(error => error);
    expect(failure).toMatchObject(incomplete);
  } finally { await page.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an unclassified idle alert becomes diagnostic incomplete after a stable grace", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    await page.locator("#failure button").evaluate(button => button.remove());
    await page.locator("#error-text").evaluate(node => { node.textContent = "Unfamiliar service state."; });
    const bound = page.locator("#turn");
    await throwIfChatGptTerminalErrorAlert(bound, { now: 0 });
    await throwIfChatGptTerminalErrorAlert(bound, { now: 1_999 });
    const failure = await throwIfChatGptTerminalErrorAlert(bound, { now: 2_000 }).catch(error => error);
    expect(failure).toMatchObject(incomplete);
    expect(failure.message).toContain("signal=unclassified-alert");
    expect(isRecoverableBrowserFailure(failure)).toBeFalse();
  } finally { await page.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an open owned stream or live tool result defers DOM error classification", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const bound = page.locator("#turn");
    await throwIfChatGptTerminalErrorAlert(bound, { responseStreamActive: true });
    await throwIfChatGptTerminalErrorAlert(bound, { externalProgressLive: true });
    await throwIfChatGptTerminalErrorAlert(bound, { running: true });
    const failure = await throwIfChatGptTerminalErrorAlert(bound).catch(error => error);
    expect(failure).toMatchObject(incomplete);
    await page.locator("body").evaluate(body => body.insertAdjacentHTML("beforeend", '<button data-testid="stop-button">Stop</button>'));
    await throwIfChatGptTerminalErrorAlert(bound);
  } finally { await page.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("errors quoted by users, answers, tools or approval surfaces are not terminal UI", async () => {
  const page = await browser.newPage();
  try {
    const alert = '<div role="alert">生成回答时出错<button aria-label="重试">重试</button></div>';
    for (const wrapper of [
      '<div data-user-message-bubble>CONTENT</div>',
      '<div data-content-search-unit-key="fixture:user"><h4 data-conversation-role="user"></h4>CONTENT</div>',
      '<div data-markdown-text-style="assistant-message">CONTENT</div>',
      '<div class="markdown">CONTENT</div>',
      '<pre>CONTENT</pre>',
      '<div data-tool-result>CONTENT</div>',
      '<div data-tool-output>CONTENT</div>',
      '<div data-streaming-response-status>CONTENT</div>',
      '<div><span hidden data-chatgpt-agent-turn-start></span>CONTENT</div>',
      '<div data-codex-approval-surface>CONTENT</div>',
      '<div data-testid="tool-approval-card">CONTENT</div>',
      '<div role="dialog">CONTENT</div>',
      '<div data-turn-key="foreign">CONTENT</div>',
    ]) {
      await page.setContent('<div id="turn" data-turn-key="bound">' + wrapper.replace("CONTENT", alert) + "</div>");
      await throwIfChatGptTerminalErrorAlert(page.locator("#turn"), { now: 0 });
      await throwIfChatGptTerminalErrorAlert(page.locator("#turn"), { now: 3_000 });
    }
    await page.setContent('<div id="turn" data-turn-key="bound"></div>' + alert);
    await throwIfChatGptTerminalErrorAlert(page.locator("#turn"));
  } finally { await page.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("generation and approval notices do not become terminal even after the grace", async () => {
  const page = await browser.newPage();
  try {
    for (const text of ["Generating…", "正在生成回答", "Waiting for tool approval", "Allow ChatGPT to use this tool?"]) {
      await page.setContent('<div id="turn" data-turn-key="bound"><div role="alert">' + text + "</div></div>");
      await throwIfChatGptTerminalErrorAlert(page.locator("#turn"), { now: 0 });
      await throwIfChatGptTerminalErrorAlert(page.locator("#turn"), { now: 3_000 });
    }
    await page.setContent(fixture.replace('role="alert"', 'role="alert" hidden'));
    await throwIfChatGptTerminalErrorAlert(page.locator("#turn"));
  } finally { await page.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("live-stream suppression resets the unknown-alert grace", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="turn" data-turn-key="bound"><div role="alert">Unfamiliar service state</div></div>');
    const bound = page.locator("#turn");
    await throwIfChatGptTerminalErrorAlert(bound, { now: 0 });
    await throwIfChatGptTerminalErrorAlert(bound, { now: 2_000, responseStreamActive: true });
    await throwIfChatGptTerminalErrorAlert(bound, { now: 10_000 });
    const failure = await throwIfChatGptTerminalErrorAlert(bound, { now: 12_000 }).catch(error => error);
    expect(failure).toMatchObject(incomplete);
  } finally { await page.close(); }
});

test("owned SSE classification uses only service fields and preserves the exact size-error case", () => {
  const sse = (event: unknown) => "data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n";
  expect(readChatGptOwnedSseError(sse({ error: "Oops", error_code: "input_too_large", error_reason: "last_user_message" })))
    .toEqual({ kind: "size", code: "input_too_large" });
  expect(readChatGptOwnedSseError(sse({ error: "Oops", error_code: "server_error" })))
    .toEqual({ kind: "terminal", code: "server_error" });
  expect(readChatGptOwnedSseError(sse({ error: { code: "server_error" } })))
    .toEqual({ kind: "terminal", code: "server_error" });
  expect(readChatGptOwnedSseError('event: error\r\ndata: {"message":"Service ended"}\r\n\r\n'))
    .toEqual({ kind: "terminal", code: "sse_error" });
  for (const event of [
    { message: { content: { parts: ['{"error":"Oops","error_code":"server_error"}'] } } },
    { v: { error: "Oops", error_code: "server_error" } },
    { error: "Only model text without a service code" }, null,
  ]) expect(readChatGptOwnedSseError(sse(event))).toBeUndefined();
});

test("owned SSE errors wait for stream end, reject foreign/stale streams and never enter auto recovery", async () => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame, isClosed: () => false });
  const failures: unknown[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => failures.push(error));
  observer.begin(page as unknown as Page);
  const stream = (owner: object = frame) => {
    const request = { method: () => "POST", frame: () => owner, url: () => "https://chatgpt.com/backend-api/f/conversation" };
    page.emit("request", request);
    page.emit("response", { request: () => request, status: () => 200,
      headers: () => ({ "content-type": "text/event-stream" }),
      text: async () => 'data: {"error":"Service failed","error_code":"server_error"}\n\n' });
    return request;
  };
  const foreign = stream({});
  page.emit("requestfinished", foreign);
  expect(await observer.failure()).toBeUndefined();
  const owned = stream();
  expect(observer.hasActiveResponse()).toBeTrue();
  expect(await observer.failure()).toBeUndefined();
  expect(failures).toHaveLength(0);
  page.emit("requestfinished", owned);
  expect(observer.hasActiveResponse()).toBeFalse();
  const failure = await observer.failure();
  expect(failure).toMatchObject(incomplete);
  expect(isRecoverableBrowserFailure(failure)).toBeFalse();
  expect(retainsBrowserExecution(failure)).toBeTrue();
  expect(failures).toHaveLength(1);
  observer.begin(page as unknown as Page);
  page.emit("requestfinished", owned);
  expect(await observer.failure()).toBeUndefined();
  observer.dispose();
});
