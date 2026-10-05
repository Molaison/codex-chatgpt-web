import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, type BrowserTurn, type ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { preserveChatGptResponseImages } from "../src/adapters/chatgpt-web/response-images";
import { serveGeneratedFile, purgeExpiredGeneratedFiles, GENERATED_FILE_TTL_MS } from "../src/generated-files";

const realBrowserTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);
const capabilities = { solAvailable: true, extraHighAvailable: false, proAvailable: false, localToolsEnabled: false };

async function fixture(run: (page: Page, root: string, baseUrl: string, source: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "qa-images-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req =>
    serveGeneratedFile(req, join(root, "downloads")) ?? new Response(null, { status: 404 }) });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const source = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 192;
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#2879dc"; ctx.fillRect(0, 0, 256, 192);
      return canvas.toDataURL("image/png");
    });
    await page.setContent('<section id="turn" data-turn-key="test-current"><div data-content-search-unit-key="test:1:assistant">'
      + '<h4 data-conversation-role="assistant" style="display:none">Assistant</h4>'
      + '<div data-markdown-text-style="assistant-message"></div>'
      + '<button aria-label="Open image"><img alt="Generated image" width="256" height="192" src="' + source + '"></button>'
      + '</div><button data-testid="copy-turn-action-button">Copy</button></section>');
    await page.locator('img').evaluate(async element => (element as HTMLImageElement).decode());
    await run(page, root, server.url.href, source);
  } finally { await browser.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); }
}

function workerFor(page: Page, root: string, baseUrl?: string) {
  const config = { appName: "image-fixture", browserHost: "launcher", useSavedChats: false,
    storageStatePath: join(root, "browser", "state.json"), imageOutputDirectory: join(root, "images"),
    browserDiagnosticsPath: join(root, "diagnostics"), turnTimeoutMs: 10_000,
    ...(baseUrl ? { downloadDirectory: join(root, "downloads"), downloadBaseUrl: baseUrl } : {}),
  } as ResolvedBrowserConfig;
  const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities);
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config,
    prepareChatSurface: async () => {}, selectModelAndEffort: async () => mode,
    captureSubmissionBaseline: async () => ({ userTurns: page.locator("#user"), responseTurns: page.locator("#turn"), initialTurnIdentities: [] }),
    attachPromptWithCompactionRetry: async () => {}, sendAttachedPrompt: async () => "user_turn",
    waitForNewAssistantTurn: async () => ({ locator: page.locator("#turn"), identity: "test-current", acceptedTurnIdentities: ["test-current"] }),
  });
  const deltas: string[] = [];
  const turn: BrowserTurn = { traceId: "image-test", modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low", capabilities,
    prepare: async () => ({ text: "make an image", images: [], release() {} }), onTextDelta: text => deltas.push(text) };
  return { worker: worker as { runBrowserTurn(turn: BrowserTurn, surface: undefined, page: Page): Promise<string>; responseDomSnapshot: (locator: unknown, cache?: object) => Promise<any> }, turn, deltas };
}

realBrowserTest("image-only answers persist exact bytes and return HTTP links; archives outlive link expiry", async () => {
  await fixture(async (page, root, baseUrl, source) => {
    const { worker, turn, deltas } = workerFor(page, root, baseUrl);
    const text = await worker.runBrowserTurn(turn, undefined, page);
    expect(text.startsWith("![image-1-")).toBeTrue();
    expect(deltas.join("")).toBe(text);
    const url = text.match(/\]\(<([^>]+)>\)/)![1]!;
    const bytes = Buffer.from(source.split(",")[1]!, "base64");
    expect(Buffer.from(await (await fetch(url)).arrayBuffer())).toEqual(bytes);
    const directory = join(root, "images", turn.traceId);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    expect(manifest.images).toHaveLength(1);
    expect(manifest.images[0].width).toBe(256); expect(manifest.images[0].height).toBe(192);
    expect(readFileSync(manifest.images[0].path)).toEqual(bytes);
    expect(statSync(manifest.images[0].path).mode & 0o777).toBe(0o600);
    purgeExpiredGeneratedFiles(join(root, "downloads"), Date.now() + GENERATED_FILE_TTL_MS + 1);
    expect((await fetch(url)).status).toBe(404);
    expect(readFileSync(manifest.images[0].path)).toEqual(bytes);
  });
}, 20_000);

realBrowserTest("default preservation works without a file gateway and maintains streamed text", async () => {
  await fixture(async (page, root) => {
    await page.locator('[data-markdown-text-style]').evaluate(node => { node.innerHTML = "<p>Here is your image.</p>"; });
    const { worker, turn, deltas } = workerFor(page, root);
    // Exercise the default directory as well as the explicitly configured path.
    (worker as any).config.imageOutputDirectory = undefined;
    const text = await worker.runBrowserTurn(turn, undefined, page);
    expect(text.startsWith("Here is your image.")).toBeTrue();
    expect(deltas.join("")).toBe(text);
    const url = text.match(/\]\(<([^>]+)>\)/)![1]!;
    expect(url.startsWith("file:")).toBeTrue();
    expect(fileURLToPath(url)).toContain(join(root, "browser", "generated-images"));
    expect(readFileSync(fileURLToPath(url)).length).toBeGreaterThan(100);
  });
}, 20_000);

