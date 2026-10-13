import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker, type BrowserTurn, type ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { serveGeneratedFile } from "../src/generated-files";

const fixture = readFileSync(new URL("./fixtures/chatgpt-file-only-complete.html", import.meta.url), "utf8");
const capabilities = { solAvailable: true, extraHighAvailable: false, proAvailable: false, localToolsEnabled: false };
const realBrowserTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);

// Only preparation/submission are replaced: the production response loop, snapshot cache,
// health/completion checks, native Blob collector and final answer publication all run.
function fixtureWorker(page: Page, root: string, baseUrl: string, options: {
  downloadDirectory?: boolean; downloadBaseUrl?: boolean; localTools?: boolean; timeoutMs?: number;
} = {}) {
  const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", { ...capabilities, localToolsEnabled: options.localTools === true });
  let ready!: () => void;
  const readyForObservation = new Promise<void>(resolve => { ready = resolve; });
  const config = {
    appName: "file-only-fixture", browserHost: "launcher", useSavedChats: false,
    browserDiagnosticsPath: join(root, "diagnostics"),
    ...(options.downloadDirectory === false ? {} : { downloadDirectory: join(root, "downloads") }),
    ...(options.downloadBaseUrl === false ? {} : { downloadBaseUrl: baseUrl }),
    turnTimeoutMs: options.timeoutMs ?? 10_000,
  } as ResolvedBrowserConfig;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config,
    prepareChatSurface: async () => {},
    selectModelAndEffort: async () => mode,
    captureSubmissionBaseline: async () => ({
      userTurns: page.locator("#user"), responseTurns: page.locator("#turn"),
      initialTurnIdentities: [], domCache: {},
    }),
    attachPromptWithCompactionRetry: async () => {},
    sendAttachedPrompt: async () => "user_turn",
    waitForNewAssistantTurn: async () => {
      ready();
      return { identity: "fixture-current", locator: page.locator("#turn"), acceptedTurnIdentities: ["fixture-current"] };
    },
  }) as {
    runBrowserTurn(turn: BrowserTurn, surface: undefined, page: Page): Promise<string>;
    responseDomSnapshot(response: Locator, cache?: object): Promise<{ downloadableFiles: string[] }>;
  };
  const deltas: string[] = [];
  let released = false;
  const turn: BrowserTurn = {
    traceId: "file-only-fixture", modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low",
    capabilities: { ...capabilities, localToolsEnabled: options.localTools === true },
    prepare: async () => ({ text: "Create a fixture CSV", images: [], release: () => { released = true; } }),
    onTextDelta: delta => { deltas.push(delta); },
  };
  return { worker, turn, deltas, readyForObservation, released: () => released };
}

async function withFixture(run: (page: Page, root: string, baseUrl: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "qa-file-only-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req =>
    serveGeneratedFile(req, join(root, "downloads")) ?? new Response(null, { status: 404 }) });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    await page.setContent(fixture);
    await page.evaluate(() => {
      (window as any).downloadClicks = 0;
      document.querySelector('button[aria-label="下载文件"]')!.addEventListener("click", () => {
        (window as any).downloadClicks += 1;
        const url = URL.createObjectURL(new Blob(["name,value\nalpha,1\n"], { type: "text/csv" }));
        const link = document.createElement("a"); link.href = url; link.download = "report.csv";
        document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      });
    });
    await run(page, root, server.url.href);
  } finally {
    await browser.close(); await server.stop(true); rmSync(root, { recursive: true, force: true });
  }
}

realBrowserTest("file-only production response waits for generation and returns a byte-exact real download link", async () => {
  await withFixture(async (page, root, baseUrl) => {
    await page.evaluate(() => {
      const stop = document.createElement("button"); stop.dataset.testid = "stop-button"; stop.textContent = "Stop";
      document.body.append(stop);
    });
    const { worker, turn, deltas, readyForObservation, released } = fixtureWorker(page, root, baseUrl);
    const answer = worker.runBrowserTurn(turn, undefined, page);
    await readyForObservation;
    await page.waitForTimeout(650);
    expect(await page.evaluate(() => (window as any).downloadClicks)).toBe(0);
    expect(deltas).toEqual([]);
    await page.locator('[data-testid="stop-button"]').evaluate(element => element.remove());
    const result = await answer;
    expect(result.startsWith("[report.csv](<")).toBeTrue();
    expect(deltas).toEqual([result]);
    const url = result.slice("[report.csv](<".length, -2);
    expect(new URL(url).origin).toBe(new URL(baseUrl).origin);
    const downloaded = await fetch(url);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("name,value\nalpha,1\n");
    expect(await page.evaluate(() => (window as any).downloadClicks)).toBe(1);
    expect(released()).toBeTrue();
  });
}, 20_000);

realBrowserTest("native card cache notices title and enabled-state changes while keeping hover-only controls valid", async () => {
  await withFixture(async (page, root, baseUrl) => {
    const { worker } = fixtureWorker(page, root, baseUrl);
    const cache = {};
    const response = page.locator("#turn");
    expect((await worker.responseDomSnapshot(response, cache)).downloadableFiles).toEqual(["report.csv"]);
    await page.locator('button[aria-label="下载文件"]').evaluate(button => button.setAttribute("disabled", ""));
    expect((await worker.responseDomSnapshot(response, cache)).downloadableFiles).toEqual([]);
    await page.locator('button[aria-label="下载文件"]').evaluate(button => button.removeAttribute("disabled"));
    await page.locator('span[title]').evaluate(span => span.setAttribute("title", "changed.csv"));
    expect((await worker.responseDomSnapshot(response, cache)).downloadableFiles).toEqual(["changed.csv"]);
  });
}, 10_000);

realBrowserTest("file-only cards cannot finish without both download settings or during compaction and local-tools turns", async () => {
  await withFixture(async (page, root, baseUrl) => {
    for (const options of [
      { downloadDirectory: false }, { downloadBaseUrl: false }, { localTools: true }, { compaction: true },
    ]) {
      // Longer than the real 2s completion settle interval: a wrongly enabled
      // file-only path would publish a link and fail this assertion.
      const { worker, turn, deltas } = fixtureWorker(page, root, baseUrl, { ...options, timeoutMs: 5_000 });
      if ("compaction" in options) turn.compaction = true;
      const failure = await worker.runBrowserTurn(turn, undefined, page).then(() => undefined, error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("timed out");
      expect(deltas).toEqual([]);
      expect(await page.evaluate(() => (window as any).downloadClicks)).toBe(0);
    }
  });
}, 40_000);

realBrowserTest("vanished card at download time fails instead of publishing an empty or invented answer", async () => {
  await withFixture(async (page, root, baseUrl) => {
    const { worker, turn, deltas } = fixtureWorker(page, root, baseUrl);
    // The completion fence emulates a card disappearing after the final confirmed snapshot.
    turn.externalProgress = new ChatGptExternalTurnProgress();
    turn.completionFence = { begin: async () => 1, commit: async () => {
      await page.locator('[class~="group/resource-row"]').evaluate(element => element.remove()); return true;
    } };
    const failure = await worker.runBrowserTurn(turn, undefined, page).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("file-only answer did not yield a downloadable file");
    expect(deltas).toEqual([]);
    expect(await page.evaluate(() => (window as any).downloadClicks)).toBe(0);
  });
}, 15_000);
