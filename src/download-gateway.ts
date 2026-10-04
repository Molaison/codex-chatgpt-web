import http, { type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** ChatGPT 原生文件标识；原生形状链接只接受这一种标识。 */
const GENERATED_FILE_ID = /^file_[A-Za-z0-9]{6,120}$/;

/** 只转发原生下载链接的文件标识与文件名；签名、时间戳等参数由运行时自己重放。 */
function estuaryUpstreamPath(query: string): string | undefined {
  const parameters = new URLSearchParams(query);
  const fileId = parameters.get("id") ?? "";
  const filename = parameters.get("fn") ?? "";
  if (!GENERATED_FILE_ID.test(fileId) || !filename || filename.length > 200 || /[/\\\r\n\0]/.test(filename)) return undefined;
  return "/estuary/content?id=" + encodeURIComponent(fileId) + "&fn=" + encodeURIComponent(filename);
}

export interface DownloadGatewayConfig {
  host: string;
  port: number;
  accounts: Record<string, string>;
  pathPrefix?: string;
  proxyOrigin?: string;
  mcpAccounts?: Record<string, string>;
}

export function validateDownloadGatewayConfig(value: unknown): DownloadGatewayConfig {
  const config = value as DownloadGatewayConfig;
  if (!config || typeof config.host !== "string" || !config.host.trim()
    || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
    || !config.accounts || typeof config.accounts !== "object" || Array.isArray(config.accounts)
    || Object.keys(config.accounts).length === 0) throw new Error("Invalid download gateway configuration");
  if (config.mcpAccounts !== undefined && (!config.mcpAccounts || typeof config.mcpAccounts !== "object"
    || Array.isArray(config.mcpAccounts))) throw new Error("Invalid MCP gateway accounts");
  for (const [account, target] of [...Object.entries(config.accounts), ...Object.entries(config.mcpAccounts ?? {})]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(account) || typeof target !== "string")
      throw new Error("Invalid download gateway account");
    const url = new URL(target);
    // 仅把能力链接转发给本机运行时；公网 TLS 由反向代理终止。
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Download gateway targets must be loopback HTTP origins");
  }
  if (config.pathPrefix !== undefined && !/^\/[A-Za-z0-9_-]+$/.test(config.pathPrefix)) throw new Error("Invalid gateway path prefix");
  if (config.proxyOrigin !== undefined) {
    if (!config.pathPrefix) throw new Error("Public CPR ingress requires a dedicated file path prefix");
    const url = new URL(config.proxyOrigin);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Public gateway fallback must be a loopback HTTP origin");
  }
  return config;
}

export function createDownloadGateway(input: DownloadGatewayConfig): Server {
  const config = validateDownloadGatewayConfig(input);
  const server = http.createServer((req, res) => {
    const deny = () => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(404, { "cache-control": "no-store" });
      res.end("File unavailable");
    };
    // 原始路径匹配避免 URL 规范化把 ../ 转成可访问的能力链接。
    const prefix = config.pathPrefix ?? "";
    const rawPath = req.url ?? "";
    const mcpNamespace = rawPath === "/local-mcp" || rawPath.startsWith("/local-mcp/");
    const mcpMatch = /^\/local-mcp\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/mcp$/.exec(rawPath);
    const mcpOrigin = mcpMatch && Object.prototype.hasOwnProperty.call(config.mcpAccounts ?? {}, mcpMatch[1]!)
      ? config.mcpAccounts![mcpMatch[1]!] : undefined;
    if (mcpNamespace && !mcpOrigin) { deny(); return; }
    const proxyOrigin = mcpOrigin ?? config.proxyOrigin;
    if (proxyOrigin && (mcpOrigin || !(rawPath === prefix || rawPath.startsWith(prefix + "/")))) {
      const target = new URL(proxyOrigin);
      const upstream = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ""), port: target.port || 80,
        path: mcpOrigin ? "/mcp" : rawPath, method: req.method, headers: req.headers,
      }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.on("error", () => res.destroy()); response.pipe(res);
      });
      upstream.on("error", () => {
        if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end("Upstream unavailable"); }
      });
      res.on("close", () => upstream.destroy()); req.pipe(upstream); return;
    }
    const suffix = rawPath.slice(prefix.length);
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\/files\/[a-f0-9]{64}\/[^/?#]+)$/.exec(suffix);
    const estuary = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/estuary\/content\?([^#]*)$/.exec(suffix);
    const account = match?.[1] ?? estuary?.[1];
    const upstreamPath = match ? match[2] : estuary ? estuaryUpstreamPath(estuary[2]!) : undefined;
    if (!["GET", "HEAD"].includes(req.method ?? "") || !account || !upstreamPath
      || !Object.prototype.hasOwnProperty.call(config.accounts, account)) { deny(); return; }
    const target = new URL(config.accounts[account]!);
    const upstream = http.request({
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || 80, path: upstreamPath, method: req.method, timeout: 30_000,
    }, response => {
      // 不把浏览器 cookies、认证或任意上游重定向传播到公网。
      if (response.statusCode !== 200) { response.resume(); deny(); return; }
      const headers: Record<string, string> = {
        "cache-control": "private, no-store", "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      };
      for (const name of ["content-type", "content-length", "content-disposition"]) {
        const value = response.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      res.writeHead(200, headers);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", deny);
    res.on("close", () => upstream.destroy());
    upstream.end();
  });
  server.on("upgrade", (req, socket, head) => {
    const prefix = config.pathPrefix ?? "";
    if (req.url === "/local-mcp" || (req.url ?? "").startsWith("/local-mcp/")) { socket.destroy(); return; }
    if (!config.proxyOrigin || req.url === prefix || (req.url ?? "").startsWith(prefix + "/")) { socket.destroy(); return; }
    const target = new URL(config.proxyOrigin);
    const upstream = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ""), port: target.port || 80,
      path: req.url, method: req.method, headers: req.headers,
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      const headers = response.rawHeaders;
      let handshake = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
      for (let i = 0; i < headers.length; i += 2) handshake += `${headers[i]}: ${headers[i + 1]}\r\n`;
      socket.write(handshake + "\r\n");
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on("error", () => socket.destroy()); socket.on("error", () => remote.destroy());
      remote.on("close", () => socket.destroy()); socket.on("close", () => remote.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.on("response", response => { response.resume(); socket.destroy(); });
    upstream.on("error", () => socket.destroy()); upstream.end();
  });
  return server;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun run src/download-gateway.ts <config.json>");
  const config = validateDownloadGatewayConfig(JSON.parse(readFileSync(resolve(path), "utf8")));
  createDownloadGateway(config).listen(config.port, config.host);
}
