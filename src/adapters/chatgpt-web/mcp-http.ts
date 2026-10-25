import { ReleaseAdmission, releaseTrackedResponse, type ReleaseControlConfig } from "../../release-admission";
import { McpAdmissionBook } from "./mcp-admission";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CancelledNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { connectChatGptMcpServer, type ChatGptMcpServerOptions } from "./mcp-server";
import { callTurnBroker } from "./turn-broker";
import { mcpRequestRef } from "./mcp-observation";

// Bound encoded HTTP input independently of the tool schema (JSON escapes count toward this cap).
export const MCP_HTTP_MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 32;
const MAX_SESSIONS = 64;
const SESSION_IDLE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const BODY_TIMEOUT_MS = 30_000;

export interface ChatGptMcpHttpOptions extends ChatGptMcpServerOptions {
  port?: number;
  releaseControl?: ReleaseControlConfig;
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
const normalizedRequestId = (id: string | number, scope?: string) => JSON.stringify(scope
  ? ["mcp-http-session", scope, typeof id, id] : [typeof id, id]);
const originalRequestId = (id: string | number) => {
    if (typeof id !== "string") return id;
    try {
      const value = JSON.parse(id);
      if (Array.isArray(value) && value.length === 4 && value[0] === "mcp-http-session"
        && typeof value[1] === "string" && typeof value[3] === value[2]
        && (value[2] === "string" || value[2] === "number")) return value[3] as string | number;
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === value[0]
        && (value[0] === "string" || value[0] === "number")) return value[1] as string | number;
    } catch { /* Preserve server-originated IDs that are not client request IDs. */ }
    return id;
};

