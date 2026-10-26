import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./config";

export const GENERATED_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const GENERATED_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^[a-f0-9]{64}$/;
/** ChatGPT 原生文件标识；用于把本地缓存暴露成原生形状的下载链接。 */
const FILE_ID = /^file_[A-Za-z0-9]{6,120}$/;
const MIME = /^[\w.+-]+\/[\w.+-]+(?:;[\w= .-]+)?$/;
/** 已观察到的 ChatGPT 下载端点；只有这些 URL 会在缓存过期后被重放。 */
const SOURCE_PATH = /^\/backend-api\/(?:estuary\/content|conversation\/[^/]+\/interpreter\/download)$/;

export interface GeneratedFileMetadata {
  filename: string;
  mime: string;
  size: number;
  expiresAt: number;
  fileId?: string;
  /** 缓存过期后可按顺序重放的原始下载 URL。 */
  sources?: string[];
  recoveryScope?: string;
  contentSha256?: string;
}

interface GeneratedFileRecovery {
  version: 1;
  scope: string;
  token: string;
  baseUrl: string;
  metadata: GeneratedFileMetadata;
}

function syncGeneratedFileDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function recoveredGeneratedFile(
  directory: string, index: string, scope: string, baseUrl: string,
  filename: string, mime: string, contentSha256: string, now: number,
): GeneratedFileRecovery | undefined {
  let serialized: string;
  try { serialized = readFileSync(index, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const unavailable = () => { throw new Error("The original generated file is unavailable for observation recovery"); };
  let saved: GeneratedFileRecovery;
  try { saved = JSON.parse(serialized); } catch { return unavailable(); }
  if (!saved || typeof saved !== "object" || saved.version !== 1 || saved.scope !== scope
    || saved.baseUrl !== baseUrl || !TOKEN.test(saved.token)) return unavailable();
  const metadata = readMetadata(join(directory, saved.token));
  if (!metadata || JSON.stringify(metadata) !== JSON.stringify(saved.metadata)
    || metadata.filename !== filename || metadata.mime !== mime || metadata.recoveryScope !== scope
    || metadata.contentSha256 !== contentSha256 || !Number.isFinite(metadata.expiresAt) || metadata.expiresAt <= now) return unavailable();
  let bytes: Buffer;
  try { bytes = readFileSync(join(directory, saved.token, "content")); } catch { return unavailable(); }
  if (bytes.length !== metadata.size || bytes.length > GENERATED_FILE_MAX_BYTES
    || createHash("sha256").update(bytes).digest("hex") !== contentSha256) return unavailable();
  return saved;
}

function generatedFileUrl(baseUrl: string, token: string, metadata: GeneratedFileMetadata): string {
  return metadata.fileId
    ? baseUrl + "/estuary/content?id=" + metadata.fileId + "&fn=" + encodeURIComponent(metadata.filename)
    : baseUrl + "/files/" + token + "/" + encodeURIComponent(metadata.filename);
}

/** 缓存过期后的重新下载凭据；由调用方在已登录浏览器里取回字节。 */
export interface GeneratedFileReplay {
  fileId: string;
  filename: string;
  sources: string[];
}

function denied(): Response {
  return new Response("File unavailable", { status: 404, headers: { "cache-control": "no-store" } });
}

function readMetadata(path: string): GeneratedFileMetadata | undefined {
  try {
    const metadata = JSON.parse(readFileSync(join(path, "metadata.json"), "utf8")) as GeneratedFileMetadata;
    if (!metadata || typeof metadata !== "object" || typeof metadata.filename !== "string") return undefined;
    return metadata;
  } catch { return undefined; }
}

function normalizeMime(mime: string): string {
  return MIME.test(mime) ? mime : "application/octet-stream";
}

function normalizeSources(sources: readonly string[] | undefined): string[] | undefined {
  const accepted: string[] = [];
  for (const source of sources ?? []) {
    try {
      const url = new URL(source);
      if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.username || url.password) continue;
      if (!SOURCE_PATH.test(url.pathname) || accepted.includes(source)) continue;
      accepted.push(source);
    } catch { /* 不是可重放的下载 URL。 */ }
  }
  return accepted.length > 0 ? accepted : undefined;
}

function fileIdFromSources(sources: readonly string[] | undefined): string | undefined {
  for (const source of sources ?? []) {
    try {
      const id = new URL(source).searchParams.get("id");
      if (id && FILE_ID.test(id)) return id;
    } catch { /* 忽略无法解析的来源。 */ }
  }
  return undefined;
}

/** 过期条目：带原生来源的文件保留重放凭据，只回收内容字节。 */
export function purgeExpiredGeneratedFiles(directory: string, now = Date.now()): void {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !TOKEN.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const metadata = readMetadata(path);
    if (!metadata || !Number.isFinite(metadata.expiresAt) || metadata.expiresAt > now) continue;
    try {
      if (metadata.fileId && metadata.sources?.length) { rmSync(join(path, "content"), { force: true }); continue; }
      rmSync(path, { recursive: true, force: true });
    } catch { /* A concurrent store/removal must not prevent a new download. */ }
  }
}

