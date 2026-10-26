import { tmpdir } from "node:os";
// Reproduces slot52's real invalid-binding admission leak; Native dispatch must stay zero.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { TurnBroker, callTurnBroker, brokerClaimRejection } from "../src/adapters/chatgpt-web/turn-broker";
import { McpAdmissionBook } from "../src/adapters/chatgpt-web/mcp-admission";

test("exact invalid token remains denied without dispatch or new uncertainty; real proof cannot clear older unknowns", async () => {
  mkdirSync((process.env.Q39_TEST_ROOT ?? tmpdir()), { recursive: true });
  const root = mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()), "117-denied-"));
  const fd = openSync(root, "r"), socket = `/proc/${process.pid}/fd/${fd}/b.sock`;
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  const key = join(root, "release.key"); writeFileSync(key, "117-isolated-test-only-release-key", { mode: 0o600 });
  const server = startChatGptMcpHttpServer({ brokerSocketPath: socket, port: 0,
    releaseControl: { tokenFile: key, stateFile: join(root, "fence.json") } });
  const rpc = (body: object, session?: string) => fetch(server.url, { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
    ...(session ? { "mcp-session-id": session } : {}),
  }, body: JSON.stringify(body) });
  const init = await rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "117", version: "1" } } });
  const session = init.headers.get("mcp-session-id")!; await init.text();
  const rejectedToken = `turn_${"x".repeat(32)}`;
  const message = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "codex_exec", arguments: { turn_token: rejectedToken, cmd: "must never run" } } });
  try {
    const response = await rpc(message(1), session); const body = await response.json();
    expect(body.result.isError).toBe(true); expect(JSON.stringify(body)).toContain("invalid, expired, or revoked");
    expect(await (await rpc(message(1), session)).json()).toEqual(body);
    const status = await (await fetch(server.url.origin + "/admin/release/status", { headers: { authorization: "Bearer 117-isolated-test-only-release-key" } })).json();
    expect(status.uncertain_requests).toBe(0); expect(status.native_continuations).toBe(0); expect(status.active_tool_calls).toBe(0);
    let proof: unknown;
    try { await callTurnBroker(socket, { method: "claim", token: rejectedToken }); }
    catch (error) { proof = brokerClaimRejection(error); }
    expect(proof).toBeDefined();
    const book = new McpAdmissionBook(undefined, true);
    const fail = (id: number) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "rejected" }] } }));
    book.begin(message(1)); await book.complete(message(1), fail(1)); expect(book.uncertain).toBe(1);
    expect(book.noteClaimNotDispatched(1, proof)).toBe(false);
    book.begin(message(2)); expect(book.noteClaimNotDispatched(2, { method: "claim", stage: "broker_rejected", nativeDispatched: false })).toBe(false);
    expect(book.noteClaimNotDispatched(2, proof)).toBe(true); await book.complete(message(2), fail(2));
    expect(book.uncertain).toBe(1); expect(book.canClose).toBe(false);
  } finally {
    await fetch(server.url, { method: "DELETE", headers: { "mcp-session-id": session, "MCP-Protocol-Version": "2025-11-25", accept: "application/json, text/event-stream" } });
    await fetch(server.url.origin + "/admin/release/drain", { method: "POST", headers: { authorization: "Bearer 117-isolated-test-only-release-key" } });
    await server.close(); await broker.close(); closeSync(fd); rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
