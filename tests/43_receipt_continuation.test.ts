// Isolated broker/socket contract; Native results are synthetic, not real Codex/Web E2E.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TurnBroker, callTurnBroker, type BrokerToolResult, type BrokerToolRequest } from "../src/adapters/chatgpt-web/turn-broker";
import { operationDigest, OperationJournal } from "../src/adapters/chatgpt-web/operation-journal";
import { mcpInvocationId } from "../src/adapters/chatgpt-web/mcp-observation";
import type { CodexTool } from "../src/types";

const terminal = (exit = 0): BrokerToolResult => ({ content: [{ type: "text", text: `Wall time: 0.001 seconds\nProcess exited with code ${exit}\nOutput:\nA\n` }] });
const running = (id = 42): BrokerToolResult => ({ content: [{ type: "text", text: `Wall time: 0.001 seconds\nProcess running with session ID ${id}\nOutput:\n` }] });
const tools = ["exec_command", "write_stdin", "custom_sync", "apply_patch"].map(name => ({ name, description: "isolated contract fixture", parameters: { type: "object" }, ...(name === "apply_patch" ? { freeform: true } : {}) }));
async function setup(ttl?: number, extraTools: CodexTool[] = []) {
  mkdirSync(process.env.Q39_TEST_ROOT!, { recursive: true });
  const root = mkdtempSync(join(process.env.Q39_TEST_ROOT!, "43-receipts-"));
  const fd = openSync(root, "r"), socket = `/proc/${process.pid}/fd/${fd}/b.sock`;
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  const environment = { cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [root], networkAccess: false }, tools: [...tools, ...extraTools] };
  const token = await broker.register(environment, ttl);
  const proof: Record<string, string> = {};
  let sequence = 0;
  const rpc = <T = any>(request: object) => callTurnBroker<T>(socket, request as any, 5000);
  const claim = (ingress = token) => rpc({ method: "claim", token: ingress, activityId: `activity_recoverytest${String(++sequence).padStart(8, "0")}` });
  const done = (claimed: any, ingress = token) => rpc({ method: "activity_complete", token: ingress, activityId: claimed.activityId });
  const original = await claim();
  async function dispatch(claimed: any, payload: Partial<BrokerToolRequest>, result: BrokerToolResult, loss = false, ingress = token) {
    const rpcId = `request-${++sequence}`;
    const request = { method: "invoke", bindingId: claimed.bindingId, invocationId: mcpInvocationId(claimed.bindingId, rpcId, payload.wireName!), ...payload };
    const response = rpc<BrokerToolResult>(request);
    // Race with rejection so a failed admission cannot strand the test on owner_next.
    const abort = new AbortController();
    let batch: BrokerToolRequest[];
    try { batch = await Promise.race([broker.nextToolBatch(token, abort.signal), response.then(() => { throw new Error("unexpected receipt replay"); })]); }
    finally { abort.abort(); }
    const [call] = batch!;
    if (loss) expect(await rpc<{recorded:boolean}>({ method: "public_delivery_lost", token: ingress, rpcId, wireName: payload.wireName })).toEqual({ recorded: true });
    broker.completeTool(token, call!.callId, result);
    expect(await response).toEqual(result);
    proof[call!.callId] = operationDigest(JSON.stringify(result));
    return { request, call: call! };
  }
  return { root, broker, token, proof, rpc, claim, done, original, environment, dispatch,
    record: () => new OperationJournal(root, "tool-operations").read<any>(operationDigest(token)),
    close: async () => { await broker.close(); closeSync(fd); rmSync(root, { recursive: true, force: true }); } };
}

test("UX02: all accepted receipts permit B on fresh capability, never replay A", async () => {
  const f = await setup();
  try {
    const a = await f.dispatch(f.original, { wireName: "exec_command", arguments: { cmd: "append A" } }, terminal(7), true);
    await f.done(f.original);
    const recovery = f.broker.recoverCompletedReceipts(f.token, f.proof)!;
    expect(recovery).toBeDefined();
    expect(f.broker.resumeAfterReceiptRecovery(f.token, recovery.token, f.proof)).toBe(true);
    const fresh = await f.claim(recovery.token);
    const b = await f.dispatch(fresh, { wireName: "exec_command", arguments: { cmd: "append B" } }, terminal(), false, recovery.token);
    expect(b.call.callId).not.toBe(a.call.callId);
    expect(f.record().calls[a.call.callId].result).toEqual(terminal(7));
    await f.done(fresh, recovery.token);
  } finally { await f.close(); }
}, 5000);

