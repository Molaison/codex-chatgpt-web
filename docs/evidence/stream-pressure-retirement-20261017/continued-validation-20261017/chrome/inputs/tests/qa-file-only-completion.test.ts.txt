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


async function paperAnswerFixture(page: Page) {
  await page.setContent(`<section id="turn" data-turn-key="fixture-current">
    <div data-streaming-response-status>
      <span hidden data-chatgpt-agent-turn-start></span>
      <div role="status">Reading the paper</div>
      <div data-markdown-text-style="assistant-message"><p>Checking the cited result.</p></div>
    </div>
    <div data-content-search-unit-key="fixture:1:assistant">
      <h4 data-conversation-role="assistant">Assistant</h4>
      <div id="answer" data-markdown-text-style="assistant-message">
        <p data-start="0" data-end="99">Draft claim with <a href="https://example.org/draft">source</a>.</p>
        <p data-start="100" data-end="150">Final paragraph.</p>
      </div>
    </div>
    <button data-testid="copy-turn-action-button">Copy</button>
  </section><button data-testid="stop-button">Stop</button>`);
}

realBrowserTest("papers waits for browser completion and emits the rewritten final text and citation exactly once", async () => {
  await withFixture(async (page, root, baseUrl) => {
    await paperAnswerFixture(page);
    const { worker, turn, deltas, readyForObservation } = fixtureWorker(page, root, baseUrl);
    turn.deferTextUntilComplete = true;
    const reasoning: string[] = [], commentary: string[] = [];
    turn.onReasoningSummary = text => reasoning.push(text);
    turn.onCommentary = text => commentary.push(text);
    let completed = false;
    const answer = worker.runBrowserTurn(turn, undefined, page).then(text => { completed = true; return text; }, error => error);
    await readyForObservation;
    // Exceeds both incremental Markdown stability and the completion settle interval.
    await page.waitForTimeout(2300);
    expect(deltas).toEqual([]);
    expect(completed).toBe(false);
    expect(reasoning.join("")).toContain("Reading the paper");
    expect(commentary.join("")).toContain("Checking the cited result.");
    await page.locator('#answer p').first().evaluate(element => {
      element.innerHTML = 'Corrected claim with <a href="https://example.org/final#evidence">source</a>.';
    });
    await page.locator('[data-testid="stop-button"]').evaluate(element => element.remove());
    const result = await answer;
    expect(result).toBe("Corrected claim with [source](https://example.org/final#evidence).\n\nFinal paragraph.");
    expect(deltas).toEqual([result]);
    expect(completed).toBe(true);
  });
}, 15_000);

realBrowserTest("papers never publishes an unfinished answer or a failed completion", async () => {
  await withFixture(async (page, root, baseUrl) => {
    for (const failureKind of ["no-completion-evidence", "rejected-answer"]) {
      await paperAnswerFixture(page);
      await page.locator('[data-testid="stop-button"]').evaluate(element => element.remove());
      if (failureKind === "no-completion-evidence") {
        await page.locator('[data-testid="copy-turn-action-button"]').evaluate(element => element.remove());
      } else {
        await page.locator('#answer').evaluate(element => { element.innerHTML = '<p>api_tool unavailable</p>'; });
      }
      const { worker, turn, deltas, released } = fixtureWorker(page, root, baseUrl, { timeoutMs: 4500 });
      turn.deferTextUntilComplete = true;
      const failure = await worker.runBrowserTurn(turn, undefined, page).then(() => undefined, error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain(failureKind === "no-completion-evidence" ? "timed out" : "api_tool unavailable");
      expect(deltas).toEqual([]);
      expect(released()).toBe(true);
    }
  });
}, 20_000);

realBrowserTest("ordinary QA and Full retain strict incremental Markdown consistency", async () => {
  await withFixture(async (page, root, baseUrl) => {
    for (const localTools of [false, true]) {
      await paperAnswerFixture(page);
      const { worker, turn, deltas, readyForObservation } = fixtureWorker(page, root, baseUrl, { localTools });
      const result = worker.runBrowserTurn(turn, undefined, page).then(() => undefined, error => error);
      await readyForObservation;
      await page.waitForTimeout(1300);
      expect(deltas.join("")).toContain("Draft claim with [source](https://example.org/draft).");
      await page.locator('#answer p').first().evaluate(element => {
        element.innerHTML = 'Corrected claim with <a href="https://example.org/final#evidence">source</a>.';
      });
      await page.locator('[data-testid="stop-button"]').evaluate(element => element.remove());
      const failure = await result;
      expect(failure).toMatchObject({ code: "browser_stream_inconsistent", retryable: false });
      expect(deltas.join("")).not.toContain("Corrected claim");
    }
  });
}, 20_000);
