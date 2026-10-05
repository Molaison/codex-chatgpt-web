import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { collectGeneratedChatGptFiles, rememberChatGptDownloadSource } from "../src/adapters/chatgpt-web/downloads";
import { GENERATED_FILE_TTL_MS, serveGeneratedFile, storeGeneratedFile } from "../src/generated-files";

test("generated files download byte-for-byte over HTTP and stay isolated by account", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-files-"));
  const directory = join(root, "account-a");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => serveGeneratedFile(req, directory) ?? new Response(null, { status: 404 }) });
  try {
    const bytes = new TextEncoder().encode("name,value\nalpha,1\n");
    const url = storeGeneratedFile(directory, server.url.href, "报告.csv", "text/csv", bytes);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(url, { method: "HEAD" })).headers.get("content-length")).toBe(String(bytes.length));
    expect(serveGeneratedFile(new Request(url), join(root, "account-b"))?.status).toBe(404);
    expect(serveGeneratedFile(new Request(url), directory, Date.now() + GENERATED_FILE_TTL_MS + 1)?.status).toBe(404);
    expect((await fetch(server.url.href + "files/" + "0".repeat(64) + "/report.csv")).status).toBe(404);
    expect(() => storeGeneratedFile(directory, server.url.href, "../secret", "text/plain", bytes)).toThrow("filename");
    expect(() => storeGeneratedFile(directory, "https://name:password@example.invalid", "x", "text/plain", bytes)).toThrow("credentials");
    storeGeneratedFile(directory, server.url.href, "next.csv", "text/csv", bytes, Date.now() + GENERATED_FILE_TTL_MS + 1);
    expect(readdirSync(directory)).toHaveLength(1);
    expect((await fetch(url)).status).toBe(404);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("native file cards survive immediate blob URL revocation without collecting user uploads", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const page = await browser.newPage();
  try {
    // 脱敏结构来自真实生成 CSV 的新版文件卡，不推测其下载 URL。
    await page.setContent('<main id="turn">'
      + '<div data-content-search-unit-key="turn:0:user"><span class="group/resource-row"><span title="private-upload.csv"></span><button aria-label="Download file" onclick="throw new Error(\'User upload must not be clicked\')">Download</button></span></div>'
      + '<div data-content-search-unit-key="turn:1:assistant"><span class="group/resource-row"><span title="report.csv"></span><button aria-label="Download file">Download</button></span></div></main>');
    await page.evaluate(() => {
      const button = document.querySelector('[data-content-search-unit-key$=assistant] button')!;
      button.addEventListener("click", () => {
        const url = URL.createObjectURL(new Blob(["name,value\nalpha,1\n"], { type: "text/csv" }));
        const link = document.createElement("a"); link.download = "report.csv"; link.href = url;
        document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      });
      (window as any).originalCreateObjectURL = URL.createObjectURL;
    });
    const files = await collectGeneratedChatGptFiles(page, page.locator("#turn"));
    expect(files.map(file => file.filename)).toEqual(["report.csv"]);
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe("name,value\nalpha,1\n");
    expect(await page.evaluate(() => URL.createObjectURL === (window as any).originalCreateObjectURL)).toBe(true);
  } finally { await browser.close(); }
});

test("only observed ChatGPT download endpoints become replay sources", () => {
  const sources: string[] = [];
  rememberChatGptDownloadSource(sources, "https://chatgpt.com/backend-api/estuary/content?id=file_abc123&fn=x.txt&sig=s");
  rememberChatGptDownloadSource(sources, "https://chatgpt.com/backend-api/conversation/c1/interpreter/download?sandbox_path=%2Fmnt%2Fdata%2Fx.txt");
  rememberChatGptDownloadSource(sources, "https://chatgpt.com/backend-api/estuary/content?id=file_abc123&fn=x.txt&sig=s");
  rememberChatGptDownloadSource(sources, "https://evil.example/backend-api/estuary/content?id=file_abc123");
  rememberChatGptDownloadSource(sources, "http://chatgpt.com/backend-api/estuary/content?id=file_abc123");
  rememberChatGptDownloadSource(sources, "https://chatgpt.com/backend-api/files");
  expect(sources).toHaveLength(2);
  // interpreter 下载端点不依赖签名，优先作为缓存过期后的重放来源。
  expect(sources[0]).toContain("interpreter/download");
});
