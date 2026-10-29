import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Locator } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

const fixture = readFileSync(new URL("./fixtures/chatgpt-unwrapped-complete-2026-10-28.html", import.meta.url), "utf8");
const actions = fixture.match(/<!--ASSISTANT_ACTIONS_START-->[\s\S]*?<!--ASSISTANT_ACTIONS_END-->/)![0];
let browser: Browser;

type Snapshot = { responsePresent: boolean; visibleText: string; completionActionVisible: boolean };
type Cache = { key?: string; snapshot?: Snapshot; fullScans?: number; cacheHits?: number };
const worker = Object.create(ChatGptBrowserWorker.prototype) as {
  responseDomSnapshot(locator: Locator, cache: Cache): Promise<Snapshot>;
};

beforeAll(async () => {
  if (process.env.CHATGPT_DOM_TEST_BROWSER) {
    browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  }
});

afterAll(async () => { await browser?.close(); });

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a late completion footer invalidates the empty cached projection", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture.replace(actions, ""));
    const cache: Cache = {};
    const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect((await observe()).visibleText).toBe("");
    expect((await observe()).completionActionVisible).toBeFalse();
    expect(cache.cacheHits).toBe(1);
    await page.locator("#turn").evaluate((root, html) => root.insertAdjacentHTML("beforeend", html), actions);
    const complete = await observe();
    expect(complete.visibleText).toContain("Configuration checked.");
    expect(complete.completionActionVisible).toBeTrue();
    expect(cache.fullScans).toBe(2);
  } finally { await page.close(); }
}, 10_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a remounted turn with the same key replaces the old cached projection", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const cache: Cache = {};
    const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect((await observe()).visibleText).toContain("Configuration checked.");
    const oldKey = cache.key;
    await page.locator("#turn").evaluate((root, html) => { root.outerHTML = html; },
      fixture.replace("Configuration checked.", "Remounted final answer."));
    const remounted = await observe();
    expect(remounted.visibleText).toContain("Remounted final answer.");
    expect(remounted.visibleText).not.toContain("Configuration checked.");
    expect(remounted.completionActionVisible).toBeTrue();
    expect(cache.key).not.toBe(oldKey);
  } finally { await page.close(); }
}, 10_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a virtualized missing turn is absent, then the same locator reads its remount", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const cache: Cache = {};
    const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect((await observe()).completionActionVisible).toBeTrue();
    await page.locator("#turn").evaluate(root => root.remove());
    const missing = await observe();
    expect(missing.responsePresent).toBeFalse();
    expect(missing.completionActionVisible).toBeFalse();
    expect(missing.visibleText).toBe("");
    await page.locator("body").evaluate((body, html) => { body.innerHTML = html; }, fixture);
    const remounted = await observe();
    expect(remounted.responsePresent).toBeTrue();
    expect(remounted.completionActionVisible).toBeTrue();
    expect(remounted.visibleText).toContain("Configuration checked.");
  } finally { await page.close(); }
}, 10_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an outside footer is ignored until attached to its bound turn", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture.replace(actions, "") + '<div id="outside">' + actions + "</div>");
    const cache: Cache = {};
    const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect((await observe()).completionActionVisible).toBeFalse();
    await page.locator("#turn").evaluate(root => {
      const footer = document.querySelector("#outside .turn-action-controls")!;
      root.appendChild(footer);
    });
    expect((await observe()).completionActionVisible).toBeTrue();
  } finally { await page.close(); }
}, 10_000);
