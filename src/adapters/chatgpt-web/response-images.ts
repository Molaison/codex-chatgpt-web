import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright-core";
import { atomicWriteFile } from "../../config";
import { GENERATED_FILE_MAX_BYTES, storeGeneratedFile } from "../../generated-files";

export interface ChatGptResponseImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export interface SavedChatGptImage {
  filename: string;
  path: string;
  url: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  sha256: string;
}

const formats = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"],
]);

/** Only observed, loaded assets from the bound answer are accepted; never guess file endpoints. */
export async function preserveChatGptResponseImages(
  page: Page,
  images: readonly ChatGptResponseImage[],
  options: { directory: string; traceId: string; downloadDirectory?: string; downloadBaseUrl?: string; signal?: AbortSignal },
): Promise<SavedChatGptImage[]> {
  if (!images.length) return [];
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(options.traceId)) throw new Error("Invalid image archive turn identity");
  const directory = join(options.directory, options.traceId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const saved: SavedChatGptImage[] = [];
  const sources = new Set<string>();
  for (const image of images) {
    options.signal?.throwIfAborted();
    if (sources.has(image.src)) continue;
    sources.add(image.src);
    try {
      // Read in the authenticated page first. This also supports live blob URLs and avoids
      // sending browser credentials to a new origin. Bound the body before crossing CDP.
      const captured = await page.evaluate(async ({ src, maxBytes }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
          const url = new URL(src, location.href);
          if (!["https:", "http:", "blob:", "data:"].includes(url.protocol)) throw new Error("Unsupported image URL");
          const response = await fetch(url.href, { credentials: "same-origin", signal: controller.signal });
          if (!response.ok) throw new Error("Image download HTTP " + response.status);
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Image download was empty");
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > maxBytes) { await reader.cancel(); throw new Error("Image exceeds the 64 MiB limit"); }
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          return { base64: btoa(binary), mime: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() };
        } finally { clearTimeout(timeout); }
      }, { src: image.src, maxBytes: GENERATED_FILE_MAX_BYTES }).catch(async () => {
        // Authenticated OpenAI asset hosts can deny page CORS. Do not turn arbitrary img src
        // values into server-side fetches or follow redirects with account credentials.
        const url = new URL(image.src);
        if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
          || !["chatgpt.com", "oaiusercontent.com"].some(host => url.hostname === host || url.hostname.endsWith("." + host))) {
          throw new Error("The observed image could not be downloaded in its browser context");
        }
        options.signal?.throwIfAborted();
        const response = await page.context().request.get(url.href, { timeout: 60_000, maxRedirects: 0 });
        try {
          if (!response.ok()) throw new Error("Image download HTTP " + response.status());
          const length = Number(response.headers()["content-length"] ?? 0);
          if (length > GENERATED_FILE_MAX_BYTES) throw new Error("Image exceeds the 64 MiB limit");
          const bytes = await response.body();
          if (bytes.length > GENERATED_FILE_MAX_BYTES) throw new Error("Image exceeds the 64 MiB limit");
          return { base64: bytes.toString("base64"), mime: (response.headers()["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() };
        } finally { await response.dispose(); }
      });
      options.signal?.throwIfAborted();
      const extension = formats.get(captured.mime);
      if (!extension) throw new Error("Downloaded response is not a supported raster image");
      const bytes = Buffer.from(captured.base64, "base64");
      if (!bytes.length || bytes.length > GENERATED_FILE_MAX_BYTES) throw new Error("Invalid image download size");
      // Verify decodability, rather than trusting a 200 response or a file extension.
      const dimensions = await page.evaluate(async ({ base64, mime }) => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
        try { return { width: bitmap.width, height: bitmap.height }; }
        finally { bitmap.close(); }
      }, captured);
      if (dimensions.width < 1 || dimensions.height < 1) throw new Error("Downloaded image has no pixels");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const filename = "image-" + (saved.length + 1) + "-" + sha256.slice(0, 12) + "." + extension;
      const path = join(directory, filename);
      atomicWriteFile(path, bytes);
      chmodSync(path, 0o600);
      // The durable copy survives the gateway's 24-hour link expiry and cleanup.
      const url = options.downloadDirectory && options.downloadBaseUrl
        ? storeGeneratedFile(options.downloadDirectory, options.downloadBaseUrl, filename, captured.mime, bytes)
        : pathToFileURL(path).href;
      saved.push({ filename, path, url, mime: captured.mime, size: bytes.length, ...dimensions, sha256 });
      // Save each success immediately; a later partial failure must not lose earlier results.
      atomicWriteFile(join(directory, "manifest.json"), JSON.stringify({
        version: 1, traceId: options.traceId, images: saved.map(({ url: _url, ...record }) => record),
      }, null, 2) + "\n");
      chmodSync(join(directory, "manifest.json"), 0o600);
    } catch (error) {
      options.signal?.throwIfAborted();
      // Signed source URLs / cookies must never leak in upstream error text.
      throw new Error("ChatGPT image " + (saved.length + 1) + " could not be saved; " + saved.length
        + " earlier image(s) remain in the local archive", { cause: error });
    }
  }
  return saved;
}

export function chatGptSavedImagesMarkdown(images: readonly SavedChatGptImage[]): string {
  return images.map(image => "![" + image.filename + "](<" + image.url + ">)").join("\n\n");
}
