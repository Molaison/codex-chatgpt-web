import { tmpdir } from "node:os";
// Actual HTTP/SDK/broker; physical Native execution is synthetic in this contract test.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { OperationJournal, operationDigest } from "../src/adapters/chatgpt-web/operation-journal";

test("fresh MCP id=1 polls are distinct; same-session duplicate joins; drain permits continuation reconnection", async () => {
  mkdirSync((process.env.Q39_TEST_ROOT ?? tmpdir()), { recursive: true });
  const root = mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()), "96-session-"));
  const fd = openSync(root, "r"); const socket = `/proc/${process.pid}/fd/${fd}/b.sock`;
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [
    { name: "exec_command", description: "Synthetic command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
    { name: "write_stdin", description: "Synthetic poll", parameters: { type: "object", properties: { session_id: { type: "integer" }, chars: { type: "string" }, yield_time_ms: { type: "integer" } } } },
  ] });
  const key = join(root, "release.key"); writeFileSync(key, "96-isolated-test-only-release-key", { mode: 0o600 });
  const server = startChatGptMcpHttpServer({ brokerSocketPath: socket, port: 0,
    releaseControl: { tokenFile: key, stateFile: join(root, "fence.json") } });
  const sessions: string[] = [];
  const rpc = (body: object, session?: string) => fetch(server.url.origin + "/mcp", { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
    ...(session ? { "mcp-session-id": session } : {}),
  }, body: JSON.stringify(body) });
  const initialize = async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "96-reconnect", version: "1" } } });
    expect(response.status).toBe(200); const session = response.headers.get("mcp-session-id")!;
    sessions.push(session); await response.text(); return session;
  };
  const admin = async (action = "status") => {
    const response = await fetch(server.url.origin + "/admin/release/" + action, { method: action === "status" ? "GET" : "POST",
      headers: { authorization: "Bearer 96-isolated-test-only-release-key" } });
    expect(response.status).toBe(200); return response.json();
  };
  const call = (name: string, args = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name, arguments: { turn_token: token, ...args } } });
  const running: BrokerToolResult = { content: [{ type: "text", text: "Wall time: 1.0000 seconds\nProcess running with session ID 42\nOutput:\n" }] };
  const terminal: BrokerToolResult = { content: [{ type: "text", text: "Wall time: 0.0001 seconds\nProcess exited with code 0\nOutput:\n1\n" }] };
  try {
    const a = await initialize(); const command = call("codex_exec", { cmd: "synthetic one-time effect" });
    const first = rpc(command, a).then(r => r.json());
    const [exec] = await broker.nextToolBatch(token); broker.completeTool(token, exec!.callId, running);
    const firstResult = await first; expect(firstResult.id).toBe(1);
    expect(await (await rpc(command, a)).json()).toEqual(firstResult);
    const b = await initialize(); const poll = call("codex_write_stdin", { session_id: 42, chars: "", yield_time_ms: 1000 });
    const oldPoll = rpc(poll, b).then(r => r.json());
    const [old] = await broker.nextToolBatch(token);
    expect(old!.wireName).toBe("write_stdin");
    broker.completeTool(token, old!.callId, running);
    expect((await oldPoll).result).toEqual(running);
    await admin("drain");
    const c = await initialize(); // A native continuation may reconnect, but cannot start a new command.
    const denied = await rpc(call("codex_exec", { cmd: "must not execute" }, 2), c);
    expect(denied.status).toBe(503); await denied.text();
    const finalPoll = rpc(poll, c).then(r => r.json());
    const journal = new OperationJournal(root, "tool-operations");
    for (let i = 0; i < 100; i++) {
      if (Object.keys(journal.read<any>(operationDigest(token)).calls).length === 3) break;
      await Bun.sleep(5);
    }
    const next = (await broker.nextToolBatch(token)).find(value => value.callId !== old!.callId)!;
    expect(next).toBeDefined(); expect(next.callId).not.toBe(old!.callId);
    broker.completeTool(token, next.callId, terminal);
    expect((await finalPoll).result).toEqual(terminal);
    expect((await admin()).native_continuations).toBe(0);
    expect(Object.keys(journal.read<any>(operationDigest(token)).calls)).toHaveLength(3);
    // Terminal command receipts do not retire the browser turn's capability by themselves.
    expect((await admin()).safe_to_stop).toBe(false);
    broker.revoke(token);
    for (const session of sessions) {
      const response = await fetch(server.url.origin + "/mcp", { method: "DELETE", headers: {
        "mcp-session-id": session, "MCP-Protocol-Version": "2025-11-25" } });
      expect(response.ok).toBe(true); await response.text();
    }
    expect((await admin()).safe_to_stop).toBe(true);
  } finally { await server.close(); await broker.close(); closeSync(fd); rmSync(root, { recursive: true, force: true }); }
}, 15000);