async function recover(f: Awaited<ReturnType<typeof setup>>) {
  await f.done(f.original);
  const recovery = f.broker.recoverCompletedReceipts(f.token, f.proof)!;
  expect(recovery).toBeDefined();
  expect(await f.rpc<{resumed:boolean}>({ method: "owner_receipt_resume", token: f.token, recoveryToken: recovery.token, acceptedResults: f.proof })).toEqual({ resumed: true });
  return { recovery, fresh: await f.claim(recovery.token) };
}
const action = (bindingId: string, wireName: string, args: object, id = "new-step") => ({ method: "invoke", bindingId, invocationId: id, wireName, arguments: args });

test("old page/token/binding are fenced; exact invocation query works; owner proof is mandatory", async () => {
  const f = await setup();
  try {
    const a = await f.dispatch(f.original, { wireName: "exec_command", arguments: { cmd: "A" } }, terminal(), true);
    await f.done(f.original);
    expect(f.broker.recoverCompletedReceipts(f.token, {})).toBeUndefined();
    expect(f.broker.recoverCompletedReceipts(f.token, { [a.call.callId]: "incorrect" })).toBeUndefined();
    const recovery = f.broker.recoverCompletedReceipts(f.token, f.proof)!;
    await expect(f.claim()).rejects.toThrow();
    await expect(f.rpc(action(f.original.bindingId, "exec_command", { cmd: "B" }))).rejects.toThrow("already finished");
    const fresh = await f.claim(recovery.token);
    expect(fresh.bindingId).not.toBe(f.original.bindingId);
    await expect(f.rpc(action(fresh.bindingId, "exec_command", { cmd: "B" }))).rejects.toThrow("execution is closed");
    await f.done(fresh, recovery.token);
    expect(f.broker.resumeAfterReceiptRecovery(f.token, recovery.token, {})).toBe(false);
    expect(f.broker.resumeAfterReceiptRecovery(f.token, f.token, f.proof)).toBe(false);
    expect(f.broker.resumeAfterReceiptRecovery(f.token, recovery.token, f.proof)).toBe(true);
    expect(await f.rpc<BrokerToolResult>(a.request)).toEqual(terminal());
    const receipt = await f.rpc({ ...a.request, method: "owner_invocation_receipt" });
    expect(receipt.resultHash).toBe(f.proof[a.call.callId]);
    expect(receipt.state).toBe("completed");
    await expect(f.rpc(action(fresh.bindingId, "exec_command", { cmd: "A", yield_time_ms: 1000 }))).rejects.toThrow("already accepted");
    expect(Object.keys(f.record().calls)).toHaveLength(1);
  } finally { await f.close(); }
});