export function storeGeneratedFile(
  directory: string, baseUrl: string, filename: string, mime: string, bytes: Uint8Array,
  now = Date.now(), options: { sources?: readonly string[]; recoveryScope?: string } = {},
): string {
  if (!filename || /[/\\\r\n\0]/.test(filename) || filename === "." || filename === "..") {
    throw new Error("Generated file has an invalid filename");
  }
  if (bytes.byteLength > GENERATED_FILE_MAX_BYTES) throw new Error("Generated file exceeds the 64 MiB download limit");
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Download base URL must be an HTTP(S) URL without credentials, query or fragment");
  }
  const sources = normalizeSources(options.sources);
  const fileId = fileIdFromSources(sources);
  const normalizedMime = normalizeMime(mime), origin = baseUrl.replace(/\/$/, "");
  const scope = options.recoveryScope;
  if (scope !== undefined && !TOKEN.test(scope)) throw new Error("Generated file recovery scope is invalid");
  const contentSha256 = scope ? createHash("sha256").update(bytes).digest("hex") : undefined;
  const artifact = scope ? createHash("sha256").update(JSON.stringify([filename, normalizedMime, contentSha256])).digest("hex") : undefined;
  const recoveryDirectory = scope ? join(directory, "recovery", scope) : undefined;
  const index = recoveryDirectory ? join(recoveryDirectory, artifact + ".json") : undefined;
  if (index) {
    const saved = recoveredGeneratedFile(directory, index, scope!, origin, filename, normalizedMime, contentSha256!, now);
    if (saved) {
      syncGeneratedFileDirectory(recoveryDirectory!);
      return generatedFileUrl(origin, saved.token, saved.metadata);
    }
  }
  purgeExpiredGeneratedFiles(directory, now);
  const token = randomBytes(32).toString("hex");
  const path = join(directory, token);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata: GeneratedFileMetadata = {
    filename, mime: normalizedMime, size: bytes.byteLength, expiresAt: now + GENERATED_FILE_TTL_MS,
    ...(fileId ? { fileId } : {}), ...(sources ? { sources } : {}),
    ...(scope ? { recoveryScope: scope, contentSha256 } : {}),
  };
  if (scope) {
    atomicWriteFile(join(path, "content"), bytes, { durable: true });
    atomicWriteFile(join(path, "metadata.json"), JSON.stringify(metadata), { durable: true });
    syncGeneratedFileDirectory(path);
  } else {
    writeFileSync(join(path, "content"), bytes, { mode: 0o600 });
    writeFileSync(join(path, "metadata.json"), JSON.stringify(metadata), { mode: 0o600 });
  }
  if (index) {
    mkdirSync(recoveryDirectory!, { recursive: true, mode: 0o700 });
    syncGeneratedFileDirectory(join(directory, "recovery"));
    syncGeneratedFileDirectory(directory);
    const pending = join(recoveryDirectory!, artifact + "." + token + ".tmp");
    atomicWriteFile(pending, JSON.stringify({ version: 1, scope, token, baseUrl: origin, metadata }), { durable: true });
    try {
      // The original capability becomes observable only after both bytes and metadata are saved.
      // Competing observers converge on one random token without overwriting the winner.
      try { linkSync(pending, index); syncGeneratedFileDirectory(recoveryDirectory!); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const saved = recoveredGeneratedFile(directory, index, scope!, origin, filename, normalizedMime, contentSha256!, now);
        if (!saved) throw new Error("Generated file recovery publication disappeared");
        syncGeneratedFileDirectory(recoveryDirectory!);
        rmSync(path, { recursive: true, force: true });
        return generatedFileUrl(origin, saved.token, saved.metadata);
      }
    } finally { rmSync(pending, { force: true }); }
  }
  return generatedFileUrl(origin, token, metadata);
}

