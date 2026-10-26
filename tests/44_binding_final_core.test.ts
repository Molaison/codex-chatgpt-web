import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { OperationJournal, operationDigest } from "../src/adapters/chatgpt-web/operation-journal";

test("binding correction requires a fresh RPC and exact current token; rejected receipts and instance isolation survive", async () => {
  mkdirSync((process.env.Q39_TEST_ROOT ?? tmpdir()), { recursive: true });
  const root = mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()), "43-binding-"));
  const otherRoot = join(root, "other-instance"); mkdirSync(otherRoot);
  const fd = openSync(root, "r");
  const otherFd = openSync(otherRoot, "r");
  const socket = `/proc/${process.pid}/fd/${fd}/b.sock`;
  const otherSocket = `/proc/${process.pid}/fd/${otherFd}/b.sock`;
  const broker = TurnBroker.forSocket(socket);
  const otherBroker = TurnBroker.forSocket(otherSocket);
  await broker.listen(); await otherBroker.listen();
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [{ name: "exec_command",
      description: "synthetic Native receipt only", parameters: {
        type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"],
      } }] });
  const wrongToken = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  const key = join(root, "release.key");
  writeFileSync(key, "43-synthetic-control-key", { mode: 0o600 });
  const server = startChatGptMcpHttpServer({ brokerSocketPath: socket, port: 0,
    releaseControl: { tokenFile: key, stateFile: join(root, "fence.json") } });
  const otherServer = startChatGptMcpHttpServer({ brokerSocketPath: otherSocket, port: 0 });
  const journal = new OperationJournal(root, "tool-operations");
  const otherJournal = new OperationJournal(otherRoot, "tool-operations");
  const rpc = (url: URL, body: object, session?: string) => fetch(url, { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25", ...(session ? { "mcp-session-id": session } : {}),
  }, body: JSON.stringify(body) });
  const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "43-binding", version: "1" },
  } };
  const message = (id: number, supplied: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name: "codex_exec", arguments: { turn_token: supplied, cmd: "synthetic read" },
  } });
  const initialized = await rpc(server.url, init);
  const session = initialized.headers.get("mcp-session-id")!; await initialized.text();
  const otherInitialized = await rpc(otherServer.url, init);
  const otherSession = otherInitialized.headers.get("mcp-session-id")!; await otherInitialized.text();
  const status = async () => (await fetch(server.url.origin + "/admin/release/status", {
    headers: { authorization: "Bearer 43-synthetic-control-key" },
  })).json() as Promise<Record<string, number>>;
  try {
    const rejected = await (await rpc(server.url, message(1, wrongToken), session)).json();
    expect(rejected.result.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("invalid, expired, or revoked");
    expect(Object.keys(journal.read<any>(operationDigest(token)).calls)).toHaveLength(0);
    expect((await status()).uncertain_requests).toBe(0);
    expect(await (await rpc(server.url, message(1, wrongToken), session)).json()).toEqual(rejected);
    expect((await rpc(server.url, message(1, token), session)).status).toBe(409);
    const foreign = await (await rpc(otherServer.url, message(1, token), otherSession)).json();
    expect(foreign.result.isError).toBe(true);
    expect(JSON.stringify(foreign)).toContain("invalid, expired, or revoked");
    expect(otherJournal.read(operationDigest(token))).toBeUndefined();
    expect(Object.keys(journal.read<any>(operationDigest(token)).calls)).toHaveLength(0);
    const corrected = rpc(server.url, message(2, token), session);
    const [call] = await broker.nextToolBatch(token);
    expect(call!.arguments).toEqual({ cmd: "synthetic read" });
    broker.completeTool(token, call!.callId, { content: [{ type: "text", text:
      "Wall time: 0.001 seconds\nProcess exited with code 0\nOutput:\n43-binding-complete\n" }] });
    const completed = await (await corrected).json();
    expect(completed.result.isError).not.toBe(true);
    expect(JSON.stringify(completed)).toContain("43-binding-complete");
    expect(await (await rpc(server.url, message(2, token), session)).json()).toEqual(completed);
    expect(await (await rpc(server.url, message(1, wrongToken), session)).json()).toEqual(rejected);
    expect(Object.keys(journal.read<any>(operationDigest(token)).calls)).toHaveLength(1);
    expect((await status()).uncertain_requests).toBe(0);
    const retained = await status();
    expect(retained.durable_live_turns).toBe(1);
    expect(retained.durable_unknown_calls).toBe(0);
    expect(retained.durable_native_continuations).toBe(0);
    expect(retained.durable_active_mcp_requests).toBe(0);
    const revision = broker.beginCompletionFence(token);
    expect(revision).toBeDefined();
    expect(broker.commitCompletionFence(token, revision!)).toBe(true);
  } finally {
    await fetch(server.url, { method: "DELETE", headers: { "mcp-session-id": session,
      "MCP-Protocol-Version": "2025-11-25", accept: "application/json, text/event-stream" } });
    await fetch(otherServer.url, { method: "DELETE", headers: { "mcp-session-id": otherSession,
      "MCP-Protocol-Version": "2025-11-25", accept: "application/json, text/event-stream" } });
    const drained = await fetch(server.url.origin + "/admin/release/drain", { method: "POST",
      headers: { authorization: "Bearer 43-synthetic-control-key" } });
    const drainedStatus = await drained.json();
    expect(drainedStatus.durable_live_turns).toBe(0);
    expect(drainedStatus.durable_unknown_calls).toBe(0);
    expect(drainedStatus.durable_native_continuations).toBe(0);
    expect(drainedStatus.durable_active_mcp_requests).toBe(0);
    expect(drainedStatus.safe_to_stop).toBe(true);
    await server.close(); await otherServer.close();
    await broker.close(); await otherBroker.close();
    closeSync(fd); closeSync(otherFd); rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