test("mixed completed/running/nonzero/custom/freeform: preserve results, first empty poll, stdin once, then EOF", async () => {
  const f = await setup();
  try {
    await f.dispatch(f.original, { wireName: "exec_command", arguments: { cmd: "start interactive" } }, running());
    const stdin = await f.dispatch(f.original, { wireName: "write_stdin", arguments: { session_id: 42, chars: "one line\n" } }, running(), true);
    const failed = await f.dispatch(f.original, { wireName: "exec_command", arguments: { cmd: "exit 7" } }, terminal(7));
    const custom = await f.dispatch(f.original, { wireName: "custom_sync", arguments: { mark: "A" } }, { content: [{ type: "text", text: "custom accepted" }] });
    const patch = await f.dispatch(f.original, { wireName: "apply_patch", freeform: true, input: "*** Begin Patch\nfixture\n*** End Patch" }, { content: [{ type: "text", text: "Success. Updated the following files: fixture" }] });
    const { recovery, fresh } = await recover(f);
    expect(recovery.receipts.map(r => r.request.callId)).toContain(stdin.call.callId);
    expect(recovery.receipts.find(r => r.request.callId === failed.call.callId)!.result).toEqual(terminal(7));
    await expect(f.rpc({ ...patch.request, bindingId: fresh.bindingId, invocationId: "patch-again" })).rejects.toThrow("already accepted");
    await expect(f.rpc({ ...custom.request, bindingId: fresh.bindingId, invocationId: "custom-again" })).rejects.toThrow("already accepted");
    await expect(f.rpc(action(fresh.bindingId, "write_stdin", { session_id: 42, chars: "one line\n", max_output_tokens: 100 }))).rejects.toThrow("already accepted");
    await expect(f.rpc(action(fresh.bindingId, "write_stdin", { session_id: 42, chars: "\u0004" }))).rejects.toThrow("short empty poll");
    await f.dispatch(fresh, { wireName: "write_stdin", arguments: { session_id: 42, chars: "", yield_time_ms: 1000 } }, running(), false, recovery.token);
    await f.dispatch(fresh, { wireName: "write_stdin", arguments: { session_id: 42, chars: "\u0004" } }, terminal(7), false, recovery.token);
    await expect(f.rpc(action(fresh.bindingId, "write_stdin", { session_id: 42, chars: "" }))).rejects.toThrow("already terminal");
    await f.dispatch(fresh, { wireName: "custom_sync", arguments: { mark: "B" } }, { content: [{ type: "text", text: "B accepted" }] }, false, recovery.token);
    await f.done(fresh, recovery.token);
    expect(Object.keys(f.record().calls)).toHaveLength(8);
    expect(f.record().calls[stdin.call.callId].result).toEqual(running());
  } finally { await f.close(); }
}, 10_000);

test("current tool permissions and TTL are checked again, not renewed by recovery", async () => {
  const f = await setup(1500);
  try {
    await f.dispatch(f.original, { wireName: "exec_command", arguments: { cmd: "A" } }, terminal(), true);
    const { recovery, fresh } = await recover(f);
    await expect(f.rpc(action(fresh.bindingId, "unlisted_tool", {}))).rejects.toThrow("not authorized");
    f.broker.updateEnvironment(f.token, { ...f.environment, tools: [] });
    await expect(f.rpc(action(fresh.bindingId, "exec_command", { cmd: "B" }))).rejects.toThrow("current permissions");
    await f.done(fresh, recovery.token);
    expect(f.broker.resumeAfterReceiptRecovery(f.token, recovery.token, f.proof)).toBe(false);
    const before = f.record();
    await Bun.sleep(Math.max(0, before.expiresAt - Date.now()) + 10);
    expect(f.broker.resumeAfterReceiptRecovery(f.token, recovery.token, f.proof)).toBe(false);
    await expect(f.claim(recovery.token)).rejects.toThrow();
    expect(f.record().expiresAt).toBe(before.expiresAt);
    expect(Object.keys(f.record().calls)).toHaveLength(1);
  } finally { await f.close(); }
}, 5000);

test("unknown dispatch survives disconnect and broker restart; no migration or fresh side effect", async () => {
  const f = await setup();
  try {
    await f.dispatch(f.original, { wireName: "exec_command", arguments: { cmd: "known" } }, terminal(), true);
    const abort = new AbortController();
    const unknown = { ...action(f.original.bindingId, "exec_command", { cmd: "unknown" }, "unknown-identity") };
    const pending = callTurnBroker((f.broker as any).socketPath, unknown as any, 1000, abort.signal).catch(() => undefined);
    const [call] = await f.broker.nextToolBatch(f.token);
    abort.abort(); await pending;
    for (let i = 0; i < 100 && !f.record().calls[call!.callId].observerLost; i++) await Bun.sleep(5);
    await f.done(f.original);
    const before = f.record().calls[call!.callId];
    expect(before.state).toBe("unknown"); expect(before.observerLost).toBe(true);
    expect(f.broker.recoverCompletedReceipts(f.token, f.proof)).toBeUndefined();
    await expect(f.rpc(action(f.original.bindingId, "exec_command", { cmd: "B" }))).rejects.toThrow("unknown outcome");
    expect((await f.rpc({ ...unknown, method: "owner_invocation_receipt" })).state).toBe("unknown");
    expect(f.record().calls[call!.callId]).toEqual(before);
    const socket = (f.broker as any).socketPath;
    await f.broker.close();
    const restarted = TurnBroker.forSocket(socket); await restarted.listen();
    try {
      expect((await f.rpc({ ...unknown, method: "owner_invocation_receipt" })).state).toBe("unknown");
      await expect(f.rpc(unknown)).rejects.toThrow("unknown outcome");
      expect(f.record().calls[call!.callId]).toEqual(before);
    } finally { await restarted.close(); }
  } finally { await f.close(); }
}, 5000);

