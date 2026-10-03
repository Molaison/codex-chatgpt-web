import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig, providerConfig } from "../src/config";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

// Real SDK HTTP, adapter and OS broker; browser/model and outer Codex are fixtures.
// No account, public endpoint, shell command supplied by MCP, or manual Sent flow.
const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-auto-http-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    ...defaultConfig("full"),
    browserHost: "launcher" as const,
    browserInteractionMode: "automatic" as const,
    mcpProvider: "external-http" as const,
    browserHostDescriptorPath: join(root, "launcher.json"),
    brokerSocketPath: defaultBrokerEndpoint(root),
    storageStatePath: join(root, "storage-state.json"),
    accountId: root,
  };
  const provider = providerConfig(config);
  Object.assign(provider.chatgptWeb!, {
    threadEnvironmentStatePath: join(root, "thread-environments.json"),
    lunaCheckpointStatePath: join(root, "luna-checkpoints.json"),
    turnTimeoutMs: 15_000,
  });
  const broker = TurnBroker.forSocket(config.brokerSocketPath);
  cleanup.push(() => broker.close());
  const http = startChatGptMcpHttpServer({ brokerSocketPath: config.brokerSocketPath, contract: "native", port: 0 });
  cleanup.push(() => http.close());
  const client = new Client({ name: "automatic-full-fixture", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(http.url));
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  cleanup.push(() => { worker.run = originalRun; });
  const manual = async (): Promise<never> => { throw new Error("automatic Full entered manual control"); };
  const zeroRiskManualControl: ChatGptZeroRiskManualControl = {
    start: manual, waitSent: manual, waitTerminal: manual, markStarted: manual, end: manual, cancel: manual,
  };
  const adapter = createChatGptWebAdapter(provider, { broker, zeroRiskManualControl });
  const request = (turnId: string): CodexParsedRequest => ({
    modelId: CHATGPT_WEB_MODEL_ID, stream: true,
    context: {
      tools: [{ name: "exec_command", description: "Fixture execution", parameters: { type: "object", properties: {
        cmd: { type: "string" }, workdir: { type: "string" }, sandbox_permissions: { type: "string" },
        justification: { type: "string" }, prefix_rule: { type: "array", items: { type: "string" } },
      } } }],
      messages: [{ role: "user", content: "Run the harmless fixture", timestamp: 1 }],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: root,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: turnId }) },
      input: [
        {
          type: "message", role: "user",
          content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>${root}</path></entry></file_system></permission_profile></filesystem></environment_context>` }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message", role: "user", content: [{ type: "input_text", text: "Run the harmless fixture" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  });
  const run = async (input: CodexParsedRequest, abortSignal?: AbortSignal) => {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(input, { headers: new Headers(), abortSignal }, event => events.push(event));
    return events;
  };
  return { root, provider, client, worker, request, run };
}

async function observeBatch(turn: BrowserTurn) {
  const progress = turn.externalProgress!;
  let snapshot = progress.snapshot();
  while (snapshot.activeToolCalls === 0) snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
  expect(await turn.completionFence!.begin()).toBeUndefined();
  return snapshot.lastToolBatchRevision;
}

function continueWithResult(request: CodexParsedRequest, events: AdapterEvent[], arguments_: Record<string, unknown>, output: string, isError: boolean) {
  const call = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
  expect(call?.name).toBe("exec_command");
  const encodedArguments = events.filter(event => event.type === "tool_call_delta").map(event => event.arguments).join("");
  expect(JSON.parse(encodedArguments)).toEqual(arguments_);
  expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
  const next = structuredClone(request);
  next.context.messages.push(
    { role: "assistant", content: [{ type: "toolCall", id: call!.id, name: call!.name, arguments: arguments_ }], timestamp: 2 },
    { role: "toolResult", toolCallId: call!.id, toolName: call!.name, content: output, isError, timestamp: 3 },
  );
  (next._rawBody as { input: unknown[] }).input.push(
    { type: "function_call", call_id: call!.id, name: call!.name, arguments: JSON.stringify(arguments_) },
    { type: "function_call_output", call_id: call!.id, output },
  );
  return next;
}

test("automatic Full completes two HTTP tool rounds and replays without manual handoffs", async () => {
  const { root, provider, client, worker, request, run } = await fixture();
  expect(provider.chatgptWeb).toMatchObject({ localToolsEnabled: true, browserInteractionMode: "automatic", autoApproveToolCalls: false });
  expect(client.getServerVersion()?.name).toBe("codex-native");
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("codex_turn_start");
  const deniedArguments = { cmd: "fixture-needs-approval", sandbox_permissions: "require_escalated", justification: "Fixture owner must decide", prefix_rule: ["fixture-needs-approval"] };
  const allowedArguments = { cmd: "fixture-fixed-child", workdir: root };
  let browserStarts = 0;
  const tokens: string[] = [];
  worker.run = async turn => {
    browserStarts++;
    expect(turn.capabilities.localToolsEnabled).toBeTrue();
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      expect(token).toBeDefined();
      expect(prepared.text).not.toContain("codex_turn_start");
      tokens.push(token!);
      turn.onSendActivated?.();
      turn.onSubmitted?.();
      if (browserStarts === 1) {
        for (const args of [deniedArguments, allowedArguments]) {
          const result = client.callTool({ name: "codex_exec", arguments: { turn_token: token!, ...args } });
          await turn.externalProgress!.acknowledgeToolBatch(await observeBatch(turn));
          const received = await result;
          if (args === deniedArguments) {
            expect(received.isError).toBeTrue();
            expect(JSON.stringify(received.content)).toContain("Fixture owner denied escalation");
          } else {
            expect(received.isError).not.toBeTrue();
            expect(JSON.stringify(received.content)).toContain("AUTO_FULL_OK");
          }
        }
      }
      const revision = await turn.completionFence!.begin();
      expect(typeof revision).toBe("number");
      expect(await turn.completionFence!.commit(revision!)).toBeTrue();
      turn.onTextDelta("Automatic Full completed");
      return "Automatic Full completed";
    } finally { prepared.release(); }
  };
  let input = request("full-first");
  const first = await run(input);
  const replay = await run(input);
  expect(replay.filter(event => event.type === "tool_call_start")).toEqual(first.filter(event => event.type === "tool_call_start"));
  expect(browserStarts).toBe(1);
  input = continueWithResult(input, first, deniedArguments, "Fixture owner denied escalation", true);
  const second = await run(input);
  // This fixed harmless process stands in for Codex after its own policy decision.
  // Never execute the MCP-supplied command string in this test.
  const child = Bun.spawn([process.execPath, "-e", 'process.stdout.write("AUTO_FULL_OK")'], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  input = continueWithResult(input, second, allowedArguments, JSON.stringify({ output, exit_code: 0 }), false);
  const final = await run(input);
  expect(final.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  expect(final.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe("Automatic Full completed");
  expect((await run(input)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(browserStarts).toBe(1);
  expect((await client.callTool({ name: "codex_exec", arguments: { turn_token: tokens[0], cmd: "fixture-stale" } })).isError).toBeTrue();
  expect((await run(request("full-next"))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(browserStarts).toBe(2);
  expect(tokens[0]).not.toBe(tokens[1]);
}, 20_000);

test("MCP cancellation retires automatic Full's pending tool and token", async () => {
  const { client, worker, request, run } = await fixture();
  const caller = new AbortController();
  let token = "";
  let reached!: () => void;
  const pending = new Promise<void>(resolve => { reached = resolve; });
  let callOutcome: Promise<unknown> | undefined;
  let browserSignal: AbortSignal | undefined;
  worker.run = async turn => {
    browserSignal = turn.abortSignal;
    const prepared = await turn.prepare();
    try {
      token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)![1]!;
      turn.onSendActivated?.();
      turn.onSubmitted?.();
      callOutcome = client.callTool(
        { name: "codex_exec", arguments: { turn_token: token, cmd: "fixture-never-executed" } },
        undefined, { signal: caller.signal },
      ).then(() => undefined, error => error);
      await observeBatch(turn);
      reached();
      await callOutcome;
      return await new Promise<string>((_resolve, reject) => {
        const aborted = () => reject(turn.abortSignal?.reason ?? new DOMException("Fixture cancelled", "AbortError"));
        if (turn.abortSignal?.aborted) aborted();
        else turn.abortSignal?.addEventListener("abort", aborted, { once: true });
      });
    } finally { prepared.release(); }
  };
  const execution = run(request("full-cancelled"));
  await pending;
  caller.abort(new DOMException("Fixture cancelled", "AbortError"));
  const events = await execution;
  expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
  expect(events.at(-1)).toMatchObject({ type: "error", code: "chatgpt_submitted_turn_failed" });
  expect(browserSignal?.aborted).toBeTrue();
  expect(await callOutcome!).toMatchObject({ message: expect.stringContaining("Fixture cancelled") });
  expect((await client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "fixture-stale" } })).isError).toBeTrue();
}, 20_000);
