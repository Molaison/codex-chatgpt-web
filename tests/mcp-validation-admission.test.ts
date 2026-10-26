import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAdmissionBook } from "../src/adapters/chatgpt-web/mcp-admission";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { connectChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("SDK schema rejection reports local non-dispatch before any broker claim", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const rejected: Array<string | number> = [];
  const server = await connectChatGptMcpServer({ brokerSocketPath: "/unused/schema-validation.sock",
    onToolNotDispatched: id => rejected.push(id),
    onClaimNotDispatched: () => { throw Error("schema rejection must not enter claim"); },
  }, serverTransport);
  const client = new Client({ name: "schema-admission-fixture", version: "1" });
  try {
    await client.connect(clientTransport);
    for (const args of [{ turn_token: "malformed", cmd: "must not run" },
      { turn_token: `turn_${"x".repeat(32)}`, cmd: 123 }]) {
      const result = await client.callTool({ name: "codex_exec", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Input validation error");
    }
    expect(rejected).toHaveLength(2);
    expect(new Set(rejected).size).toBe(2);
  } finally {
    await client.close(); await server.close();
  }
});

test("SDK envelope rejection permits HTTP session drain while its original identity stays fenced", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-schema-admission-"));
  const socket = join(root, "broker.sock");
  const broker = TurnBroker.forSocket(socket);
  await broker.listen();
  const token = "schema-admission-isolated-release-key", tokenFile = join(root, "release.key");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const server = startChatGptMcpHttpServer({ brokerSocketPath: socket, port: 0, contract: "native",
    releaseControl: { tokenFile, stateFile: join(root, "release.json") } });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25" };
  let session: string | undefined;
  const rpc = (body: unknown) => fetch(server.url, { method: "POST", headers: {
    ...headers, ...(session ? { "mcp-session-id": session } : {}),
  }, body: JSON.stringify(body) });
  const control = (action: "status" | "drain") => fetch(`${server.url.origin}/admin/release/${action}`, {
    method: action === "status" ? "GET" : "POST", headers: { authorization: `Bearer ${token}` },
  });
  try {
    const initialized = await rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "schema-release-fixture", version: "1" },
    } });
    expect(initialized.status).toBe(200);
    session = initialized.headers.get("mcp-session-id")!; await initialized.text();
    const rejected = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 123, arguments: {} } };
    const response = await rpc(rejected), body = await response.json();
    expect(response.status).toBe(200); expect(body.error).toBeDefined();
    expect(await (await rpc(rejected)).json()).toEqual(body);
    expect((await rpc({ ...rejected, params: { name: "codex_exec", arguments: {} } })).status).toBe(409);
    expect(await (await control("status")).json()).toMatchObject({ active_tool_calls: 0,
      uncertain_requests: 0, native_continuations: 0, durable_live_turns: 0, durable_unknown_calls: 0 });
    const deleted = await fetch(server.url, { method: "DELETE", headers: { ...headers, "mcp-session-id": session } });
    expect(deleted.status).toBe(200); await deleted.text(); session = undefined;
    expect(await (await control("drain")).json()).toMatchObject({ safe_to_stop: true });
  } finally {
    if (session) await fetch(server.url, { method: "DELETE", headers: { ...headers, "mcp-session-id": session } });
    await control("drain");
    try { await server.close(); }
    finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
  }
}, 10_000);

test("RPC errors without local proof and transport failures with local proof remain uncertain", async () => {
  for (const transportFailure of [false, true]) {
    const book = new McpAdmissionBook(undefined, true);
    const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_exec", arguments: {} } };
    expect(book.begin(message)).toBe(true);
    if (transportFailure) expect(book.noteLocalNotDispatched(1)).toBe(true);
    await book.complete(message, Response.json({ jsonrpc: "2.0", id: 1,
      error: { code: -32603, message: "unproved failure" } }), transportFailure);
    expect(book.uncertain).toBe(1); expect(book.canClose).toBe(false);
    expect(book.noteLocalNotDispatched(1)).toBe(false);
  }
});

test.each([
  ["cancelled", -32800],
  ["connection closed", -32000],
  ["timed out", -32001],
  ["unclassified", -32002],
])("local non-dispatch proof cannot settle a %s RPC", async (_kind, code) => {
  const book = new McpAdmissionBook(undefined, true);
  const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_exec", arguments: {} } };
  expect(book.begin(message)).toBe(true);
  expect(book.noteLocalNotDispatched(1)).toBe(true);
  const body = { jsonrpc: "2.0", id: 1, error: { code, message: "failure after local rejection" } };
  await book.complete(message, Response.json(body));
  expect(book.uncertain).toBe(1); expect(book.canClose).toBe(false);
  expect(book.noteLocalNotDispatched(1)).toBe(false);
  expect(await (await book.duplicate(message)!).json()).toEqual(body);
  expect(book.begin(message)).toBe(false);
});