function normalizedRequestIds(inner: WebStandardStreamableHTTPServerTransport, scope: string): Transport {
  const encode = (id: string | number) => normalizedRequestId(id, scope);
  const decode = originalRequestId;
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
  scope: string;
  transport: WebStandardStreamableHTTPServerTransport;
  mcp: Awaited<ReturnType<typeof connectChatGptMcpServer>>;
  requests: Map<string | number, AbortController>;
  lastUsed: number;
  release: McpAdmissionBook;
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
  const release = options.releaseControl ? new ReleaseAdmission("mcp", options.releaseControl, () => ({
    active_requests: active.size, open_sessions: sessions.size, pending_sessions: pendingSessions,
    active_tool_calls: [...sessions.values()].reduce((sum, s) => sum + s.release.pending, 0),
    native_continuations: [...sessions.values()].reduce((sum, s) => sum + s.release.continuations, 0),
    uncertain_requests: [...sessions.values()].reduce((sum, s) => sum + s.release.uncertain, 0),
  })) : undefined;
  const closeSession = async (session: HttpSession) => {
    for (const [id, value] of sessions) if (value === session) sessions.delete(id);
    for (const request of session.requests.values()) request.abort();
    await session.mcp.close();
  };
  const prune = () => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of sessions.values()) {
      if (session.requests.size === 0 && (!release || session.release.canClose) && session.lastUsed < cutoff) void closeSession(session);
    }
  };
  const idleTimer = setInterval(prune, 30_000);
  idleTimer.unref();
  async function fetchMcp(request: Request, server: {port: number | undefined}): Promise<Response> {
      const localHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      const allowedHosts = new Set([...localHosts, ...(publicOrigin ? [publicOrigin.host] : [])]);
      // Never trust Forwarded/X-Forwarded-Host or arbitrary browser origins.
      if (!allowedHosts.has(request.headers.get("host") ?? "")) return reply(403, "Host is not allowed");
      const origin = request.headers.get("origin");
      const allowedOrigins = new Set([...localHosts.map(host => `http://${host}`), ...(publicOrigin ? [publicOrigin.origin] : [])]);
      if (origin !== null && !allowedOrigins.has(origin)) return reply(403, "Origin is not allowed");
      const control = release?.control(request);
      if (control) return control;
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
        if (release && (!session.release.canClose || session.requests.size)) return reply(409, "Accepted MCP work is still live; retain this session owner");
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
      let receiptMessage: Record<string, any> | undefined;
      let noteDeliveryLoss: (() => Promise<void>) | undefined;
      let publicAbort: (() => void) | undefined;
      let deliveryLoss: Promise<void> | undefined;
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
          // A reconnect is protocol setup, not new tool admission. Existing native
          // processes may need a fresh MCP session to deliver their next empty poll.
          if (release?.draining && ![...sessions.values()].some(s => s.release.continuations || s.release.pending)) {
            return reply(503, "MCP admission is fenced; existing sessions are preserved");
          }
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
            const scope = randomUUID();
            const admission = new McpAdmissionBook((token, sessionId) => {
              for (const value of sessions.values()) value.release.noteProcessClosed(token, sessionId);
            }, options.contract !== "safe");
            const mcp = await connectChatGptMcpServer({ ...options,
              onClaimNotDispatched: (id, proof) => { admission.noteClaimNotDispatched(originalRequestId(id), proof); },
            }, normalizedRequestIds(transport, scope));
            session = { scope, transport, mcp, requests: new Map(), lastUsed: Date.now(), release: admission };
            newSession = true;
          } finally { pendingSessions -= 1; }
        }
        session.lastUsed = Date.now();
        if (release && message.method === "tools/call") {
          if (requestId === undefined) return reply(400, "Tool calls require a request identity");
          const duplicate = session.release.duplicate(message);
          if (duplicate) return await duplicate;
          if (!session.release.allowed(message, release.draining)
            && ![...sessions.values()].some(s => s.release.allowed(message, true))) {
            return reply(503, "New MCP work is fenced; continue only previously accepted handles");
          }
          if (!session.release.begin(message)) return reply(503, "MCP receipt capacity reached; accepted identities retained");
          receiptMessage = message;
          // A lost HTTP response is not cancellation of accepted native work.
          request.signal.removeEventListener("abort", abort);
          clearTimeout(timer);
          if (options.contract !== "safe") {
            const params = message.params as Record<string, any> | undefined;
            const args = params?.arguments;
            const wireName = params?.name === "codex_exec" ? "exec_command"
              : params?.name === "codex_write_stdin" ? "write_stdin"
              : params?.name === "codex_tool_call" ? args?.wire_name : undefined;
            if (typeof args?.turn_token === "string" && ["exec_command", "write_stdin"].includes(wireName)) {
              noteDeliveryLoss = async () => {
                const observed = await callTurnBroker<{ recorded: boolean }>(options.brokerSocketPath, {
                  method: "public_delivery_lost", token: args.turn_token,
                  wireName, rpcId: normalizedRequestId(requestId!, session!.scope),
                }, 5_000);
                console.error(`[chatgpt-web-mcp-http] delivery_lost=${JSON.stringify({
                  request_ref: mcpRequestRef(normalizedRequestId(requestId!, session!.scope)),
                  recorded: observed.recorded, native_cancelled: false })}`);
              };
              publicAbort = () => {
                deliveryLoss = noteDeliveryLoss!().catch(() => {
                  console.error("[chatgpt-web-mcp-http] delivery loss proof unavailable; execution retained");
                });
              };
              request.signal.addEventListener("abort", publicAbort, { once: true });
              if (request.signal.aborted) publicAbort();
            }
          }
        }
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
              void session!.mcp.server.transport!.send({ jsonrpc: "2.0", id: normalizedRequestId(requestId, session!.scope), error: { code: -32800, message: "Request cancelled" } }).catch(() => {});
            } else if (newSession) {
              void closeSession(session!);
            }
            resolve(reply(408, "MCP HTTP request ended"));
          };
          lifetime.signal.addEventListener("abort", finishAbort, { once: true });
          if (lifetime.signal.aborted) finishAbort();
        });
        const ownerRequest = receiptMessage ? new Request(request.url, {method: request.method, headers: request.headers, signal: lifetime.signal}) : request;
        let response = await Promise.race([session.transport.handleRequest(ownerRequest, { parsedBody: body }), ended]);
        if (receiptMessage) response = await session.release.complete(receiptMessage, response);
        // Retry only recording evidence after the handler settles, never the Native action.
        if (request.signal.aborted && noteDeliveryLoss) await noteDeliveryLoss();
        // Only route a schema-valid cancellation after the SDK accepted its HTTP/protocol envelope.
        if (cancellation && response.status === 202) {
          const parsed = CancelledNotificationSchema.safeParse(body);
          if (parsed.success && parsed.data.params.requestId !== undefined) {
            session.requests.get(parsed.data.params.requestId)?.abort();
          }
        }
        response.headers.set("Cache-Control", "no-store");
        console.error(`[chatgpt-web-mcp-http] ${JSON.stringify({ stage, status: response.status,
          ...(requestId !== undefined ? { request_ref: mcpRequestRef(normalizedRequestId(requestId)) } : {}),
          turn_release: "not_requested",
        })}`);
        return response;
      } catch (error) {
        // Never log request bodies, headers, URLs, paths, or arbitrary SDK errors here.
        const status = error instanceof InvalidBody ? error.status : 500;
        console.error(`[chatgpt-web-mcp-http] ${JSON.stringify({ stage, status,
          ...(requestId !== undefined ? { request_ref: mcpRequestRef(normalizedRequestId(requestId)) } : {}),
          turn_release: "not_requested",
        })}`);
        const failed = reply(status, error instanceof InvalidBody ? error.message : "MCP HTTP request failed");
        return receiptMessage && session ? await session.release.complete(receiptMessage, failed, true) : failed;
      } finally {
        if (publicAbort) request.signal.removeEventListener("abort", publicAbort);
        await deliveryLoss;
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
  }
  const http = Bun.serve({hostname: "127.0.0.1", port, maxRequestBodySize: MCP_HTTP_MAX_BODY_BYTES, idleTimeout: 150,
    async fetch(request, server): Promise<Response> {
      if (new URL(request.url).pathname.startsWith("/admin/release/")) return fetchMcp(request, server);
      if (release?.sealed) return new Response("Native ingress sealed", {status:503});
      const lease = release?.enter();
      try {
        const response = await fetchMcp(request, server);
        return lease ? releaseTrackedResponse(response, lease.finish, request.signal) : response;
      } catch (error) { lease?.finish(); throw error; }
    },
  });
  return {
    url: new URL(`http://127.0.0.1:${http.port}/mcp`),
    async close() {
      if (release && !release.status().safe_to_stop) throw Error("MCP native work/sessions are not drained; preserve original owner");
      closing = true;
      clearInterval(idleTimer);
      for (const request of active) request.abort();
      await Promise.all([...sessions.values()].map(closeSession));
      await http.stop(true);
    },
  };
}
