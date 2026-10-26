import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAdmissionBook } from "../src/adapters/chatgpt-web/mcp-admission";
import { nativeExecutionReceipt } from "../src/adapters/chatgpt-web/native-terminal-receipt";
import { TurnBroker, callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { OperationJournal, operationDigest } from "../src/adapters/chatgpt-web/operation-journal";

const text = (state: string, output = ""): BrokerToolResult => ({ content: [{ type: "text", text:
  `Chunk ID: 123abc\nWall time: 1.0010 seconds\n${state}\nOutput:\n${output}` }] });
const running = text("Process running with session ID 42", "started\n");
const terminal = text("Process exited with code 1", "command failed normally\n");
const message = (id: number, name = "codex_exec", args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call",
  params: { name, arguments: { turn_token: "own-turn", ...args } } });
const response = (id: number, result: BrokerToolResult) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }),
  { headers: { "content-type": "application/json" } });

test("installed native running/optional headers and nonzero exits carry lifecycle, not success", () => {
  expect(nativeExecutionReceipt(running)).toEqual({ state: "running", sessionId: 42 });
  expect(nativeExecutionReceipt(terminal)).toEqual({ state: "terminal" });
  expect(nativeExecutionReceipt(text("Process running with session ID 2147483648"))).toEqual({ state: "unknown" });
  expect(nativeExecutionReceipt(text("Process exited with code 0", "Process running with session ID 55\n"))).toEqual({ state: "unknown" });
  expect(nativeExecutionReceipt({ ...running, structuredContent: { exit_code: 0 } })).toEqual({ state: "unknown" });
});

test("native text retains the real handle; a late running poll cannot resurrect a closed process", async () => {
  const book = new McpAdmissionBook(); const first = message(1);
  book.begin(first); await book.complete(first, response(1, running));
  expect(book.continuations).toBe(1); expect(book.canClose).toBe(false);
  expect(book.allowed(message(2, "codex_write_stdin", { session_id: 42, chars: "" }), true)).toBe(true);
  expect(book.allowed(message(2, "codex_write_stdin", { session_id: 99, chars: "" }), true)).toBe(false);
  const oldPoll = message(2, "codex_write_stdin", { session_id: 42, chars: "" });
  const finalPoll = message(3, "codex_write_stdin", { session_id: 42, chars: "" });
  book.begin(oldPoll); book.begin(finalPoll);
  await book.complete(finalPoll, response(3, terminal));
  expect(book.continuations).toBe(0); expect(book.canClose).toBe(false);
  await book.complete(oldPoll, response(2, running));
  expect(book.continuations).toBe(0); expect(book.canClose).toBe(true);
  const next = message(4); book.begin(next); await book.complete(next, response(4, running));
  expect(book.continuations).toBe(1); // A genuine new exec may reuse a native handle value.
});

test("completed native receipt replay and ambiguity keep their distinct admission states", async () => {
  const book = new McpAdmissionBook(); const m = message(1);
  book.begin(m); await book.complete(m, response(1, terminal));
  const duplicate = await book.duplicate(m)!;
  expect(await duplicate.json()).toEqual({ jsonrpc: "2.0", id: 1, result: terminal });
  expect(book.pending).toBe(0); expect(book.uncertain).toBe(0);
  const ambiguous = message(2); book.begin(ambiguous);
  await book.complete(ambiguous, response(2, { ...running, structuredContent: { exit_code: 0 } }));
  expect(book.uncertain).toBe(1); expect(book.canClose).toBe(false);
});

test("a native text handle still permits only an empty known-handle poll after observer loss", async () => {
  const root = mkdtempSync(join(tmpdir(), "93-native-")); const socket = join(root, "b.sock");
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  try {
    const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root], tools: [], sandboxPolicy: { type: "dangerFullAccess" } });
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
    const invoke = (invocationId: string, wireName: string, args: Record<string, unknown>, timeout = 5000) =>
      callTurnBroker<BrokerToolResult>(socket, { method: "invoke", bindingId, invocationId, wireName, arguments: args }, timeout);
    const seed = invoke("original-start", "exec_command", { cmd: "synthetic long command" });
    const [started] = await broker.nextToolBatch(token); broker.completeTool(token, started!.callId, running); await seed;
    const lost = invoke("lost-side-effect", "exec_command", { cmd: "synthetic uncertain command" }, 100).catch(e => e);
    const [pending] = await broker.nextToolBatch(token); await lost; await Bun.sleep(30);
    await expect(invoke("new-side-effect", "exec_command", { cmd: "synthetic uncertain command" })).rejects.toThrow("unknown outcome");
    await expect(invoke("input-is-not-poll", "write_stdin", { session_id: 42, chars: "y\n" })).rejects.toThrow("retained");
    await expect(invoke("overlong-poll", "write_stdin", { session_id: 42, chars: "", yield_time_ms: 60_001 })).rejects.toThrow("retained");
    const poll = invoke("original-handle-poll", "write_stdin", { session_id: 42, chars: "", yield_time_ms: 60_000 });
    const batch = Promise.race([broker.nextToolBatch(token), poll.then(() => {
      throw new Error("The poll returned before its original owner dispatched it");
    })]);
    const journal = new OperationJournal(root, "tool-operations");
    for (let i = 0; i < 100; i++) {
      if (Object.keys(journal.read<any>(operationDigest(token)).calls).length === 3) break;
      await Bun.sleep(5);
    }
    const [allowed] = await batch; expect(allowed!.wireName).toBe("write_stdin");
    expect(allowed!.arguments?.yield_time_ms).toBe(60_000);
    broker.completeTool(token, allowed!.callId, terminal); expect(await poll).toEqual(terminal);
    broker.completeTool(token, pending!.callId, terminal);
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});
