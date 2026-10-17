import { afterEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { connectChatGptMcpServer, type ChatGptMcpContract } from "../src/adapters/chatgpt-web/mcp-server";
import { MCP_HTTP_MAX_BODY_BYTES, startChatGptMcpHttpServer, validateMcpPublicOrigin } from "../src/adapters/chatgpt-web/mcp-http";
import { runChatGptMcpMain } from "../src/adapters/chatgpt-web/mcp-main";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import * as brokerCalls from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(contract: ChatGptMcpContract = "native", publicOrigin?: string) {
  const root = mkdtempSync(join(tmpdir(), "cgw-http-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brokerSocketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(brokerSocketPath);
  cleanup.push(() => broker.close());
  const http = startChatGptMcpHttpServer({ brokerSocketPath, contract, port: 0, publicOrigin });
  cleanup.push(() => http.close());
  const environment: ChatGptTurnEnvironment = {
    cwd: root, roots: [root], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [{ name: "exec_command", description: "Fixture command dispatch", parameters: { type: "object", properties: {
      cmd: { type: "string" }, sandbox_permissions: { type: "string" }, justification: { type: "string" }, prefix_rule: { type: "array", items: { type: "string" } },
    } } }],
  };
  return { http, broker, brokerSocketPath, environment };
}
async function connect(url: URL) {
  const client = new Client({ name: "mcp-http-test", version: "1.0.0" });
  cleanup.push(() => client.close());
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
async function rpc(url: URL, method: string, params: unknown = {}, extraHeaders: Record<string, string> = {}) {
  if (method !== "initialize" && !extraHeaders["Mcp-Session-Id"]) {
    const init = await rpc(url, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-test", version: "1" } });
    extraHeaders = { "Mcp-Session-Id": init.headers.get("mcp-session-id")!, ...extraHeaders };
  }
  return fetch(url, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

test("HTTP initialize and tools/list preserve both existing MCP tool contracts", async () => {
  for (const contract of ["native", "safe"] as const) {
    const { http, brokerSocketPath } = fixture(contract);
    const { client, transport } = await connect(http.url);
    expect(transport.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    const [local, remote] = InMemoryTransport.createLinkedPair();
    const memoryServer = await connectChatGptMcpServer({ brokerSocketPath, contract }, remote);
    cleanup.push(() => memoryServer.close());
    const memoryClient = new Client({ name: "in-memory-contract", version: "1" });
    cleanup.push(() => memoryClient.close());
    await memoryClient.connect(local);
    expect(await client.listTools()).toEqual(await memoryClient.listTools());
    expect(client.getServerVersion()?.name).toBe(contract === "safe" ? "codex-safe" : "codex-native");
    const response = await rpc(http.url, "tools/list");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("mcp-session-id")).toBeTrue();
  }
});

test("HTTP denies rebinding and cross-origin requests without trusting forwarded headers", async () => {
  const { http } = fixture("native", "https://mcp.example.test");
  for (const extra of [
    { Host: "evil.example" },
    { Origin: "https://evil.example" },
    { Origin: "null" },
    { Host: "evil.example", "X-Forwarded-Host": "mcp.example.test" },
  ] as Array<Record<string, string>>) expect((await rpc(http.url, "tools/list", {}, extra)).status).toBe(403);
  expect((await rpc(http.url, "tools/list", {}, { Host: "mcp.example.test", Origin: "https://mcp.example.test" })).status).toBe(200);
  expect((await rpc(http.url, "tools/list", {}, { Origin: http.url.origin })).status).toBe(200);
  const { http: localOnly } = fixture();
  expect((await rpc(localOnly.url, "tools/list", {}, { Host: "mcp.example.test" })).status).toBe(403);
});

test("HTTP uses the exact MCP path and does not fake OAuth or legacy SSE discovery", async () => {
  const { http } = fixture();
  for (const path of ["/", "/sse", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/.well-known/openid-configuration"]) {
    expect((await fetch(new URL(path, http.url))).status).toBe(404);
  }
  for (const method of ["GET", "OPTIONS"]) {
    const response = await fetch(http.url, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
    expect(response.headers.has("access-control-allow-origin")).toBeFalse();
  }
});

test("HTTP validates JSON, encoding, body size and MCP negotiation", async () => {
  const { http } = fixture();
  expect((await fetch(http.url, { method: "POST", headers, body: "{" })).status).toBe(400);
  expect((await fetch(http.url, { method: "POST", headers: { ...headers, "Content-Encoding": "gzip" }, body: "{}" })).status).toBe(415);
  // Bun 1.4's Windows HTTP parser can reset the connection at maxRequestBodySize
  // before our fetch handler sends 413. Both reject the oversized request; other
  // failures (or any successful response) must still fail this assertion.
  const oversized = await fetch(http.url, { method: "POST", headers, body: " ".repeat(MCP_HTTP_MAX_BODY_BYTES + 1) })
    .then(response => response.status, (error: NodeJS.ErrnoException) => {
      if (process.platform === "win32" && error.code === "ECONNRESET") return "ECONNRESET";
      throw error;
    });
  expect(process.platform === "win32" ? [413, "ECONNRESET"] : [413]).toContain(oversized);
  expect((await rpc(http.url, "tools/list", {}, { "MCP-Protocol-Version": "invalid" })).status).toBe(400);
  expect((await rpc(http.url, "tools/list", {}, { Accept: "text/plain" })).status).toBe(406);
  expect((await rpc(http.url, "tools/list", {}, { "Content-Type": "text/plain" })).status).toBe(415);
  const initialized = await rpc(http.url, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  expect((await initialized.json()).result.protocolVersion).toBe("2025-11-25");
});

test("invalid HTTP configuration fails closed and stdio rejects HTTP-only flags", async () => {
  for (const origin of ["http://example.test", "https://user:secret@example.test", "https://example.test/mcp", "https://example.test?key=secret", "https://*.example.test", "not-a-url"]) {
    expect(() => validateMcpPublicOrigin(origin)).toThrow("HTTPS origin");
  }
  for (const args of [
    ["--transport", "websocket"], ["--port", "8788"], ["--public-origin", "https://example.test"],
    ["--transport", "http", "--port", "0"], ["--transport", "http", "--port", "1.5"],
    ["--transport", "http", "--port", "65536"], ["--transport", "http", "--public-origin", "--port", "8788"],
  ]) await expect(runChatGptMcpMain(args)).rejects.toThrow();
});


test("HTTP disconnect cancels its in-flight request without poisoning another request", async () => {
  const { http, environment } = fixture();
  let reached!: () => void;
  let cancelled!: () => void;
  const received = new Promise<void>(resolve => { reached = resolve; });
  const aborted = new Promise<void>(resolve => { cancelled = resolve; });
  const broker = spyOn(brokerCalls, "callTurnBroker").mockImplementation(async (_path, request, _timeout, signal) => {
    if (request.method === "claim") return { bindingId: "fixture-binding", environment } as any;
    if (request.method === "activity_complete" || request.method === "release") return {} as any;
    if (request.method === "invoke") {
      reached();
      return await new Promise<any>((_resolve, reject) => {
        signal!.addEventListener("abort", () => { cancelled(); reject(new Error("fixture aborted")); }, { once: true });
      });
    }
    throw new Error("Unexpected fixture broker method");
  });
  cleanup.push(() => broker.mockRestore());
  const { transport } = await connect(http.url);
  const controller = new AbortController();
  const call = fetch(http.url, { method: "POST", headers: { ...headers, "Mcp-Session-Id": transport.sessionId! }, signal: controller.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "codex_exec", arguments: { turn_token: "fixture_turn_01234567890123456789", cmd: "fixture pending" },
    } }),
  }).catch(error => error);
  await received;
  controller.abort();
  await call;
  await aborted;
  expect((await rpc(http.url, "tools/list")).status).toBe(200);
}, 5_000);

test("SDK cancellation isolates HTTP requests for distinct simulated broker turns", async () => {
  const { http, environment } = fixture();
  const { client } = await connect(http.url);
  const { client: other } = await connect(http.url);
  const pending = new Map<string, { signal: AbortSignal; resolve: (value: any) => void }>();
  let reached!: () => void;
  const allReceived = new Promise<void>(resolve => { reached = resolve; });
  const broker = spyOn(brokerCalls, "callTurnBroker").mockImplementation(async (_path, request, _timeout, signal) => {
    if (request.method === "claim") return { bindingId: `fixture-binding-${request.token}`, environment } as any;
    if (request.method === "activity_complete" || request.method === "release") return {} as any;
    if (request.method === "invoke") return await new Promise<any>((resolve, reject) => {
      const command = (request.arguments as Record<string, unknown>).cmd as string;
      pending.set(command, { signal: signal!, resolve });
      signal!.addEventListener("abort", () => reject(new Error("fixture cancelled")), { once: true });
      if (pending.size === 3) reached();
    });
    throw new Error("Unexpected fixture broker method");
  });
  cleanup.push(() => broker.mockRestore());
  const controller = new AbortController();
  const cancelled = client.callTool({ name: "codex_exec", arguments: { turn_token: "fixture_cancel_01234567890123456789", cmd: "cancel" } }, undefined, { signal: controller.signal }).catch(error => error);
  const sameSession = client.callTool({ name: "codex_exec", arguments: { turn_token: "fixture_same-session_01234567890123456789", cmd: "same-session" } });
  const otherSession = other.callTool({ name: "codex_exec", arguments: { turn_token: "fixture_other-session_01234567890123456789", cmd: "other-session" } });
  await allReceived;
  const aborted = new Promise<void>(resolve => pending.get("cancel")!.signal.addEventListener("abort", () => resolve(), { once: true }));
  controller.abort();
  await cancelled;
  await aborted;
  expect(pending.get("same-session")!.signal.aborted).toBeFalse();
  expect(pending.get("other-session")!.signal.aborted).toBeFalse();
  for (const name of ["same-session", "other-session"]) pending.get(name)!.resolve({ content: [{ type: "text", text: name }] });
  expect((await sameSession).content).toEqual([{ type: "text", text: "same-session" }]);
  expect((await otherSession).content).toEqual([{ type: "text", text: "other-session" }]);
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
}, 5_000);

test("HTTP rejects batching before broker dispatch and enforces session lifecycle", async () => {
  const { http } = fixture();
  const { transport } = await connect(http.url);
  const sessionHeaders = { ...headers, "Mcp-Session-Id": transport.sessionId! };
  const broker = spyOn(brokerCalls, "callTurnBroker");
  cleanup.push(() => broker.mockRestore());
  const batch = Array.from({ length: 40 }, (_, id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "codex_exec", arguments: { turn_token: "fixture_token_01234567890123456789", cmd: "never" } } }));
  const response = await fetch(http.url, { method: "POST", headers: sessionHeaders, body: JSON.stringify(batch) });
  expect(response.status).toBe(400);
  expect(broker).not.toHaveBeenCalled();
  expect((await fetch(http.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status).toBe(400);
  expect((await rpc(http.url, "tools/list", {}, { "Mcp-Session-Id": "unknown" })).status).toBe(404);
  expect((await fetch(http.url, { method: "DELETE", headers: sessionHeaders })).status).toBe(200);
  expect((await rpc(http.url, "tools/list", {}, { "Mcp-Session-Id": transport.sessionId! })).status).toBe(404);
});

test("zero and empty request IDs cancel broker work and can be safely reused", async () => {
  const { http, environment } = fixture();
  const { transport } = await connect(http.url);
  const sessionHeaders = { ...headers, "Mcp-Session-Id": transport.sessionId! };
  let reached!: () => void;
  let brokerSignal: AbortSignal | undefined;
  const broker = spyOn(brokerCalls, "callTurnBroker").mockImplementation(async (_path, request, _timeout, signal) => {
    if (request.method === "claim") return { bindingId: "fixture-binding", environment } as any;
    if (request.method === "activity_complete" || request.method === "release") return {} as any;
    if (request.method === "invoke") {
      brokerSignal = signal;
      reached();
      return await new Promise<any>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("fixture cancelled")), { once: true }));
    }
    throw new Error("Unexpected fixture broker method");
  });
  cleanup.push(() => broker.mockRestore());
  const post = (message: unknown) => fetch(http.url, { method: "POST", headers: sessionHeaders, body: JSON.stringify(message) });
  for (const id of [0, "", "0"] as const) {
    const received = new Promise<void>(resolve => { reached = resolve; });
    const call = post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "codex_exec", arguments: { turn_token: "fixture_token_01234567890123456789", cmd: "fixture" } } });
    await received;
    expect((await post({ jsonrpc: "2.0", id, method: "tools/list" })).status).toBe(409);
    const cancelled = await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    expect(cancelled.status).toBe(202);
    await call;
    expect(brokerSignal!.aborted).toBeTrue();
    const reused = await post({ jsonrpc: "2.0", id, method: "tools/list" });
    expect(reused.status).toBe(200);
    expect((await reused.json()).id).toBe(id);
  }
}, 5_000);


test("default stdio CLI and opt-in HTTP expose the same native and safe tools", async () => {
  for (const contract of ["native", "safe"] as const) {
    const { http, brokerSocketPath } = fixture(contract);
    const { client } = await connect(http.url);
    const stdio = new Client({ name: "stdio-regression", version: "1" });
    cleanup.push(() => stdio.close());
    await stdio.connect(new StdioClientTransport({ command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", brokerSocketPath],
      cwd: process.cwd(), stderr: "pipe",
    }));
    expect(await stdio.listTools()).toEqual(await client.listTools());
  }
}, 10_000);

test("HTTP bounds idle sessions and expires them without treating session IDs as tool authority", async () => {
  const { http } = fixture();
  const params = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "session-bound", version: "1" } };
  let firstSession = "";
  for (let i = 0; i < 64; i++) {
    const initialized = await rpc(http.url, "initialize", params);
    expect(initialized.status).toBe(200);
    firstSession ||= initialized.headers.get("mcp-session-id")!;
  }
  expect((await rpc(http.url, "initialize", params)).status).toBe(503);
  const now = Date.now();
  const time = spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
  try {
    expect((await rpc(http.url, "initialize", params)).status).toBe(200);
    expect((await rpc(http.url, "tools/list", {}, { "Mcp-Session-Id": firstSession })).status).toBe(404);
  } finally { time.mockRestore(); }
});
