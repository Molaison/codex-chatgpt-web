// SDK + real broker; native tools are synthetic. Real business acceptance is separate.
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { OperationJournal, operationDigest } from "../src/adapters/chatgpt-web/operation-journal";
import { CODEX_NATIVE_RECEIPT_WIRE_NAME } from "../src/adapters/chatgpt-web/native-terminal-receipt";
import { McpAdmissionBook } from "../src/adapters/chatgpt-web/mcp-admission";

test("existing generic MCP surface reads only its original accepted receipt, disambiguates multiple calls and never executes", async () => {
  const root = mkdtempSync(join(tmpdir(), "r42receipt-")), path = join(root, "b.sock");
  const broker = TurnBroker.forSocket(path); await broker.listen();
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [{ name: "exec_command", description: "synthetic",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = await connectChatGptMcpServer({ brokerSocketPath: path }, b);
  const client = new Client({ name: "public-receipt", version: "1" }); await client.connect(a);
  const journal = new OperationJournal(root, "tool-operations");
  const read = async (args = {}) => {
    const r = await client.callTool({ name: "codex_tool_call", arguments: { turn_token: token,
      wire_name: CODEX_NATIVE_RECEIPT_WIRE_NAME, arguments: args } });
    expect(r.isError).not.toBe(true); return r.structuredContent as any;
  };
  const result: BrokerToolResult = { content: [{ type: "text", text: "Wall time: 0.0010 seconds\nProcess exited with code 7\nOutput:\n1\n" }] };
  try {
    expect((await read()).state).toBe("not_found");
    const executing = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "synthetic effect" } });
    const [first] = await broker.nextToolBatch(token);
    expect((await read()).state).toBe("unknown");
    broker.completeTool(token, first!.callId, result); await executing;
    const before = journal.read<any>(operationDigest(token));
    const recovered = await read(); expect(recovered.state).toBe("completed");
    expect(recovered.result).toEqual(result); expect(recovered.native_redispatch).toBe(false);
    expect(recovered.response_delivery_ack).toBe("unknown");
    expect(journal.read<any>(operationDigest(token)).calls).toEqual(before.calls);
    const again = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "synthetic effect" } });
    const [second] = await broker.nextToolBatch(token); expect(second!.callId).not.toBe(first!.callId);
    broker.completeTool(token, second!.callId, result); await again;
    expect((await read()).state).toBe("select_receipt");
    expect((await read({ call_id: first!.callId })).call_id).toBe(first!.callId);
    expect((await read({ call_id: "other-turn-call" })).state).toBe("not_found");
    const denied = await client.callTool({ name: "codex_tool_call", arguments: { turn_token: token,
      wire_name: CODEX_NATIVE_RECEIPT_WIRE_NAME, arguments: { cmd: "never execute" } } });
    expect(denied.isError).toBe(true);
    expect(Object.keys(journal.read<any>(operationDigest(token)).calls)).toHaveLength(2);
  } finally { await client.close(); await mcp.close(); await broker.close(); rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("native receipt validation cannot invent execution ambiguity or clear an old unknown", async () => {
  const query = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_tool_call",
    arguments: { turn_token: "own-turn", wire_name: CODEX_NATIVE_RECEIPT_WIRE_NAME, arguments: { cmd: "invalid" } } } };
  const failure = (id: number) => new Response(JSON.stringify({ jsonrpc: "2.0", id,
    result: { isError: true, content: [{ type: "text", text: "invalid receipt arguments" }] } }));
  const book = new McpAdmissionBook(undefined, true);
  book.begin(query); await book.complete(query, failure(1)); expect(book.canClose).toBe(true);
  const exec = { ...query, id: 2, params: { name: "codex_exec", arguments: { turn_token: "own-turn", cmd: "effect" } } };
  book.begin(exec); await book.complete(exec, failure(2)); expect(book.uncertain).toBe(1);
  const again = { ...query, id: 3 }; book.begin(again); await book.complete(again, failure(3));
  expect(book.uncertain).toBe(1); expect(book.canClose).toBe(false);
  const safe = new McpAdmissionBook(); safe.begin(query); await safe.complete(query, failure(1));
  expect(safe.uncertain).toBe(1); // A similarly named safe/custom native tool gets no exemption.
});
