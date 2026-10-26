import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { restoreSavedChatConversation } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError, parseChatGptSavedConversationDiagnostics } from "../src/adapters/chatgpt-web/adapter-error";
setDefaultTimeout(15_000);
let browser: Browser;
beforeAll(async () => {
  if (!process.env.CHATGPT_DOM_TEST_BROWSER) throw new Error("Local Chromium is required for rev42 DOM acceptance");
  browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => { await browser?.close(); });
const url = "https://chatgpt.com/c/fixture-saved";
const history = '<article data-user-message-bubble>Synthetic earlier answer</article>';
const composer = '<form><div id="prompt-textarea" contenteditable="true" style="min-height:30px"> </div><button onclick="window.sends++">Send</button></form>';
async function fixture(mode: string, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  let requests = 0;
  await context.route("**/*", route => {
    requests++;
    if (mode === "recover-http" && requests === 1) return route.fulfill({ status: 502, body: "Transient gateway failure" });
    if (mode === "http") return route.fulfill({ status: 502, body: "Synthetic failure" });
    // A route handler intercepts only the first request in an HTTP redirect chain.
    // Exercise the real URL check using a local SPA redirect, never an external fetch.
    const redirect = mode === "redirect" ? "/c/other" : mode === "login" ? "/auth/login" : undefined;
    return route.fulfill({ contentType: "text/html", body: '<script>window.sends=0;' + (redirect ? `history.replaceState(null,"",${JSON.stringify(redirect)});` : "") + '</script>'
      + (mode === "history" ? "" : history) + (mode === "composer" ? "" : composer)
      + (mode === "auth" ? '<div role="alert">Your session has expired</div>' : "") });
  });
  try { await run(await context.newPage()); } finally { await context.close(); }
}
async function failure(page: Page) {
  try { await restoreSavedChatConversation(page, url, { timeoutMs: 1500 }); }
  catch (error) {
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect(error).toMatchObject({ status: 409, code: "saved_conversation_unavailable", retryable: false });
    const diagnostics = (error as ChatGptWebAdapterError).diagnostics!;
    expect(diagnostics).toEqual(parseChatGptSavedConversationDiagnostics(diagnostics));
    expect(diagnostics.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(diagnostics)).not.toMatch(/https?:|@|<|secret|Synthetic/);
    return diagnostics;
  }
  throw new Error("Expected restore failure");
}
test("restore records sanitized CONNECT cause without URL or message disclosure", async () => {
  await fixture("normal", async page => {
    page.goto = async () => { throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED https://chatgpt.com/c/secret?token=secret user@example.org <html>secret</html>"); };
    expect(await failure(page)).toMatchObject({ stage: "navigation", cause_code: "ERR_TUNNEL_CONNECTION_FAILED", http_status: "unavailable", canonical_match: "unavailable", history: "unavailable", composer: "unavailable", auth: "unavailable" });
  });
});
for (const [mode, expected] of [
  ["http", { stage: "navigation", cause_code: "http_error", http_status: 502 }],
  ["redirect", { stage: "saved URL verification", cause_code: "canonical_mismatch", canonical_match: false }],
  ["history", { stage: "history", cause_code: "timeout", canonical_match: true, history: false, composer: "unavailable" }],
  ["composer", { stage: "composer", cause_code: "timeout", history: true, composer: false }],
  ["auth", { stage: "authentication", cause_code: "authentication_required", history: true, composer: true, auth: false }],
  ["login", { stage: "saved URL verification", canonical_match: false, auth: false }],
] as const) test(`restore distinguishes ${mode} without Send`, async () => {
  await fixture(mode, async page => {
    expect(await failure(page)).toMatchObject(expected);
    expect(await page.evaluate(() => (window as any).sends ?? 0)).toBe(0);
  });
});
test("canonical project slug/query changes preserve restored history without a new navigation", async () => {
  await fixture("normal", async page => {
    const project = `https://chatgpt.com/g/g-p-${"a".repeat(32)}`;
    await page.goto(`${project}-title/c/fixture-saved/?secret=query`);
    let navigations = 0;
    page.goto = async () => { navigations++; throw new Error("Unexpected navigation"); };
    let capture = "";
    await restoreSavedChatConversation(page, `${project}/c/fixture-saved`, { capture: async checkpoint => { capture = checkpoint; } });
    expect(navigations).toBe(0); expect(capture).toBe("saved-chat-restored");
    expect(await page.evaluate(() => (window as any).sends)).toBe(0);
  });
});
test("restore cancellation keeps AbortError", async () => {
  await fixture("normal", async page => {
    const controller = new AbortController(); controller.abort();
    await expect(restoreSavedChatConversation(page, url, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

test("transient saved-chat HTTP failure restores the original page without another Send", async () => {
  await fixture("recover-http", async page => {
    const retries: number[] = [];
    await restoreSavedChatConversation(page, url, { timeoutMs: 1500, onRetry: attempt => retries.push(attempt) });
    expect(retries).toEqual([1]);
    expect(page.url()).toBe(url);
    expect(await page.locator('[data-user-message-bubble]').count()).toBe(1);
    expect(await page.evaluate(() => (window as any).sends)).toBe(0);
  });
});

test("restore diagnostics reject arbitrary payloads and unknown machine codes", () => {
  const safe = { stage: "navigation", cause_code: "unavailable", http_status: "unavailable", elapsed_ms: 0,
    canonical_match: "unavailable", history: "unavailable", composer: "unavailable", auth: "unavailable" };
  for (const unsafe of [
    { ...safe, raw_url: "https://chatgpt.com/c/private" }, { ...safe, stage: "user@example.org" },
    { ...safe, cause_code: "ERR_PRIVATE_TOKEN" }, { ...safe, http_status: "<html>" },
    { ...safe, elapsed_ms: -1 }, { ...safe, composer: "secret" }, { ...safe, auth: true },
  ]) expect(() => parseChatGptSavedConversationDiagnostics(unsafe)).toThrow("diagnostics are invalid");
});