realBrowserTest("image snapshots isolate the bound answer, exclude uploads and icons, and deduplicate", async () => {
  await fixture(async (page, root, baseUrl, source) => {
    await page.evaluate(src => {
      const img = '<img width="256" height="192" src="' + src + '">';
      document.body.insertAdjacentHTML("afterbegin", '<section data-message-author-role="assistant">' + img + '</section>');
      document.querySelector("#turn")!.insertAdjacentHTML("afterbegin", '<div data-user-message-bubble>' + img + '</div>');
      document.querySelector('[data-content-search-unit-key]')!.insertAdjacentHTML("beforeend", img
        + '<img width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">');
    }, source);
    await page.locator('img').evaluateAll(async images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    const { worker } = workerFor(page, root, baseUrl);
    const state = await worker.responseDomSnapshot(page.locator("#turn"), {});
    expect(state.images).toHaveLength(1);
    expect(state.completionActionVisible).toBeTrue();
  });
}, 10_000);

realBrowserTest("image completion tracks decode readiness without requiring DOM mutations", async () => {
  await fixture(async (page, root, baseUrl) => {
    const { worker } = workerFor(page, root, baseUrl); const cache = {};
    await page.locator('img').evaluate(image => Object.defineProperty(image, "complete", { configurable: true, value: false }));
    const pending = await worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(pending.pendingImages).toBeTrue(); expect(pending.images).toHaveLength(0);
    await page.locator('img').evaluate(image => Object.defineProperty(image, "complete", { configurable: true, value: true }));
    const loaded = await worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(loaded.pendingImages).toBeFalse(); expect(loaded.images).toHaveLength(1);
  });
}, 10_000);

realBrowserTest("failed image decoding and pre-cancelled requests never become successful saved images", async () => {
  await fixture(async (page, root) => {
    const bad = { src: "data:image/png;base64," + Buffer.from("not a PNG").toString("base64"), alt: "", width: 256, height: 192 };
    await expect(preserveChatGptResponseImages(page, [bad], { directory: root, traceId: "bad-image" })).rejects.toThrow("could not be saved");
    expect(readdirSync(join(root, "bad-image"))).toEqual([]);
    const controller = new AbortController(); controller.abort();
    await expect(preserveChatGptResponseImages(page, [bad], { directory: root, traceId: "cancelled", signal: controller.signal })).rejects.toThrow();
  });
}, 10_000);

test("image-only completion waits for stability and rejects pending images and active tools", () => {
  const tracker = new ChatGptCompletionTracker(2000);
  const state = { currentText: "", responsePresent: true, running: false, completionActionVisible: true,
    allowImageOnlyCompletion: true, imageSources: ["blob:test"], pendingImages: false };
  expect(tracker.update({ ...state, pendingImages: true }, 0)).toBeFalse();
  expect(tracker.update(state, 1000)).toBeFalse();
  expect(tracker.update(state, 2999)).toBeFalse();
  expect(tracker.update(state, 3000)).toBeTrue();
  expect(tracker.update({ ...state, externalToolCallsInFlight: true }, 4000)).toBeFalse();
});

// Minimized structure observed in a real ChatGPT generation on 2026-09-29:
// generated-image-gallery is a sibling outside Markdown and assistant search units.
realBrowserTest("observed standalone gallery completes and saves without an assistant Markdown wrapper", async () => {
  await fixture(async (page, root, baseUrl, source) => {
    await page.setContent('<section id="turn" data-turn-key="test-current">'
      + '<div data-user-message-bubble>Generate a circle</div><h4 data-conversation-role="assistant">ChatGPT</h4>'
      + '<div data-testid="generated-image-gallery"><div class="group/generated-image-preview">'
      + '<button data-testid="generated-image-preview" aria-label="已生成图像 1"><img width="256" height="192" src="' + source + '"></button>'
      + '</div></div><div class="turn-action-controls"><button aria-label="复制图像">Copy image</button></div></section>');
    await page.locator('img').evaluate(async image => (image as HTMLImageElement).decode());
    const { worker, turn, deltas } = workerFor(page, root, baseUrl);
    const state = await worker.responseDomSnapshot(page.locator("#turn"), {});
    expect(state.images).toHaveLength(1); expect(state.completionActionVisible).toBeTrue();
    const text = await worker.runBrowserTurn(turn, undefined, page);
    expect(text.startsWith("![image-1-")).toBeTrue(); expect(deltas.join("")).toBe(text);
    expect(readdirSync(join(root, "images", turn.traceId)).some(name => name.endsWith(".png"))).toBeTrue();
  });
}, 20_000);

realBrowserTest("unfinished gallery canvases and disabled completion controls cannot finish image turns", async () => {
  await fixture(async (page, root, baseUrl) => {
    const { worker } = workerFor(page, root, baseUrl); const cache = {};
    await page.locator('img').evaluate(image => {
      image.parentElement!.setAttribute("data-testid", "generated-image-gallery");
      image.parentElement!.append(document.createElement("canvas"));
    });
    let state = await worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(state.pendingImages).toBeTrue();
    await page.locator('canvas').evaluate(canvas => canvas.remove());
    await page.locator('[data-testid="copy-turn-action-button"]').evaluate(button => (button as HTMLButtonElement).disabled = true);
    state = await worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(state.pendingImages).toBeFalse(); expect(state.completionActionVisible).toBeFalse();
    await page.locator('[data-testid="copy-turn-action-button"]').evaluate(button => (button as HTMLButtonElement).disabled = false);
    state = await worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(state.completionActionVisible).toBeTrue();
  });
}, 10_000);
