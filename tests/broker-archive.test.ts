import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker, callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";

test("retired terminal tool receipts archive together and replay without another dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-archive-"));
  const socket = join(directory, "broker.sock");
  const broker = TurnBroker.forSocket(socket);
  const environment = { cwd: directory, roots: [directory], writableRoots: [directory],
    sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [directory], networkAccess: false },
    tools: [{ name: "exec_command", description: "fixture", parameters: { type: "object" } }] };
  try {
    const token = await broker.register(environment, undefined, "archive-original");
    const activityId = "activity_original_archive_fixture";
    const claim = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token, activityId });
    const request = { method: "invoke" as const, bindingId: claim.bindingId,
      invocationId: "original-invocation", wireName: "exec_command", arguments: { cmd: "fixture" } };
    const original = callTurnBroker<BrokerToolResult>(socket, request);
    const [call] = await broker.nextToolBatch(token);
    const result = { content: [], structuredContent: { exit_code: 0, output: "done once" } };
    broker.completeTool(token, call!.callId, result);
    expect(await original).toEqual(result);
    await callTurnBroker(socket, { method: "activity_complete", token, activityId });
    broker.revoke(token);
    expect(readdirSync(join(directory, "tool-operations")).filter(name => name.endsWith(".json"))).toHaveLength(0);
    expect(await callTurnBroker<BrokerToolResult>(socket, request)).toEqual(result);
    expect(await callTurnBroker(socket, { method: "read_tool_receipt", bindingId: claim.bindingId, callId: call!.callId }))
      .toMatchObject({ state: "completed", result, native_redispatch: false });
    expect(broker.releaseStatus()).toMatchObject({ durable_live_turns: 0, durable_unknown_calls: 0,
      durable_native_continuations: 0, durable_active_mcp_requests: 0, durable_inventory_errors: 0 });

    const unknownToken = await broker.register(environment, undefined, "archive-unknown");
    const unknownClaim = await callTurnBroker<{ bindingId: string }>(socket, {
      method: "claim", token: unknownToken, activityId: "activity_unknown_archive_fixture",
    });
    const unresolved = callTurnBroker(socket, { ...request, bindingId: unknownClaim.bindingId,
      invocationId: "unknown-invocation" }).catch(() => undefined);
    await broker.nextToolBatch(unknownToken);
    broker.revoke(unknownToken);
    await unresolved;
    expect(readdirSync(join(directory, "tool-operations")).filter(name => name.endsWith(".json"))).toHaveLength(2);
    expect(broker.releaseStatus().durable_unknown_calls).toBe(1);
  } finally {
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
