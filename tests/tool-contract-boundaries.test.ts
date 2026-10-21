import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { filterChatGptToolsForChoice, type ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { connectChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { TurnBroker, type BrokerToolRequest } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";
import type { CodexTool, CodexToolChoice } from "../src/types";

const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

for (const stream of [false, true]) {
  test(`${stream ? "SSE" : "JSON"} preserves colliding custom, search, and namespaced function identities`, async () => {
    const calls = [
      { name: "exec", callId: "custom_exec", arguments: '{"input":"text(1)"}' },
      { name: "mcp__server__exec", callId: "function_exec", arguments: '{"cmd":"pwd"}' },
      { name: "tool_search", callId: "search_native", arguments: '{"query":"docs","limit":2}' },
      { name: "mcp__server__tool_search", callId: "search_function", arguments: '{"query":"local"}' },
    ];
    const config = defaultConfig("full");
    config.solAvailable = false;
    config.proAvailable = false;
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/luna", stream,
        input: [{ type: "message", role: "user", content: "Inspect it." }],
        tools: [
          { type: "custom", name: "exec", format: { type: "text" } },
          { type: "tool_search" },
          { type: "namespace", name: "mcp__server", tools: [
            { type: "function", name: "exec", parameters: { type: "object" } },
            { type: "function", name: "tool_search", parameters: { type: "object" } },
          ] },
        ],
      }),
    }), config, () => ({
      name: "tool-kind-fixture",
      async runTurn(_parsed, _incoming, emit) {
        for (const call of calls) {
          emit({ type: "tool_call_start", id: call.callId, name: call.name });
          emit({ type: "tool_call_delta", arguments: call.arguments });
          emit({ type: "tool_call_end" });
        }
        emit({ type: "done", endTurn: false, stopReason: "tool_use" });
      },
    }), { rememberState: false });
    expect(response.status).toBe(200);
    let output: Array<Record<string, unknown>>;
    if (stream) {
      output = (await response.text()).split("\n")
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)))
        .filter(event => event.type === "response.output_item.done")
        .map(event => event.item);
    } else {
      output = (await response.json()).output;
    }
    expect(output).toHaveLength(4);
    expect(output[0]).toMatchObject({ type: "custom_tool_call", call_id: "custom_exec", name: "exec", input: "text(1)" });
    expect(output[1]).toMatchObject({
      type: "function_call", call_id: "function_exec", namespace: "mcp__server", name: "exec", arguments: '{"cmd":"pwd"}',
    });
    expect(output[2]).toMatchObject({ type: "tool_search_call", call_id: "search_native", arguments: { query: "docs", limit: 2 } });
    expect(output[3]).toMatchObject({
      type: "function_call", call_id: "search_function", namespace: "mcp__server", name: "tool_search", arguments: '{"query":"local"}',
    });
  });
}

test("namespace-qualified tool choice does not select a colliding bare tool", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/luna", input: "Inspect it.",
    tools: [
      { type: "custom", name: "exec" },
      { type: "namespace", name: "mcp__server", tools: [{ type: "function", name: "exec" }] },
    ],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", namespace: "mcp__server", name: "exec" }] },
  });
  expect(parsed.options.toolChoice).toEqual({ allowedTools: ["mcp__server__exec"], mode: "auto" });
  expect(filterChatGptToolsForChoice(parsed.context.tools, parsed.options.toolChoice))
    .toEqual([expect.objectContaining({ namespace: "mcp__server", name: "exec" })]);
});

