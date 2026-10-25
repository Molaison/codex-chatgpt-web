import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperationJournal, operationDigest } from "../src/adapters/chatgpt-web/operation-journal";
import { TurnBroker, callTurnBroker, TurnBrokerTimeoutError, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";

async function start(root: string, mode: string) {
  const { CODEX_SQLITE_HOME: _sqliteHome, ...env } = process.env;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "42_execution_fixture.ts"), root, mode], {
    env: { ...env, CODEX_HOME: join(root, "codex-home"), CODEX_CHATGPT_WEB_HOME: root }, stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader(); let output = "";
  while (!output.match(/READY (\d+)/)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(await new Response(child.stderr).text());
    output += new TextDecoder().decode(chunk.value);
  }
  void (async () => { while (!(await reader.read()).done) {} })();
  void new Response(child.stderr).text();
  return { child, url: `http://127.0.0.1:${output.match(/READY (\d+)/)![1]}` };
}
function rpc(root: string, request: object): Promise<any> {
  return new Promise(resolve => {
    let buffer = "", settled = false;
    const finish = (value: any) => { if (!settled) { settled = true; resolve(value); } };
    const socket = createConnection(join(root, "broker.sock"), () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", data => { buffer += data; if (buffer.includes("\n")) { finish(JSON.parse(buffer.split("\n")[0]!)); socket.end(); } });
    socket.on("error", error => finish({ transport: error.message }));
    socket.on("close", () => finish({ transport: "closed" }));
  });
}
const post = (url: string, body: object) => fetch(url, { method: "POST", body: JSON.stringify(body) });
async function waitForCall(root: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    for (const name of readdirSync(join(root, "tool-operations"))) {
      if (!name.endsWith(".json")) continue;
      const value = JSON.parse(JSON.parse(readFileSync(join(root, "tool-operations", name), "utf8")).payload);
      if (Object.keys(value.calls ?? {}).length) return;
    }
    await Bun.sleep(10);
  }
  throw new Error("tool never reached proposed checkpoint");
}
for (const point of ["tool-proposed", "tool-dispatched", "tool-completed"] as const) {
  test(`broker SIGKILL at ${point}: unknown retained, completed result and native handle recover without dispatch`, async () => {
    const root = mkdtempSync(join(tmpdir(), "journal42-"));
    let runtime = await start(root, point);
    try {
      const binding = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
      const invocation = { id: "request_logical_42", method: "invoke", bindingId: binding.bindingId,
        invocationId: "mcp-logical-42",
        wireName: "exec_command", arguments: { cmd: "synthetic command" } };
      const pending = rpc(root, invocation);
      await waitForCall(root);
      if (point === "tool-proposed") runtime.child.kill("SIGKILL");
      else {
        await post(runtime.url, { action: "next", token: binding.token }).then(res => res.text()).catch(() => {});
        if (point === "tool-completed") {
          const call = JSON.parse(readFileSync(join(root, "call.json"), "utf8"));
          await post(runtime.url, { action: "complete", token: binding.token, callId: call.callId,
            result: { content: [], structuredContent: { session_id: "native_handle_42", output: "done" } } }).catch(() => {});
        }
      }
      await runtime.child.exited; await pending;
      expect(runtime.child.signalCode).toBe("SIGKILL");
      runtime = await start(root, "tool-recover");
      const replay = await rpc(root, { ...invocation, id: "reconnected-transport-42" });
      if (point === "tool-completed") {
        expect(replay.result.structuredContent).toEqual({ session_id: "native_handle_42", output: "done" });
        const call = JSON.parse(readFileSync(join(root, "call.json"), "utf8"));
        const ack = await rpc(root, { id: "ack_replay_42", method: "owner_complete", token: binding.token,
          callId: call.callId, toolResult: replay.result });
        expect(ack.result.completed).toBe(true);
        const conflict = await rpc(root, { id: "ack_conflict", method: "owner_complete", token: binding.token,
          callId: call.callId, toolResult: { content: [{ text: "different" }] } });
        expect(conflict.error).toContain("retained");
      } else expect(replay.error).toContain("retained");
      const freshRpc = await rpc(root, { ...invocation, id: "new-transport", invocationId: "new-mcp-request" });
      expect(freshRpc.error).toContain("retained");
      expect(freshRpc.error).toContain("fixture-tool-trace");
      const count = existsSync(join(root, "dispatches")) ? readFileSync(join(root, "dispatches"), "utf8").trim().split("\n").length : 0;
      expect(count).toBe(point === "tool-proposed" ? 0 : 1);
      console.log("EXECUTION42_TOOL_CRASH", JSON.stringify({ point, dispatches: count,
        recovered: point === "tool-completed" ? "completed+native_handle+ACK" : "retained" }));
    } finally { runtime.child.kill(); await runtime.child.exited; rmSync(root, { recursive: true, force: true }); }
  }, 20000);
}

