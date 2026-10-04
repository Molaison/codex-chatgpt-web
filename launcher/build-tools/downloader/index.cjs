"use strict";

// Implements @electron/get's public Downloader interface. Artifact caching and
// checksum verification remain in @electron/get; HTTP responses are never cached.
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const zlib = require("node:zlib");

const retryCodes = new Set(["ETIMEDOUT", "ECONNRESET", "EADDRINUSE", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "ENETUNREACH", "EAI_AGAIN", "ERR_STREAM_PREMATURE_CLOSE"]);
const retryStatuses = new Set([408, 413, 429, 500, 502, 503, 504, 521, 522, 524]);
const supported = new Set(["agent", "timeout", "headers", "https", "retry", "maxRedirects", "followRedirect", "getProgressCallback", "quiet", "cache", "decompress"]);
const tlsOptions = new Map([
  ["rejectUnauthorized", "rejectUnauthorized"], ["certificateAuthority", "ca"],
  ["certificate", "cert"], ["key", "key"], ["passphrase", "passphrase"],
  ["pfx", "pfx"], ["checkServerIdentity", "checkServerIdentity"],
  ["minVersion", "minVersion"], ["maxVersion", "maxVersion"], ["ciphers", "ciphers"],
]);

function assertKeys(value, keys, label) {
  for (const key of Object.keys(value || {})) {
    if (!keys.has(key)) throw new TypeError(`Unsupported build downloader ${label}: ${key}`);
  }
}

function normalize(options) {
  assertKeys(options, supported, "option");
  if (options.cache !== undefined && options.cache !== false) {
    throw new TypeError("HTTP response caching is unsupported; use @electron/get artifact cacheMode/cacheRoot");
  }
  const timeout = typeof options.timeout === "number" ? { request: options.timeout } : { ...options.timeout };
  assertKeys(timeout, new Set(["request", "connect", "secureConnect", "socket", "response"]), "timeout");
  for (const value of Object.values(timeout)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError("Timeouts must be finite nonnegative milliseconds");
  }
  const tls = {};
  assertKeys(options.https, tlsOptions, "TLS option");
  for (const [key, value] of Object.entries(options.https || {})) tls[tlsOptions.get(key)] = value;
  assertKeys(options.agent, new Set(["http", "https"]), "agent protocol");
  if (options.retry !== undefined && typeof options.retry !== "number" && (options.retry === null || typeof options.retry !== "object")) {
    throw new TypeError("Retry must be a number or { limit }");
  }
  const retries = typeof options.retry === "number" ? options.retry : options.retry?.limit ?? 2;
  if (typeof options.retry === "object") assertKeys(options.retry, new Set(["limit"]), "retry option");
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new TypeError("Retry limit must be an integer from 0 to 10");
  const redirects = options.maxRedirects ?? 10;
  if (!Number.isInteger(redirects) || redirects < 0) throw new TypeError("maxRedirects must be a nonnegative integer");
  return { ...options, timeout, tls, retries, redirects };
}

function timeoutError(phase) {
  return Object.assign(new Error(`Build download ${phase} timeout`), { name: "TimeoutError", code: "ETIMEDOUT", event: phase });
}

async function attempt(input, target, options) {
  let activeRequest;
  const controller = new AbortController();
  const timers = new Map();
  const clear = phase => { clearTimeout(timers.get(phase)); timers.delete(phase); };
  const arm = phase => {
    clear(phase);
    if (options.timeout[phase] > 0) timers.set(phase, setTimeout(() => {
      const error = timeoutError(phase);
      controller.abort(error);
      activeRequest?.destroy(error);
    }, options.timeout[phase]));
  };
  let url = new URL(input);
  let headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  // Do not request compressed transfers: checksums describe the artifact bytes.
  headers["accept-encoding"] ??= "identity";
  arm("request");
  try {
    for (let redirects = 0; ; redirects++) {
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) download URLs are supported");
      controller.signal.throwIfAborted();
      const response = await new Promise((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason);
        const cleanup = () => controller.signal.removeEventListener("abort", aborted);
        controller.signal.addEventListener("abort", aborted, { once: true });
        const transport = url.protocol === "https:" ? https : http;
        const request = activeRequest = transport.request(url, {
          method: "GET", headers, ...options.tls,
          agent: options.agent?.[url.protocol === "https:" ? "https" : "http"],
          signal: controller.signal,
        }, response => { cleanup(); resolve(response); });
        request.once("error", error => { cleanup(); reject(error); });
        arm("connect");
        request.once("socket", socket => {
          const connected = () => {
            clear("connect");
            if (url.protocol === "https:" && socket.secureConnecting && !request.reusedSocket) {
              arm("secureConnect");
              socket.once("secureConnect", () => clear("secureConnect"));
            }
          };
          if (socket.connecting) socket.once("connect", connected);
          else connected();
        });
        if (options.timeout.socket > 0) request.setTimeout(options.timeout.socket, () => request.destroy(timeoutError("socket")));
        request.once("finish", () => arm("response"));
        request.end();
      });
      for (const phase of ["connect", "secureConnect", "response"]) clear(phase);
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && options.followRedirect !== false) {
        response.destroy();
        if (redirects >= options.redirects) throw new Error("Build download exceeded maxRedirects");
        const next = new URL(response.headers.location, url);
        if (next.origin !== url.origin) {
          headers = { ...headers };
          for (const name of ["authorization", "proxy-authorization", "cookie", "host"]) delete headers[name];
          next.username = "";
          next.password = "";
        }
        url = next;
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        // Match electron-builder's existing retry classification without logging credentials.
        throw Object.assign(new Error(`Build download HTTP ${status}`), {
          name: "HTTPError", response: { statusCode: status }, retryAfter: response.headers["retry-after"],
        });
      }
      const total = Number(response.headers["content-length"]) || undefined;
      let transferred = 0;
      const progress = async completed => options.getProgressCallback?.({
        transferred, total, percent: completed ? 1 : total ? transferred / total : 0,
      });
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          transferred += chunk.length;
          Promise.resolve(progress(false)).then(() => callback(null, chunk), callback);
        },
      });
      const decoders = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
      const decode = options.decompress !== false && decoders[response.headers["content-encoding"]];
      await pipeline(response, meter, ...(decode ? [decode()] : []), fs.createWriteStream(target), { signal: controller.signal });
      if (total !== undefined && transferred !== total) throw Object.assign(new Error("Incomplete artifact download"), { code: "ECONNRESET" });
      await progress(true);
      return;
    }
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    for (const phase of timers.keys()) clear(phase);
    activeRequest?.destroy();
  }
}

async function download(url, target, input = {}) {
  const options = normalize(input);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  for (let retry = 0; ; retry++) {
    try {
      await attempt(url, target, options);
      return;
    } catch (error) {
      await fs.promises.rm(target, { force: true });
      if (retry >= options.retries || !(retryCodes.has(error.code) || retryStatuses.has(error.response?.statusCode))) throw error;
      if (error.response?.statusCode === 413 && error.retryAfter === undefined) throw error;
      let wait = 1000 * 2 ** retry;
      if (error.retryAfter !== undefined) {
        const seconds = Number(error.retryAfter);
        wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(error.retryAfter) - Date.now();
        if (!Number.isFinite(wait) || wait < 0) wait = 0;
        if (wait > (options.timeout.request || 60_000)) throw error;
      }
      await delay(wait);
    }
  }
}

module.exports = { download };
