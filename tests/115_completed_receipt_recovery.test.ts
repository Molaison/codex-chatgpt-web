import { tmpdir } from "node:os";
// Real socket/HTTP abort and SDK dispatch; Native receipts below are synthetic, not E2E acceptance.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { TurnBroker, callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { OperationJournal, operationDigest } from "../src/adapters/chatgpt-web/operation-journal";

const terminal: BrokerToolResult = { content: [{ type: "text", text: "Wall time: 0.0001 seconds\nProcess exited with code 7\nOutput:\n1\n" }] };
const running: BrokerToolResult = { content: [{ type: "text", text: "Wall time: 0.0001 seconds\nProcess running with session ID 42\nOutput:\n" }] };

test("real public HTTP abort retains Native, verified result rebuilds once, both old page and recovery page cannot execute", async () => {
  mkdirSync((process.env.Q39_TEST_ROOT ?? tmpdir()), { recursive: true });
  const root = mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()), "115-http-"));
  const fd = openSync(root, "r"), socket = `/proc/${process.pid}/fd/${fd}/b.sock`;
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [
    { name: "exec_command", description: "synthetic", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
  ] });
  const key = join(root, "release.key"); writeFileSync(key, "115-isolated-test-only-release-key", { mode: 0o600 });
  const server = startChatGptMcpHttpServer({ brokerSocketPath: socket, port: 0,
    releaseControl: { tokenFile: key, stateFile: join(root, "fence.json") } });
  const rpc = (body: object, session?: string, signal?: AbortSignal) => fetch(server.url.origin + "/mcp", { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
    ...(session ? { "mcp-session-id": session } : {}),
  }, body: JSON.stringify(body), signal });
  const init = await rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "115", version: "1" } } });
  const session = init.headers.get("mcp-session-id")!; await init.text();
  const journal = new OperationJournal(root, "tool-operations");
  const record = () => journal.read<any>(operationDigest(token));
  try {
    const abort = new AbortController();
    const pending = rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_exec", arguments: { turn_token: token, cmd: "one effect" } } }, session, abort.signal).then(r => r.text()).catch(() => "aborted");
    const [call] = await broker.nextToolBatch(token);
    expect(broker.recoverCompletedReceipts(token, {})).toBeUndefined();
    abort.abort(); await pending;
    for (let i = 0; i < 100 && !record().calls[call!.callId].publicDeliveryLost; i++) await Bun.sleep(10);
    expect(record().calls[call!.callId].publicDeliveryLost).toBe(true);
    // No cancellation of the accepted native invocation despite disconnect.
    broker.completeTool(token, call!.callId, terminal);
    for (let i = 0; i < 100 && record().observationState.activeActivityRefs.length; i++) await Bun.sleep(10);
    expect(broker.recoverCompletedReceipts(token, { [call!.callId]: "wrong-hash" })).toBeUndefined();
    expect(broker.recoverCompletedReceipts(token, {})).toBeUndefined();
    const proof = { [call!.callId]: operationDigest(JSON.stringify(terminal)) };
    let recovery = broker.recoverCompletedReceipts(token, proof)!;
    expect(recovery).toBeDefined(); expect(recovery.receipts[0]!.result).toEqual(terminal);
    expect(recovery.receipts[0]!.resultHash).toBe(proof[call!.callId]);
    expect(recovery.token).not.toBe(token); expect(broker.recoverCompletedReceipts(token, proof)).toBeUndefined();
    // A second recoverable browser failure may rotate the read-only phase again;
    // ordinary polling must not repeatedly rotate just because old loss evidence remains.
    const firstRecoveryToken = recovery.token;
    recovery = broker.recoverCompletedReceipts(token, proof, true)!;
    expect(recovery.token).not.toBe(firstRecoveryToken);
    expect(recovery.receipts[0]!.result).toEqual(terminal);
    await expect(callTurnBroker(socket, { method: "claim", token: firstRecoveryToken })).rejects.toThrow();
    const activityId = "activity_115oldcapabilityabcde";
    await expect(callTurnBroker(socket, { method: "claim", token, activityId })).rejects.toThrow();
    const claimed = await callTurnBroker<any>(socket, { method: "claim", token: recovery.token, activityId });
    await expect(callTurnBroker(socket, { method: "invoke", bindingId: claimed.bindingId, invocationId: "new-identity", wireName: "exec_command", arguments: { cmd: "one effect" } })).rejects.toThrow("execution is closed");
    await callTurnBroker(socket, { method: "activity_complete", token: recovery.token, activityId });
    expect(Object.keys(record().calls)).toHaveLength(1);
  } finally {
    await fetch(server.url.origin + "/mcp", { method: "DELETE", headers: { "mcp-session-id": session, "MCP-Protocol-Version": "2025-11-25", accept: "application/json, text/event-stream" } });
    await fetch(server.url.origin + "/admin/release/drain", { method: "POST", headers: { authorization: "Bearer 115-isolated-test-only-release-key" } });
    broker.revoke(token);
    await server.close(); await broker.close(); closeSync(fd); rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("a proven running receipt stays read-only until owner resume; unrelated RPC is not loss evidence", async () => {
  const root = mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()), "115-gate-")), fd = openSync(root, "r"), socket = `/proc/${process.pid}/fd/${fd}/b.sock`;
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] });
  const activityId = "activity_115runningproofabcde";
  const claim = await callTurnBroker<any>(socket, { method: "claim", token, activityId });
  const rpcId = "scope:1";
  const { mcpInvocationId } = await import("../src/adapters/chatgpt-web/mcp-observation");
  const invocationId = mcpInvocationId(claim.bindingId, rpcId, "exec_command");
  const invoked = callTurnBroker(socket, { method: "invoke", bindingId: claim.bindingId, invocationId, wireName: "exec_command", arguments: { cmd: "running" } });
  try {
    const [call] = await broker.nextToolBatch(token);
    expect(await callTurnBroker<{ recorded: boolean }>(socket, { method: "public_delivery_lost", token, rpcId: "wrong", wireName: "exec_command" })).toEqual({ recorded: false });
    expect(await callTurnBroker<{ recorded: boolean }>(socket, { method: "public_delivery_lost", token, rpcId, wireName: "exec_command" })).toEqual({ recorded: true });
    broker.completeTool(token, call!.callId, running); await invoked;
    await callTurnBroker(socket, { method: "activity_complete", token, activityId });
    const proof = { [call!.callId]: operationDigest(JSON.stringify(running)) };
    const recovery=broker.recoverCompletedReceipts(token,proof)!;
    expect(recovery).toBeDefined();
    const fresh=await callTurnBroker<any>(socket,{method:"claim",token:recovery.token,activityId:"activity_115runningreadonly00"});
    await expect(callTurnBroker(socket,{method:"invoke",bindingId:fresh.bindingId,invocationId:"forbidden-before-owner-resume",wireName:"exec_command",arguments:{cmd:"must not execute"}})).rejects.toThrow("execution is closed");
    await callTurnBroker(socket,{method:"activity_complete",token:recovery.token,activityId:"activity_115runningreadonly00"});
  } finally { await broker.close(); closeSync(fd); rmSync(root, { recursive: true, force: true }); }
}, 10_000);
