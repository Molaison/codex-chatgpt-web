import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import type { ChatGptMcpContract } from "../src/adapters/chatgpt-web/mcp-server";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
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

test("HTTP tools still require a live broker capability and preserve native approval arguments", async () => {
  const { http, broker, environment } = fixture();
  const { client } = await connect(http.url);
  const token = await broker.register(environment, 60_000);
  const invalid = await client.callTool({ name: "codex_exec", arguments: { turn_token: "turn_invalid_012345678901234567890", cmd: "pwd" } });
  expect(invalid.isError).toBeTrue();
  expect(JSON.stringify(invalid.content)).toContain("invalid, expired, or revoked");
  const execution = client.callTool({ name: "codex_exec", arguments: {
    turn_token: token, cmd: "pwd", sandbox_permissions: "require_escalated", justification: "Fixture only", prefix_rule: ["pwd"],
  } });
  const [invocation] = await broker.nextToolBatch(token);
  expect(invocation).toMatchObject({ wireName: "exec_command", arguments: {
    cmd: "pwd", sandbox_permissions: "require_escalated", justification: "Fixture only", prefix_rule: ["pwd"],
  } });
  // The outer Codex owner, not the HTTP server, executes or rejects tools.
  broker.completeTool(token, invocation!.callId, { isError: true, content: [{ type: "text", text: "Fixture owner denied execution" }] });
  expect((await execution).isError).toBeTrue();
  broker.revoke(token);
  const revoked = await client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "pwd" } });
  expect(revoked.isError).toBeTrue();
  expect(JSON.stringify(revoked.content)).toContain("has already finished");
  expect(JSON.stringify(revoked.content)).toContain("can no longer run");
});

test("HTTP safe contract requires turn start after Launcher Sent, then delivers completion", async () => {
  const { http, broker, environment } = fixture("safe");
  const { client } = await connect(http.url);
  const nonce = "fixture_surface_nonce_0123456789";
  const requestId = await broker.registerSafe(environment, nonce, 60_000);
  broker.confirmSafeTurnSent(requestId, nonce);
  const early = await client.callTool({ name: "codex_exec", arguments: { request_id: requestId, cmd: "pwd" } });
  expect(early.isError).toBeTrue();
  expect(JSON.stringify(early.content)).toContain("codex_turn_start");
  const start = await client.callTool({ name: "codex_turn_start", arguments: { request_id: requestId } });
  expect(start.isError).not.toBeTrue();
  const execution = client.callTool({ name: "codex_exec", arguments: { request_id: requestId, cmd: "pwd" } });
  const [invocation] = await broker.nextToolBatch(requestId);
  broker.completeTool(requestId, invocation!.callId, { content: [{ type: "text", text: "fixture" }] });
  expect((await execution).isError).not.toBeTrue();
  const completed = await client.callTool({ name: "codex_turn_complete", arguments: { request_id: requestId, final_answer: "HTTP fixture completed" } });
  expect(completed.structuredContent).toEqual({ completed: true, duplicate: false });
  expect(await broker.waitForSafeCompletion(requestId)).toBe("HTTP fixture completed");
});

test("concurrent HTTP requests with identical protocol IDs cannot cross broker turns", async () => {
  const { http, broker, environment } = fixture();
  const tokens = await Promise.all([broker.register(environment), broker.register(environment)]);
  const calls = tokens.map((token, i) => rpc(http.url, "tools/call", { name: "codex_exec", arguments: { turn_token: token, cmd: `fixture-${i}` } }));
  await Promise.all(tokens.map(async (token, i) => {
    const [invocation] = await broker.nextToolBatch(token);
    expect(invocation!.arguments!.cmd).toBe(`fixture-${i}`);
    broker.completeTool(token, invocation!.callId, { content: [{ type: "text", text: `result-${i}` }] });
  }));
  for (const [i, call] of calls.entries()) expect((await (await call).json()).result.content).toEqual([{ type: "text", text: `result-${i}` }]);
});

test("cancelling a reused request ID is isolated to its HTTP session", async () => {
  const { http, broker, environment } = fixture();
  const tokens = await Promise.all([broker.register(environment), broker.register(environment)]);
  const initialized = await Promise.all(tokens.map(() => rpc(http.url, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-session", version: "1" },
  })));
  const sessionIds = initialized.map(response => response.headers.get("mcp-session-id")!);
  const post = (sessionId: string, message: unknown) => fetch(http.url, {
    method: "POST", headers: { ...headers, "Mcp-Session-Id": sessionId }, body: JSON.stringify(message),
  });
  const calls = tokens.map((token, i) => post(sessionIds[i]!, {
    jsonrpc: "2.0", id: 77, method: "tools/call",
    params: { name: "codex_exec", arguments: { turn_token: token, cmd: `fixture-${i}` } },
  }));
  const invocations = await Promise.all(tokens.map(async (token, i) => {
    const [invocation] = await broker.nextToolBatch(token);
    expect(invocation!.arguments!.cmd).toBe(`fixture-${i}`);
    return invocation!;
  }));

  expect((await post(sessionIds[0]!, {
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 77 },
  })).status).toBe(202);
  expect((await calls[0]!).status).toBe(408);

  await broker.waitForRetirement(tokens[0]!);

  broker.completeTool(tokens[1]!, invocations[1]!.callId, { content: [{ type: "text", text: "other-session" }] });
  const other = await calls[1]!;
  expect(other.status).toBe(200);
  expect((await other.json()).result.content).toEqual([{ type: "text", text: "other-session" }]);

  const followup = post(sessionIds[1]!, {
    jsonrpc: "2.0", id: 78, method: "tools/call",
    params: { name: "codex_exec", arguments: { turn_token: tokens[1]!, cmd: "fixture-followup" } },
  });
  const [followupInvocation] = await broker.nextToolBatch(tokens[1]!);
  expect(followupInvocation!.arguments!.cmd).toBe("fixture-followup");
  broker.completeTool(tokens[1]!, followupInvocation!.callId, { content: [{ type: "text", text: "followup-result" }] });
  const followupResponse = await followup;
  expect(followupResponse.status).toBe(200);
  expect((await followupResponse.json()).result.content).toEqual([{ type: "text", text: "followup-result" }]);
});