function downloadResponse(request: Request, metadata: GeneratedFileMetadata, content: Buffer): Response {
  const filename = metadata.filename.replace(/[^A-Za-z0-9._-]/g, "_");
  // 以精确的 ArrayBuffer 视图发字节，避免把 Buffer 池的其他内存暴露给响应体。
  const body: BodyInit | null = request.method === "HEAD"
    ? null
    : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  return new Response(body, { headers: {
    "content-type": metadata.mime,
    "content-length": String(content.length),
    "content-disposition": "attachment; filename=\"" + filename + "\"; filename*=UTF-8''" + encodeURIComponent(metadata.filename),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  } });
}

/** 随机能力链接只授权一个账号的一份文件，不暴露目录或浏览器认证。 */
export function serveGeneratedFile(request: Request, directory: string, now = Date.now()): Response | undefined {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/files/")) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") return denied();
  const parts = url.pathname.split("/");
  if (parts.length !== 4 || !TOKEN.test(parts[2]!)) return denied();
  const path = join(directory, parts[2]!);
  const metadata = readMetadata(path);
  if (!metadata || !Number.isFinite(metadata.expiresAt) || metadata.expiresAt <= now) return denied();
  try {
    if (decodeURIComponent(parts[3]!) !== metadata.filename) return denied();
    const content = readFileSync(join(path, "content"));
    if (content.length !== metadata.size || content.length > GENERATED_FILE_MAX_BYTES) return denied();
    return downloadResponse(request, metadata, content);
  } catch { return denied(); }
}

function locateByFileId(directory: string, fileId: string): { path: string; metadata: GeneratedFileMetadata } | undefined {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !TOKEN.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const metadata = readMetadata(path);
    if (metadata?.fileId === fileId) return { path, metadata };
  }
  return undefined;
}

/**
 * 原生形状链接：缓存命中直接回本地字节；缓存缺失或过期时返回重放凭据，
 * 由调用方在已登录浏览器里重新下载后写回缓存。
 */
export function resolveEstuaryGeneratedFile(
  request: Request, directory: string, now = Date.now(),
): Response | GeneratedFileReplay | undefined {
  const url = new URL(request.url);
  if (url.pathname !== "/estuary/content") return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") return denied();
  const fileId = url.searchParams.get("id") ?? "";
  if (!FILE_ID.test(fileId)) return denied();
  const located = locateByFileId(directory, fileId);
  if (!located) return denied();
  const requested = url.searchParams.get("fn");
  if (requested && requested !== located.metadata.filename) return denied();
  if (Number.isFinite(located.metadata.expiresAt) && located.metadata.expiresAt > now) {
    try {
      const content = readFileSync(join(located.path, "content"));
      if (content.length === located.metadata.size && content.length <= GENERATED_FILE_MAX_BYTES) {
        return downloadResponse(request, located.metadata, content);
      }
    } catch { /* 内容已被回收，改为重新下载。 */ }
  }
  return located.metadata.sources?.length
    ? { fileId, filename: located.metadata.filename, sources: located.metadata.sources }
    : denied();
}

/** 重新下载成功后刷新缓存条目，保留原始文件名与重放来源。 */
export function refreshStoredGeneratedFile(
  directory: string, fileId: string, mime: string, bytes: Uint8Array, now = Date.now(),
): boolean {
  if (!FILE_ID.test(fileId) || bytes.byteLength === 0 || bytes.byteLength > GENERATED_FILE_MAX_BYTES) return false;
  const located = locateByFileId(directory, fileId);
  if (!located) return false;
  try {
    writeFileSync(join(located.path, "content"), bytes, { mode: 0o600 });
    writeFileSync(join(located.path, "metadata.json"), JSON.stringify({
      ...located.metadata, mime: normalizeMime(mime), size: bytes.byteLength, expiresAt: now + GENERATED_FILE_TTL_MS,
    }), { mode: 0o600 });
    return true;
  } catch { return false; }
}