test("new explicit user intent can run the same command; repeat recovery includes B exactly once", async () => {
  const f = await setup();
  try {
    await f.dispatch(f.original, { wireName: "exec_command", arguments: { cmd: "same command" } }, terminal(), true);
    const { recovery, fresh } = await recover(f);
    const b = await f.dispatch(fresh, { wireName: "exec_command", arguments: { cmd: "B" } }, terminal(), true, recovery.token);
    await f.done(fresh, recovery.token);
    const again = f.broker.recoverCompletedReceipts(f.token, f.proof)!;
    expect(again.token).not.toBe(recovery.token);
    expect(again.receipts).toHaveLength(2);
    expect(again.receipts[1]!.request.callId).toBe(b.call.callId);
    await expect(f.claim(recovery.token)).rejects.toThrow();
    expect(f.broker.recoverCompletedReceipts(f.token, f.proof)).toBeUndefined();
    const newToken = await f.broker.register(f.environment);
    const next = await f.claim(newToken);
    const promise = f.rpc(action(next.bindingId, "exec_command", { cmd: "same command" }));
    const [call] = await f.broker.nextToolBatch(newToken);
    expect(call!.arguments).toEqual({ cmd: "same command" });
    f.broker.completeTool(newToken, call!.callId, terminal());
    expect(await promise).toEqual(terminal());
    await f.done(next, newToken);
  } finally { await f.close(); }
}, 5000);

test("late running cannot revive terminal session or overwrite its accepted result", async () => {
  const f = await setup();
  try {
    await f.dispatch(f.original, { wireName: "exec_command", arguments: { cmd: "start" } }, running(), true);
    const { recovery, fresh } = await recover(f);
    const firstPromise = f.rpc(action(fresh.bindingId, "write_stdin", { session_id: 42, chars: "" }, "late-poll"));
    const secondPromise = f.rpc(action(fresh.bindingId, "write_stdin", { session_id: 42, chars: "" }, "terminal-poll"));
    for (let i = 0; i < 100 && Object.keys(f.record().calls).length < 3; i++) await Bun.sleep(5);
    const batch = await f.broker.nextToolBatch(f.token);
    expect(batch).toHaveLength(2);
    const [first, second] = batch;
    f.broker.completeTool(f.token, second!.callId, terminal());
    f.broker.completeTool(f.token, first!.callId, running());
    await Promise.all([firstPromise, secondPromise]);
    expect(() => f.broker.completeTool(f.token, second!.callId, running())).toThrow("conflicts");
    await expect(f.rpc(action(fresh.bindingId, "write_stdin", { session_id: 42, chars: "" }))).rejects.toThrow("terminal");
    await f.done(fresh, recovery.token);
  } finally { await f.close(); }
}, 5000);

for (const name of ["exec", "wait"]) test(`a namespaced ${name} result cannot prove nested work has settled`, async () => {
  const f = await setup(undefined, [{ namespace: "functions", name, description: "Native code execution with an independent cell lifetime", parameters: { type: "object" } }]);
  try {
    const result: BrokerToolResult = { content: [{ type: "text", text: "Script running with cell ID 42" }] };
    const action = await f.dispatch(f.original, { wireName: `functions__${name}`, arguments: { cell_id: "42" } }, result, true);
    await f.done(f.original);
    expect(!!f.broker.recoverCompletedReceipts(f.token, f.proof)).toBe(false);
    expect(f.record().calls[action.call.callId].result).toEqual(result);
    expect(Object.keys(f.record().calls)).toHaveLength(1);
  } finally { await f.close(); }
});