test("thread authority reuse always applies the current request tool choice and inventory", () => {
  const store = new ChatGptThreadEnvironmentStore();
  const input = (withEnvironment: boolean, turnId: string) => [
    ...(withEnvironment ? [{ type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>/tmp</cwd><filesystem><workspace_roots><root>/tmp</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>` }], internal_chat_message_metadata_passthrough: { turn_id: turnId } }] : []),
    { type: "message", role: "user", content: "Inspect it.", internal_chat_message_metadata_passthrough: { turn_id: turnId } },
  ];
  const tools = [
    { type: "function", name: "inspect" },
    { type: "function", name: "write" },
  ];
  for (const [index, choice] of ["auto", "none", { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "inspect" }] }, "auto"].entries()) {
    const turnId = `turn_policy_${index}`;
    const environment = store.resolve(parseRequest({
      model: "chatgpt-web/luna", tools, tool_choice: choice, input: input(index === 0, turnId),
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_policy", turn_id: turnId }) },
    }));
    expect(environment.tools.map(tool => tool.name)).toEqual(index === 1 ? [] : index === 2 ? ["inspect"] : ["inspect", "write"]);
  }
});

const tools: CodexTool[] = [
  { name: "exec", freeform: true, description: "Native gateway", parameters: {} },
  { name: "inspect", description: "Read a file", parameters: { type: "object" } },
  { name: "write", description: "Write a file", parameters: { type: "object" } },
];

async function mcpFixture(choice: CodexToolChoice, execute?: (request: BrokerToolRequest) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cgw-tool-policy-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brokerSocketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(brokerSocketPath);
  cleanup.push(() => broker.close());
  const environment: ChatGptTurnEnvironment = {
    cwd: root, roots: [root], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: filterChatGptToolsForChoice(tools, choice), toolChoice: choice,
  };
  const token = await broker.register(environment, 60_000);
  const [local, remote] = InMemoryTransport.createLinkedPair();
  const server = await connectChatGptMcpServer({ brokerSocketPath }, remote);
  cleanup.push(() => server.close());
  const client = new Client({ name: "tool-policy-test", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(local);
  return async (name: string, args: Record<string, unknown>, nestedNames?: string[]) => {
    const requests: BrokerToolRequest[] = [];
    const abort = new AbortController();
    const dispatch = broker.nextToolBatch(token, abort.signal).then(async batch => {
      requests.push(...batch);
      for (const request of batch) {
        const content: Array<{ type: "text"; text: string }> = [];
        await execute?.(request);
        if (nestedNames && request.input) {
          const runProgram = new Function("ALL_TOOLS", "text", request.input);
          runProgram(nestedNames.map(name => ({ name, description: name })), (text: string) => content.push({ type: "text", text }));
        } else content.push({ type: "text", text: "Fixture dispatched" });
        broker.completeTool(token, request.callId, { content });
      }
    }).catch(error => { if (!abort.signal.aborted) throw error; });
    const result = await client.callTool({ name, arguments: { turn_token: token, ...args } });
    abort.abort();
    await dispatch;
    return { result, requests };
  };
}

test("tool_choice none denies direct, generic, and helper gateway calls before owner dispatch", async () => {
  const call = await mcpFixture("none");
  for (const [name, args] of [
    ["codex_tool_call", { wire_name: "inspect", arguments: {} }],
    ["codex_tool_call", { wire_name: "nested_denied", arguments: {} }],
    ["codex_exec", { cmd: "pwd" }],
    ["codex_write_stdin", { session_id: 1 }],
    ["codex_apply_patch", { patch: "*** Begin Patch\n*** End Patch" }],
    ["codex_view_image", { path: "/tmp/example.png" }],
  ] as const) {
    const { result, requests } = await call(name, args);
    expect(result.isError).toBeTrue();
    expect(requests).toHaveLength(0);
  }
});

test("an allowed subset applies to direct tools, generic gateways, and specialized helpers", async () => {
  const call = await mcpFixture({ allowedTools: ["exec", "inspect", "nested_allowed"], mode: "auto" });
  for (const wire_name of ["inspect", "nested_allowed"]) {
    const { result, requests } = await call("codex_tool_call", { wire_name, arguments: {} });
    expect(result.isError).not.toBeTrue();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.wireName).toBe(wire_name === "inspect" ? "inspect" : "exec");
  }
  for (const [name, args] of [
    ["codex_tool_call", { wire_name: "write", arguments: {} }],
    ["codex_tool_call", { wire_name: "nested_denied", arguments: {} }],
    ["codex_exec", { cmd: "pwd" }],
    ["codex_write_stdin", { session_id: 1 }],
    ["codex_apply_patch", { patch: "*** Begin Patch\n*** End Patch" }],
    ["codex_view_image", { path: "/tmp/example.png" }],
  ] as const) {
    const { result, requests } = await call(name, args);
    expect(result.isError).toBeTrue();
    expect(requests).toHaveLength(0);
  }
});

test("gateway inventory omits disallowed nested tools and reports the filtered total", async () => {
  const call = await mcpFixture({ allowedTools: ["exec", "inspect", "nested_allowed"], mode: "auto" });
  const { result } = await call("codex_tool_inventory", { query: "nested" }, ["nested_allowed", "nested_denied"]);
  expect(result.isError).not.toBeTrue();
  const content = result.content as Array<{ type: string; text: string }>;
  const catalog = JSON.parse(content[0]!.text);
  expect(catalog.total).toBe(1);
  expect(catalog.tools.map((tool: { wire_name: string }) => tool.wire_name)).toEqual(["nested_allowed"]);
});

test("restricted tool choice rejects raw JavaScript including reflective tool access before dispatch", async () => {
  const call = await mcpFixture({ allowedTools: ["exec", "inspect", "nested_allowed"], mode: "auto" });
  for (const input of [
    "await tools.nested_denied({});",
    "await globalThis.tools.nested_denied({});",
    'await Function("return tools")().nested_denied({});',
  ]) {
    const { result, requests } = await call("codex_tool_call", { wire_name: "exec", input });
    expect(result.isError).toBeTrue();
    expect(JSON.stringify(result.content)).toContain("Raw JavaScript exec is unavailable with a restricted tool_choice");
    expect(requests).toHaveLength(0);
  }
});

test("restricted inventory hides raw exec while keeping allowed structured gateway tools", async () => {
  const call = await mcpFixture({ allowedTools: ["exec", "inspect", "nested_allowed"], mode: "auto" });
  const { result } = await call("codex_tool_inventory", {}, ["nested_allowed", "nested_denied"]);
  expect(result.isError).not.toBeTrue();
  const catalog = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  expect(catalog.total).toBe(2);
  expect(catalog.tools.map((tool: { wire_name: string }) => tool.wire_name)).toEqual(["inspect", "nested_allowed"]);
});

test("auto policy preserves native raw exec execution", async () => {
  let calls = 0;
  const call = await mcpFixture("auto", async request => {
    const run = new Function("tools", "ALL_TOOLS", `return (async () => { ${request.input} })();`);
    await run({ nested_allowed: async () => { calls++; } }, [{ name: "nested_allowed" }]);
  });
  const { result, requests } = await call("codex_tool_call", { wire_name: "exec", input: "await tools.nested_allowed({});" });
  expect(result.isError).not.toBeTrue();
  expect(requests).toHaveLength(1);
  expect(calls).toBe(1);
});

test("restricted policy preserves the allowed specialized structured command gateway", async () => {
  const invoked: unknown[] = [];
  const call = await mcpFixture({ allowedTools: ["exec", "exec_command"], mode: "auto" }, async request => {
    const run = new Function("tools", "ALL_TOOLS", "text", `return (async () => { ${request.input} })();`);
    await run({ exec_command: async (args: unknown) => { invoked.push(args); return "fixture result"; } },
      [{ name: "exec_command" }], () => {});
  });
  const { result, requests } = await call("codex_exec", { cmd: "fixture command" });
  expect(result.isError).not.toBeTrue();
  expect(requests).toHaveLength(1);
  expect(invoked).toEqual([{ cmd: "fixture command" }]);
});
