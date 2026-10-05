import type { Locator, Page } from "playwright-core";
import { GENERATED_FILE_MAX_BYTES } from "../../generated-files";

export interface GeneratedChatGptFile { filename: string; mime: string; bytes: Uint8Array; sources: string[]; }

/** 已观察到的 ChatGPT 下载端点；缓存过期后按此顺序重放。 */
const DOWNLOAD_PATHS = [
  /^\/backend-api\/conversation\/[^/]+\/interpreter\/download$/,
  /^\/backend-api\/estuary\/content$/,
];

/** 只记录本次点击真实发生过的 ChatGPT 下载端点，不猜测其它文件接口。 */
export function rememberChatGptDownloadSource(sources: string[], raw: string): void {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.username || url.password) return;
    const rank = DOWNLOAD_PATHS.findIndex(pattern => pattern.test(url.pathname));
    if (rank < 0 || sources.includes(raw)) return;
    // interpreter 下载端点不依赖签名，优先作为缓存过期后的重放来源。
    if (rank === 0) sources.unshift(raw); else sources.push(raw);
  } catch { /* 无法解析的候选 URL 不是下载来源。 */ }
}

/** 只读取当前助手回答中的已观察文件卡；不从文件名猜测 sandbox 路径。 */
export async function collectGeneratedChatGptFiles(page: Page, response: Locator): Promise<GeneratedChatGptFile[]> {
  const rows = response.locator('[class~="group/resource-row"]');
  const files: GeneratedChatGptFile[] = [];
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i);
    const filename = await row.evaluate(element => {
      const unit = element.closest('[data-content-search-unit-key]');
      const assistant = unit?.getAttribute('data-content-search-unit-key')?.endsWith(':assistant')
        || element.closest('[data-message-author-role="assistant"]');
      if (!assistant || element.closest('[data-user-message-bubble]')) return undefined;
      return element.querySelector<HTMLElement>('span[title]')?.getAttribute('title') || undefined;
    });
    if (!filename || files.some(file => file.filename === filename)) continue;
    const button = row.locator('button[aria-label="下载文件"], button[aria-label="Download file"]');
    if (await button.count() !== 1) continue;
    // ChatGPT 在触发原生下载后立即撤销 blob URL。短暂保留 Blob 对象本身以读取
    // 原始字节；完成后恢复 URL 方法，避免产生失效链接或读取其他聊天的数据。
    const capture = await page.evaluateHandle(() => {
      const original = URL.createObjectURL;
      const state = { original, capture: original, blobs: [] as Blob[] };
      state.capture = (blob: Blob | MediaSource) => {
        if (blob instanceof Blob) state.blobs.push(blob);
        return original.call(URL, blob);
      };
      URL.createObjectURL = state.capture;
      return state;
    });
    const sources: string[] = [];
    const remember = (raw: string) => rememberChatGptDownloadSource(sources, raw);
    const observeRequests = (request: import("playwright-core").Request) => remember(request.url());
    page.on("request", observeRequests);
    const cancelNativeCopy = (download: import("playwright-core").Download) => {
      remember(download.url());
      if (download.suggestedFilename() === filename) void download.cancel().catch(() => {});
    };
    page.on("download", cancelNativeCopy);
    try {
      await button.click({ timeout: 15_000 });
      await page.waitForFunction(state => state.blobs.length > 0, capture, { timeout: 30_000 });
      const data = await capture.evaluate(async (state, maxBytes) => {
        if (state.blobs.length !== 1) throw new Error("Generated file download was ambiguous");
        const blob = state.blobs[0]!;
        if (blob.size > maxBytes) throw new Error("Generated file exceeds the 64 MiB download limit");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { mime: blob.type || "application/octet-stream", base64: btoa(binary) };
      }, GENERATED_FILE_MAX_BYTES);
      files.push({ filename, mime: data.mime, bytes: Buffer.from(data.base64, "base64"), sources });
    } finally {
      page.off("download", cancelNativeCopy);
      page.off("request", observeRequests);
      await capture.evaluate(state => { if (URL.createObjectURL === state.capture) URL.createObjectURL = state.original; }).catch(() => {});
      await capture.dispose();
    }
  }
  return files;
}
