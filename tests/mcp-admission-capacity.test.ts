import { expect, test } from "bun:test";
import { McpAdmissionBook } from "../src/adapters/chatgpt-web/mcp-admission";

const message = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {
  name: "codex_tool_call", arguments: { turn_token: "original-turn", wire_name: "exec_command", arguments: { cmd: `command ${id}` } },
} });
const completed = (id: number) => Response.json({ jsonrpc: "2.0", id,
  result: { content: [], structuredContent: { exit_code: 0, output: `result ${id}` } },
});

test("completed MCP requests free admission capacity while every old identity stays fenced", async () => {
  const book = new McpAdmissionBook();
  for (let id = 0; id < 300; id++) {
    expect(book.begin(message(id))).toBe(true);
    await book.complete(message(id), completed(id));
  }
  expect(book.pending).toBe(0);
  expect(book.uncertain).toBe(0);
  expect(book.canClose).toBe(true);
  expect(await (await book.duplicate(message(299))!).json()).toEqual(await completed(299).json());
  const old = await book.duplicate(message(0))!;
  expect(old.status).toBe(409);
  expect(await old.text()).toContain("do not redispatch");
  expect(book.begin(message(0))).toBe(false);
  const changed = message(299); changed.params.arguments.arguments.cmd = "different side effect";
  expect((await book.duplicate(changed)!).status).toBe(409);
  changed.id = 0;
  expect((await book.duplicate(changed)!).status).toBe(409);
  expect(book.begin(message(300))).toBe(true);
});

test("uncertain MCP requests retain the admission bound and original replies", async () => {
  const book = new McpAdmissionBook();
  for (let id = 0; id < 256; id++) {
    expect(book.begin(message(id))).toBe(true);
    await book.complete(message(id), Response.json({ error: { code: -32603, message: "delivery lost" } }, { status: 502 }), true);
  }
  expect(book.uncertain).toBe(256);
  expect(book.canClose).toBe(false);
  expect(book.begin(message(256))).toBe(false);
  expect((await book.duplicate(message(0))!).status).toBe(502);
  const pending = new McpAdmissionBook();
  for (let id = 0; id < 256; id++) expect(pending.begin(message(id))).toBe(true);
  expect(pending.pending).toBe(256);
  expect(pending.begin(message(256))).toBe(false);
});