test("broker live duplicate invoke and lost ACK use same call, distinct intent is not text-deduplicated", async () => {
  const root = mkdtempSync(join(tmpdir(), "journal42-live-"));
  const runtime = await start(root, "tool-live");
  try {
    const binding = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    const invoke = { id: "logical1", method: "invoke", bindingId: binding.bindingId, wireName: "exec_command", arguments: { cmd: "same" } };
    const first = rpc(root, invoke), duplicate = rpc(root, invoke);
    const calls = await (await post(runtime.url, { action: "next", token: binding.token })).json() as any[];
    expect(calls).toHaveLength(1);
    const result = { content: [], structuredContent: { session_id: "h42" } };
    await post(runtime.url, { action: "complete", token: binding.token, callId: calls[0].callId, result });
    expect((await first).result).toEqual(result); expect((await duplicate).result).toEqual(result);
    expect((await rpc(root, invoke)).result).toEqual(result);
    const second = rpc(root, { ...invoke, id: "logical2" });
    const next = await (await post(runtime.url, { action: "next", token: binding.token })).json() as any[];
    expect(next[0].callId).not.toBe(calls[0].callId);
    await post(runtime.url, { action: "complete", token: binding.token, callId: next[0].callId, result });
    await second;
  } finally { runtime.child.kill(); await runtime.child.exited; rmSync(root, { recursive: true, force: true }); }
}, 20000);

