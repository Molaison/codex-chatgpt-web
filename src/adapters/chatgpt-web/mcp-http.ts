import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CancelledNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { connectChatGptMcpServer, type ChatGptMcpServerOptions } from "./mcp-server";

// Bound encoded HTTP input independently of the tool schema (JSON escapes count toward this cap).
export const MCP_HTTP_MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 32;
const MAX_SESSIONS = 64;
const SESSION_IDLE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const BODY_TIMEOUT_MS = 30_000;

export interface ChatGptMcpHttpOptions extends ChatGptMcpServerOptions {
  port?: number;
  /** One explicitly trusted HTTPS origin whose Host a reverse proxy may preserve. */
  publicOrigin?: string;
}

export function validateMcpPublicOrigin(value: string): URL {
  let origin: URL;
  try { origin = new URL(value); } catch { throw new Error("--public-origin must be an HTTPS origin"); }
  if (origin.protocol !== "https:" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash || origin.hostname.includes("*")) {
    throw new Error("--public-origin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return origin;
}

function reply(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

class InvalidBody extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readBody(request: Request): Promise<unknown> {
  if ((request.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
    throw new InvalidBody(415, "Content-Encoding is not supported");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MCP_HTTP_MAX_BODY_BYTES)) {
    throw new InvalidBody(413, "MCP request body is too large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidBody(400, "A JSON request body is required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, BODY_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new InvalidBody(408, "MCP request body timed out");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MCP_HTTP_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new InvalidBody(413, "MCP request body is too large");
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
    catch { throw new InvalidBody(400, "Invalid JSON request body"); }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** SDK 1.30 ignores cancellation requestId=0. Give its protocol nonempty, type-tagged IDs
 * while preserving the exact original IDs at the HTTP boundary, including string/number pairs. */
const normalizedRequestId = (id: string | number) => JSON.stringify([typeof id, id]);

function normalizedRequestIds(inner: WebStandardStreamableHTTPServerTransport): Transport {
  const encode = normalizedRequestId;
  const decode = (id: string | number) => {
    if (typeof id !== "string") return id;
    try {
      const value = JSON.parse(id);
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === value[0]
        && (value[0] === "string" || value[0] === "number")) return value[1] as string | number;
    } catch { /* Preserve server-originated IDs that are not client request IDs. */ }
    return id;
  };
  const wrapped: Transport = {
    start: () => inner.start(), close: () => inner.close(),
    get sessionId() { return inner.sessionId; },
    send: (message, options) => inner.send(
      ! ("method" in message) && "id" in message && (typeof message.id === "string" || typeof message.id === "number") ? { ...message, id: decode(message.id) } : message,
      options?.relatedRequestId !== undefined ? { ...options, relatedRequestId: decode(options.relatedRequestId) } : options,
    ),
  };
  inner.onmessage = (message, extra) => {
    if ("method" in message && "id" in message && (typeof message.id === "string" || typeof message.id === "number")) message = { ...message, id: encode(message.id) };
    if ("method" in message && message.method === "notifications/cancelled"
      && (typeof message.params?.requestId === "string" || typeof message.params?.requestId === "number")) {
      message = { ...message, params: { ...message.params, requestId: encode(message.params.requestId) } };
    }
    wrapped.onmessage?.(message, extra);
  };
  inner.onerror = error => wrapped.onerror?.(error);
  inner.onclose = () => wrapped.onclose?.();
  return wrapped;
}

interface HttpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  mcp: Awaited<ReturnType<typeof connectChatGptMcpServer>>;
  requests: Map<string | number, AbortController>;
  lastUsed: number;
}

/**
 * Experimental alternative to Secure MCP Tunnel. Never provisions a tunnel or credentials;
 * loopback only, with the existing per-turn capability checks in the broker. The pinned SDK
 * negotiates MCP 2025-11-25. Sessions isolate cancellation IDs; they never authorize tools.
 */
export function startChatGptMcpHttpServer(options: ChatGptMcpHttpOptions) {
  const port = options.port ?? 8788;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MCP HTTP port must be between 0 and 65535");
  const publicOrigin = options.publicOrigin === undefined ? undefined : validateMcpPublicOrigin(options.publicOrigin);
  const active = new Set<AbortController>();
  const sessions = new Map<string, HttpSession>();
  let pendingSessions = 0;
  let closing = false;
  const closeSession = async (session: HttpSession) => {
    if (session.transport.sessionId) sessions.delete(session.transport.sessionId);
    for (const request of session.requests.values()) request.abort();
    await session.mcp.close();
  };
  const prune = () => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of sessions.values()) {
      if (session.requests.size === 0 && session.lastUsed < cutoff) void closeSession(session);
    }
  };
  const idleTimer = setInterval(prune, 30_000);
  idleTimer.unref();
  const http = Bun.serve({
    hostname: "127.0.0.1", port,
    maxRequestBodySize: MCP_HTTP_MAX_BODY_BYTES,
    idleTimeout: 150,
    async fetch(request, server): Promise<Response> {
      const localHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      const allowedHosts = new Set([...localHosts, ...(publicOrigin ? [publicOrigin.host] : [])]);
      // Never trust Forwarded/X-Forwarded-Host or arbitrary browser origins.
      if (!allowedHosts.has(request.headers.get("host") ?? "")) return reply(403, "Host is not allowed");
      const origin = request.headers.get("origin");
      const allowedOrigins = new Set([...localHosts.map(host => `http://${host}`), ...(publicOrigin ? [publicOrigin.origin] : [])]);
      if (origin !== null && !allowedOrigins.has(origin)) return reply(403, "Origin is not allowed");
      if (new URL(request.url).pathname !== "/mcp") return reply(404, "Not found");
      if (request.method !== "POST" && request.method !== "DELETE") {
        const response = reply(405, "Use POST for MCP or DELETE to close a session");
        response.headers.set("Allow", "POST, DELETE");
        return response;
      }
      if (closing) return reply(503, "MCP HTTP server is stopping");
      const sessionId = request.headers.get("mcp-session-id");
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) return reply(404, "MCP session not found; initialize again");
      if (request.method === "DELETE") {
        if (!session) return reply(400, "Mcp-Session-Id is required");
        const response = await session.transport.handleRequest(request);
        if (response.ok) await closeSession(session);
        return response;
      }
      // Reserve extra capacity for cancellations so busy tool calls cannot prevent cancellation.
      if (active.size >= MAX_ACTIVE_REQUESTS + 8) return reply(503, "MCP HTTP request capacity reached");
      const lifetime = new AbortController();
      active.add(lifetime);
      const abort = () => lifetime.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
      let finishAbort: (() => void) | undefined;
      let requestId: string | number | undefined;
      let newSession = false;
      let stage = "body";
      try {
        const body = await readBody(request);
        // MCP 2025-11-25 requires one JSON-RPC message per POST. Reject batching before dispatch.
        if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, "One JSON-RPC message is required");
        const message = body as Record<string, unknown>;
        const cancellation = message.method === "notifications/cancelled";
        if (!cancellation && active.size > MAX_ACTIVE_REQUESTS) return reply(503, "MCP HTTP request capacity reached");
        if (lifetime.signal.aborted) return reply(408, "MCP HTTP request ended");
        if (typeof message.id === "string" || typeof message.id === "number") requestId = message.id;
        const knownMethods = new Set(["initialize", "notifications/initialized", "notifications/cancelled", "tools/list", "tools/call", "ping"]);
        stage = typeof message.method === "string" && knownMethods.has(message.method) ? message.method : "other";
        if (!session) {
          if (message.method !== "initialize") return reply(400, "Initialize an MCP session first");
          prune();
          if (sessions.size + pendingSessions >= MAX_SESSIONS) return reply(503, "MCP HTTP session capacity reached");
          pendingSessions += 1;
          try {
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableJsonResponse: true,
              onsessioninitialized: id => { sessions.set(id, session!); },
            });
            const mcp = await connectChatGptMcpServer(options, normalizedRequestIds(transport));
            session = { transport, mcp, requests: new Map(), lastUsed: Date.now() };
            newSession = true;
          } finally { pendingSessions -= 1; }
        }
        session.lastUsed = Date.now();
        if (requestId !== undefined) {
          if (session.requests.has(requestId)) return reply(409, "Duplicate in-flight MCP request ID");
          session.requests.set(requestId, lifetime);
        }
        const ended = new Promise<Response>(resolve => {
          finishAbort = () => {
            if (requestId !== undefined && !newSession) {
              session!.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } });
              // SDK aborts the handler but does not complete its JSON HTTP response on cancellation.
              // Sending through the transport releases its request/response correlation too.
              void session!.mcp.server.transport!.send({ jsonrpc: "2.0", id: normalizedRequestId(requestId), error: { code: -32800, message: "Request cancelled" } }).catch(() => {});
            } else if (newSession) {
              void closeSession(session!);
            }
            resolve(reply(408, "MCP HTTP request ended"));
          };
          lifetime.signal.addEventListener("abort", finishAbort, { once: true });
          if (lifetime.signal.aborted) finishAbort();
        });
        const response = await Promise.race([session.transport.handleRequest(request, { parsedBody: body }), ended]);
        // Only route a schema-valid cancellation after the SDK accepted its HTTP/protocol envelope.
        if (cancellation && response.status === 202) {
          const parsed = CancelledNotificationSchema.safeParse(body);
          if (parsed.success && parsed.data.params.requestId !== undefined) {
            session.requests.get(parsed.data.params.requestId)?.abort();
          }
        }
        response.headers.set("Cache-Control", "no-store");
        console.error(`[chatgpt-web-mcp-http] ${JSON.stringify({ stage, status: response.status })}`);
        return response;
      } catch (error) {
        // Never log request bodies, headers, URLs, paths, or arbitrary SDK errors here.
        const status = error instanceof InvalidBody ? error.status : 500;
        console.error(`[chatgpt-web-mcp-http] ${JSON.stringify({ stage, status })}`);
        return reply(status, error instanceof InvalidBody ? error.message : "MCP HTTP request failed");
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        if (finishAbort) lifetime.signal.removeEventListener("abort", finishAbort);
        if (requestId !== undefined && session?.requests.get(requestId) === lifetime) session.requests.delete(requestId);
        if (session) {
          session.lastUsed = Date.now();
          if (newSession && !session.transport.sessionId) await session.mcp.close();
        }
        active.delete(lifetime);
      }
    },
  });
  return {
    url: new URL(`http://127.0.0.1:${http.port}/mcp`),
    async close() {
      closing = true;
      clearInterval(idleTimer);
      for (const request of active) request.abort();
      await Promise.all([...sessions.values()].map(closeSession));
      await http.stop(true);
    },
  };
}