async function localBroker() {
  const root = mkdtempSync(join(tmpdir(), "journal42-fence-"));
  const socket = join(root, "broker.sock"), broker = TurnBroker.forSocket(socket);
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, undefined, "original-turn-42");
  const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
  return { root, socket, broker, token, bindingId,
    async close() { await broker.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("stable invocationId survives new transport ids, canonical objects, and rejects conflicting signatures", async () => {
  const owner = await localBroker();
  try {
    const request = { method: "invoke" as const, bindingId: owner.bindingId, invocationId: "logical-mcp-42",
      wireName: "exec_command", arguments: { cmd: "same", options: { a: 1, b: 2 } } };
    const first = callTurnBroker<BrokerToolResult>(owner.socket, request);
    const duplicate = callTurnBroker<BrokerToolResult>(owner.socket, { ...request,
      arguments: { options: { b: 2, a: 1 }, cmd: "same" } });
    const [call] = await owner.broker.nextToolBatch(owner.token);
    expect(call).toBeDefined();
    await expect(callTurnBroker(owner.socket, { ...request, arguments: { cmd: "different" } }))
      .rejects.toThrow("identity conflicts");
    const result = { content: [], structuredContent: { session_id: 42 } };
    owner.broker.completeTool(owner.token, call!.callId, result);
    expect(await first).toEqual(result); expect(await duplicate).toEqual(result);
    expect(await callTurnBroker<BrokerToolResult>(owner.socket, request)).toEqual(result);
    const newIntent = callTurnBroker(owner.socket, { ...request, invocationId: "explicit-new-mcp-42" });
    const [second] = await owner.broker.nextToolBatch(owner.token);
    expect(second!.callId).not.toBe(call!.callId);
    owner.broker.completeTool(owner.token, second!.callId, result);
    await newIntent;
  } finally { await owner.close(); }
});

test("MCP timeout fences a fresh RPC side effect, permits known-handle empty poll and same receipt query", async () => {
  const owner = await localBroker();
  try {
    const invoke = (invocationId: string, wireName: string, args: Record<string, unknown>, timeout = 5000) =>
      callTurnBroker<BrokerToolResult>(owner.socket, { method: "invoke", bindingId: owner.bindingId,
        invocationId, wireName, arguments: args }, timeout);
    const seeded = invoke("handle-source", "exec_command", { cmd: "synthetic native handle" });
    const [seed] = await owner.broker.nextToolBatch(owner.token);
    const handleResult = { content: [], structuredContent: { session_id: 42, output: "running" } };
    owner.broker.completeTool(owner.token, seed!.callId, handleResult);
    await seeded;

    const timed = invoke("original-side-effect", "exec_command", { cmd: "synthetic unknown effect" }, 120).catch(error => error);
    const [original] = await owner.broker.nextToolBatch(owner.token);
    expect(await timed).toBeInstanceOf(TurnBrokerTimeoutError);
    const journal = new OperationJournal(owner.root, "tool-operations");
    let fenced = false;
    for (let i = 0; i < 100; i++) {
      const channel = journal.read<any>(operationDigest(owner.token));
      if (channel.calls[original!.callId].observerLost) { fenced = true; break; }
      await Bun.sleep(5);
    }
    expect(fenced).toBe(true);
    await expect(invoke("fresh-rpc-id", "exec_command", { cmd: "synthetic unknown effect" })).rejects.toThrow("unknown outcome");
    await expect(owner.broker.nextToolBatch(owner.token)).rejects.toThrow("retained");
    for (const args of [{ session_id: 42, chars: "y\n" }, { session_id: 42, chars: "\u0003" },
      { session_id: 999, chars: "" }]) {
      await expect(invoke(`unsafe-poll-${JSON.stringify(args)}`, "write_stdin", args)).rejects.toThrow("retained");
    }
    expect(await invoke("handle-source", "exec_command", { cmd: "synthetic native handle" })).toEqual(handleResult);

    const poll = invoke("known-handle-empty-poll", "write_stdin", { session_id: 42, chars: "", yield_time_ms: 30000 });
    // A retained native call is not re-exposed while the independent read-only poll is queued.
    for (let i = 0; i < 100; i++) {
      const channel = journal.read<any>(operationDigest(owner.token));
      if (Object.keys(channel.calls).length === 3) break;
      await Bun.sleep(5);
    }
    const [safe] = await owner.broker.nextToolBatch(owner.token);
    expect(safe!.wireName).toBe("write_stdin"); expect(safe!.callId).not.toBe(original!.callId);
    owner.broker.completeTool(owner.token, safe!.callId, handleResult);
    await poll;
    owner.broker.completeTool(owner.token, original!.callId, { content: [], structuredContent: { output: "reconciled" } });
    expect(await invoke("original-side-effect", "exec_command", { cmd: "synthetic unknown effect" }))
      .toEqual({ content: [], structuredContent: { output: "reconciled" } });
    console.log("EXECUTION42_UNKNOWN_FENCE", JSON.stringify({ nativeCalls: 3, originalSideEffects: 1,
      freshRpcBlocked: true, nonemptyStdinBlocked: true, unknownHandleBlocked: true,
      knownHandleEmptyPoll: true, sameReceiptQuery: true, originalTurn: "original-turn-42" }));
  } finally { await owner.close(); }
}, 20000);

test("TTL retires native ownership without erasing unknown or accepted result receipts", async () => {
  const owner = await localBroker();
  try {
    const token = await owner.broker.register({ cwd: owner.root, roots: [owner.root], writableRoots: [owner.root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, 400, "ttl-original-turn");
    const { bindingId, environment } = await callTurnBroker<{ bindingId: string; environment: { expiresAt: number } }>(owner.socket, { method: "claim", token });
    const acceptedRequest = { method: "invoke" as const, bindingId, invocationId: "ttl-accepted",
      wireName: "exec_command", arguments: { cmd: "known receipt" } };
    const accepted = callTurnBroker(owner.socket, acceptedRequest);
    const [completed] = await owner.broker.nextToolBatch(token);
    owner.broker.completeTool(token, completed!.callId, { content: [], structuredContent: { session_id: 42 } });
    await accepted;
    const pending = callTurnBroker(owner.socket, { method: "invoke", bindingId,
      invocationId: "ttl-unknown", wireName: "exec_command", arguments: { cmd: "synthetic" } }).catch(error => error);
    await owner.broker.nextToolBatch(token);
    await Bun.sleep(Math.max(0, environment.expiresAt - Date.now() + 10));
    await expect(callTurnBroker(owner.socket, { method: "invoke", bindingId,
      invocationId: "fresh-after-ttl", wireName: "exec_command", arguments: { cmd: "synthetic" } }))
      .rejects.toThrow("ttl-original-turn");
    await pending;
    expect(await callTurnBroker<BrokerToolResult>(owner.socket, acceptedRequest)).toEqual({ content: [], structuredContent: { session_id: 42 } });
    expect(readdirSync(join(owner.root, "tool-operations")).filter(name => name.endsWith(".json")).length).toBe(4);
  } finally { await owner.close(); }
});

test("timeout then late native completion stays fenced until the original receipt is queried, not merely completed", async () => {
  const owner = await localBroker();
  try {
    const request = { method: "invoke" as const, bindingId: owner.bindingId,
      invocationId: "timeout-before-late-result", wireName: "exec_command", arguments: { cmd: "synthetic one-time effect" } };
    const timed = callTurnBroker(owner.socket, request, 100).catch(error => error);
    const [original] = await owner.broker.nextToolBatch(owner.token);
    expect(await timed).toBeInstanceOf(TurnBrokerTimeoutError);
    const journal = new OperationJournal(owner.root, "tool-operations");
    for (let i = 0; i < 100; i++) {
      if (journal.read<any>(operationDigest(owner.token)).calls[original!.callId].observerLost) break;
      await Bun.sleep(5);
    }
    const result = { content: [], structuredContent: { session_id: 42, output: "native effect completed" } };
    owner.broker.completeTool(owner.token, original!.callId, result);
    owner.broker.completeTool(owner.token, original!.callId, result); // Native ACK is not observer delivery.
    const beforeQuery = journal.read<any>(operationDigest(owner.token)).calls[original!.callId];
    expect(beforeQuery.state).toBe("completed"); expect(beforeQuery.observerLost).toBe(true);
    expect(beforeQuery.delivery).toBe("unknown"); expect(beforeQuery.reconciliation).toBeUndefined();
    const fresh = { ...request, invocationId: "automatic-fresh-rpc-after-late-result" };
    await expect(callTurnBroker(owner.socket, fresh)).rejects.toThrow("unknown outcome");
    await expect(owner.broker.nextToolBatch(owner.token)).rejects.toThrow("retained");
    expect(Object.keys(journal.read<any>(operationDigest(owner.token)).calls)).toHaveLength(1);
    expect(await callTurnBroker<BrokerToolResult>(owner.socket, request)).toEqual(result);
    const afterQuery = journal.read<any>(operationDigest(owner.token)).calls[original!.callId];
    expect(afterQuery.reconciliation).toBe("receipt_query"); expect(afterQuery.delivery).toBe("unknown");
    // A genuinely new intent is legal after reconciliation, even with identical arguments.
    const nextIntent = callTurnBroker(owner.socket, { ...request, invocationId: "explicit-new-intent-after-query" });
    const [next] = await owner.broker.nextToolBatch(owner.token);
    expect(next!.callId).not.toBe(original!.callId);
    owner.broker.completeTool(owner.token, next!.callId, result); await nextIntent;
    console.log("EXECUTION42_LATE_RESULT_FENCE", JSON.stringify({ sequence: ["rpc_timeout", "native_completed", "native_ack_replay",
      "fresh_rpc_blocked", "same_receipt_query", "new_intent_allowed"], sideEffectsBeforeQuery: 1,
      nativeCompletedIsNotDelivered: true, delivery: "unknown", reconciliation: afterQuery.reconciliation }));
  } finally { await owner.close(); }
}, 10000);

test("public broker lifecycle correlates private call receipts without logging call capabilities or content", async () => {
  const originalInfo = console.info, logs: string[] = [];
  console.info = (...values) => { logs.push(values.map(String).join(" ")); };
  let owner: Awaited<ReturnType<typeof localBroker>> | undefined;
  try {
    owner = await localBroker();
    const running = callTurnBroker(owner.socket, { method: "invoke", bindingId: owner.bindingId,
      invocationId: "private-log-42", wireName: "exec_command", arguments: { cmd: "PRIVATE_COMMAND_BODY" } });
    const [call] = await owner.broker.nextToolBatch(owner.token);
    owner.broker.completeTool(owner.token, call!.callId, { content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }] });
    await running;
    const events = logs.filter(line => line.startsWith("[chatgpt-web] broker_lifecycle "))
      .map(line => JSON.parse(line.slice(line.indexOf("{")))).filter(event => event.callRef);
    expect(events.map(event => event.event)).toEqual(["queued", "delivered", "toolCompleted"]);
    expect(events.every(event => event.callRef === operationDigest(call!.callId).slice(0, 12))).toBe(true);
    for (const privateValue of [owner.token, owner.bindingId, call!.callId, "PRIVATE_COMMAND_BODY", "PRIVATE_TOOL_OUTPUT"]) {
      expect(logs.join("\n")).not.toContain(privateValue);
    }
  } finally { await owner?.close(); console.info = originalInfo; }
});

test("checkpoint bounds and invalid content fail closed instead of evicting uncertain identities", () => {
  const root = mkdtempSync(join(tmpdir(), "journal42-bounds-"));
  try {
    const store = new OperationJournal(root);
    store.write("retained", { state: "unknown" });
    expect(() => store.write("retained", { payload: "x".repeat(16 * 1024 * 1024) })).toThrow("16 MiB");
    expect(store.read<{ state: string }>("retained")).toEqual({ state: "unknown" });
    writeFileSync(store.path("retained"), '{"version":1,"payload":"{}","digest":"bad"}');
    expect(() => store.read("retained")).toThrow("corrupt");
    writeFileSync(store.path("retained"), 'PRIVATE_HTML_COOKIE_EMAIL_DO_NOT_LOG {"version":');
    try { store.read("retained"); throw new Error("corrupt input unexpectedly accepted"); }
    catch (error) {
      expect((error as Error).message).toContain("corrupt");
      expect(String(error)).not.toContain("PRIVATE_HTML_COOKIE_EMAIL_DO_NOT_LOG");
    }
    // A real write failure at the private store boundary cannot create a committed record.
    const blocked = join(root, "blocked"); writeFileSync(blocked, "not a directory");
    expect(() => new OperationJournal(blocked).write("never-sent", {})).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual Responses stream batches 1024 updates rather than fsync per token", async () => {
  const root = mkdtempSync(join(tmpdir(), "journal42-metrics-"));
  const runtime = await start(root, "measure");
  try {
    const response = await post(runtime.url + "/v1/responses", { model: "chatgpt-web/high", stream: true,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "metrics-thread", turn_id: "metrics-turn" }) },
      input: [{ type: "message", role: "user", id: "metrics-user", content: "synthetic measurement" }] });
    expect(await response.text()).toContain("response.completed");
    const metrics = JSON.parse(readFileSync(join(root, "metrics.json"), "utf8"));
    const diskBytes = readdirSync(join(root, "operations")).filter(name => name.endsWith(".json"))
      .reduce((sum, name) => sum + statSync(join(root, "operations", name)).size, 0);
    expect(metrics.writes).toBeLessThan(100);
    console.log("EXECUTION42_STORAGE", JSON.stringify({ updates: 1024, outputBytes: 256 * 1024,
      ...metrics, diskBytes, writeAmplification: metrics.bytes / (256 * 1024) }));
  } finally { runtime.child.kill(); await runtime.child.exited; rmSync(root, { recursive: true, force: true }); }
}, 20000);

test("full checkpoint capacity blocks new operations but still accepts the original result", () => {
  const root = mkdtempSync(join(tmpdir(), "journal42-capacity-"));
  try {
    const store = new OperationJournal(root);
    store.write("original-unknown", { state: "unknown" });
    const payload = "{}", envelope = JSON.stringify({ version: 1, digest: operationDigest(payload), payload });
    for (let i = 0; i < 4095; i++) writeFileSync(store.path(`completed-fixture-${i}`), envelope, { mode: 0o600 });
    expect(() => store.write("new-intent", {})).toThrow("capacity exhausted");
    expect(existsSync(store.path("new-intent"))).toBe(false);
    store.write("original-unknown", { state: "completed", handle: 42 });
    expect(store.read<{ state: string; handle: number }>("original-unknown")).toEqual({ state: "completed", handle: 42 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
