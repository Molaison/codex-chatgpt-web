import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker, callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { nativeExecutionReceipt } from "../src/adapters/chatgpt-web/native-terminal-receipt";
import { DurableOperation, OperationJournal, operationDigest, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace, chatGptWebTraceId } from "../src/adapters/chatgpt-web/index";
import { chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRoundKey } from "../src/adapters/chatgpt-web/turn-execution";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { decodeCompactionSummary } from "../src/responses/compaction";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import type { BrowserObservationCheckpoint } from "../src/adapters/chatgpt-web/observation-recovery";

const nativeText = "Chunk ID: abcdef\nWall time: 0.0123 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\nOriginal result\n";
const result: BrokerToolResult = { content: [{ type: "text", text: nativeText }] };

test("Full terminal proof accepts only observed native completed envelopes or structured native receipts", () => {
  expect(nativeExecutionReceipt(result)).toEqual({ state: "terminal" });
  for (const text of ["assistant says Process exited with code 0",
    nativeText + "Process exited with code 0\n", nativeText.replace("Chunk ID: abcdef", "Chunk ID: arbitrary"),
    nativeText.replace("Process exited with code 0", "Process exited with code 0\nProcess running with session ID 42")]) {
    expect(nativeExecutionReceipt({ content: [{ type: "text", text }] })).toEqual({ state: "unknown" });
  }
  expect(nativeExecutionReceipt({ ...result, isError: true })).toEqual({ state: "unknown" });
  expect(nativeExecutionReceipt({ content: [{ type: "text", text: nativeText.replace("Original token count: 4\n", "") }] })).toEqual({ state: "terminal" });
  expect(nativeExecutionReceipt({ content: [{ type: "text", text: nativeText.replace("Process exited with code 0", "Process running with session ID 42") }] })).toEqual({ state: "running", sessionId: 42 });
  expect(nativeExecutionReceipt({ content: [], structuredContent: { session_id: 42 } })).toEqual({ state: "running", sessionId: 42 });
  expect(nativeExecutionReceipt({ content: [], structuredContent: { exit_code: 0 } })).toEqual({ state: "terminal" });
  expect(nativeExecutionReceipt({ ...result, structuredContent: { session_id: 42 } })).toEqual({ state: "unknown" });
});

async function nativeFixture(run: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "42-full-observe-")), socket = join(root, "b.sock");
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root], tools: [], sandboxPolicy: { type: "dangerFullAccess" } }, undefined, "original-trace");
  const claim = await callTurnBroker<{ bindingId: string; activityId: string }>(socket, { method: "claim", token });
  const request = { method: "invoke" as const, bindingId: claim.bindingId, invocationId: "original-invocation", wireName: "exec_command", arguments: { cmd: "synthetic original one-time command" } };
  const running = callTurnBroker<BrokerToolResult>(socket, request);
  const [call] = await broker.nextToolBatch(token); broker.completeTool(token, call!.callId, result); await running;
  await callTurnBroker(socket, { method: "activity_complete", token, activityId: claim.activityId });
  const journal = new OperationJournal(root, "tool-operations"), tokenHash = operationDigest(token);
  const accepted = { [call!.callId]: operationDigest(JSON.stringify(result)) };
  try { await run({ root, socket, broker, token, claim, request, journal, tokenHash, accepted, call: call! }); }
  finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
}

test("read-only invocation receipt query preserves original identity, observerLost and delivery and never invokes", async () => {
  await nativeFixture(async ({ broker, socket, request, journal, tokenHash, call }: any) => {
    const record = journal.read(tokenHash); record.calls[call.callId].observerLost = true; journal.write(tokenHash, record);
    await broker.close(); await broker.listen();
    const before = journal.read(tokenHash);
    const receipt = await callTurnBroker<any>(socket, { ...request, method: "owner_invocation_receipt" });
    expect(receipt.state).toBe("completed"); expect(receipt.result).toEqual(result);
    expect(receipt.observerLost).toBe(true); expect(receipt.reconciliation).toBeNull(); expect(receipt.delivery).toBe("unknown");
    expect(journal.read(tokenHash)).toEqual(before);
    await expect(callTurnBroker(socket, { ...request, method: "owner_invocation_receipt", arguments: { cmd: "different command" } })).rejects.toThrow("conflicts");
    expect((await callTurnBroker<any>(socket, { ...request, method: "owner_invocation_receipt", invocationId: "new-invocation" })).state).toBe("not_found");
    expect(journal.read(tokenHash)).toEqual(before);
  });
});

test("Full read-only terminal inspection keeps pending activity, old format, unknown receipt and open native sessions fenced", async () => {
  await nativeFixture(async ({ broker, journal, tokenHash, accepted, call }: any) => {
    expect(() => broker.inspectRetainedObservation(tokenHash, "original-trace", accepted)).toThrow("still live");
    await broker.close();
    expect(broker.inspectRetainedObservation(tokenHash, "original-trace", accepted).digest).toMatch(/^[a-f0-9]{64}$/);
    const original = journal.read(tokenHash);
    const variants = [
      { ...original, observationState: undefined },
      { ...original, observationState: { revision: 1, activeActivityRefs: ["unconfirmed-claim"] } },
      { ...original, calls: { [call.callId]: { ...original.calls[call.callId], observerLost: true, reconciliation: undefined } } },
      { ...original, calls: { [call.callId]: { ...original.calls[call.callId], state: "unknown" } } },
      { ...original, bindingHash: "a".repeat(64) },
    ];
    for (const candidate of variants) {
      journal.write(tokenHash, candidate);
      expect(() => broker.inspectRetainedObservation(tokenHash, "original-trace", accepted)).toThrow();
      expect(journal.read(tokenHash)).toEqual(candidate);
    }
    const runningResult = { content: [], structuredContent: { session_id: 42 } };
    const runningHash = operationDigest(JSON.stringify(runningResult));
    const open = { ...original, calls: { [call.callId]: { ...original.calls[call.callId], result: runningResult, resultHash: runningHash } } };
    journal.write(tokenHash, open);
    expect(() => broker.inspectRetainedObservation(tokenHash, "original-trace", { [call.callId]: runningHash })).toThrow("unclosed session");
    const finalId = "call_final_poll", finalHash = operationDigest(JSON.stringify(result));
    open.calls[finalId] = { ...original.calls[call.callId], request: { callId: finalId, wireName: "write_stdin", freeform: false,
      arguments: { session_id: 42, chars: "" } }, result, resultHash: finalHash };
    journal.write(tokenHash, open);
    expect(broker.inspectRetainedObservation(tokenHash, "original-trace", { [call.callId]: runningHash, [finalId]: finalHash }).digest).toMatch(/^[a-f0-9]{64}$/);
    journal.write(tokenHash, original);
    expect(() => broker.inspectRetainedObservation(tokenHash, "wrong-trace", accepted)).toThrow();
    expect(() => broker.inspectRetainedObservation(tokenHash, "original-trace", {})).toThrow();
  });
});

test("Full canonical HTTP round restores only observation from terminal native receipt and emits no new tools", async () => {
  await nativeFixture(async ({ root, broker, journal, tokenHash, accepted, call }: any) => {
    await broker.close();
    const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "browser://" + root,
      chatgptWeb: { accountId: "account-2", appName: "Recovery42", browserHost: "launcher", browserHostDescriptorPath: join(root, "not-opened.json"),
        localToolsEnabled: true, threadEnvironmentStatePath: join(root, "environment.json"), brokerSocketPath: join(root, "b.sock") } };
    const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "low" },
      context: { systemPrompt: [], tools: [{ name: "exec_command", description: "Fixture command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
        messages: [{ role: "user", content: "Original question", timestamp: 1 },
          { role: "toolResult", toolCallId: call.callId, toolName: "exec_command", content: nativeText, isError: false, timestamp: 2 }] },
      _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "original-thread", turn_id: "original-turn", sandbox: "none", workspaces: { [root]: {} } }) },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>` }], internal_chat_message_metadata_passthrough: { turn_id: "original-turn" } }, { type: "message", role: "user", content: "Original question", internal_chat_message_metadata_passthrough: { turn_id: "original-turn" } }, { type: "function_call_output", call_id: call.callId, output: nativeText }] } };
    const namespace = chatGptWebExecutionNamespace(provider), executionKey = `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
    const traceId = chatGptWebTraceId(provider, parsed), roundKey = chatGptTurnRoundKey(parsed);
    // The original local broker's real terminal result is bound to this seeded adapter checkpoint.
    const channel = journal.read(tokenHash); channel.traceId = traceId; journal.write(tokenHash, channel);
    const c: BrowserObservationCheckpoint = { version: 1,
      identity: { operationId: "original-op", executionKey, roundKey, threadId: "original-thread", turnId: "original-turn" },
      traceId, modelId: parsed.modelId, accountId: "account-2", appName: "Recovery42", toolChannel: { tokenHash },
      host: { pid: process.pid, instanceId: "h".repeat(32), profile: "production", partition: "persist:codex-web-gpt-chatgpt" },
      lease: { helperPid: process.pid, surfaceId: "s".repeat(32), targetId: "original-target" },
      conversation: { key: "original-chat", url: "https://chatgpt.com/c/original", claim: "11111111-1111-4111-8111-111111111111" },
      submission: { receipt: "[codex-submission:11111111-1111-4111-8111-111111111111]", initialTurnIdentities: [],
        acceptedUserIdentity: "original-user", assistantIdentity: "original-assistant", acceptedTurnIdentities: ["original-user", "original-assistant"] } };
    const store = new OperationJournal(root), saved: OperationRecord = { version: 1, operationId: c.identity.operationId, executionKey, traceId,
      ownerKey: `${namespace}:${chatGptThreadOwnershipKey(parsed)}`, threadId: c.identity.threadId, turnId: c.identity.turnId,
      requestIds: [], conversationKey: c.conversation.key, submission: "accepted", generation: "running", delivery: "detached", recovery: "none",
      seq: 1, attempt: 1, updatedAt: Date.now(), startedAt: Date.now(), rounds: { [roundKey]: { events: [{ type: "text_delta", text: "Prefix", phase: "final_answer" }], reasoning: [], completed: false } },
      observation: c, observationRound: { roundKey, deliveredToolResults: accepted } };
    store.write(executionKey, saved);
    const worker = ChatGptBrowserWorker.forProvider(provider); const originalRun = worker.run;
    let observations = 0;
    worker.run = async turn => {
      expect(turn.observation).toEqual(c); expect(turn.observationToolFence?.digest).toMatch(/^[a-f0-9]{64}$/);
      observations++; turn.onConversationRestored?.(); turn.onObservationResumed?.();
      turn.onTextDelta("Prefix"); turn.onTextDelta(" recovered final"); return "Prefix recovered final";
    };
    const events: AdapterEvent[] = [];
    try {
      await createChatGptWebAdapter(provider).runTurn(parsed, { headers: new Headers() }, event => events.push(event));
      expect(events.filter(e => e.type === "text_delta").map(e => e.type === "text_delta" ? e.text : "").join("")).toBe("Prefix recovered final");
      expect(events.some(e => e.type === "done")).toBe(true); expect(events.some(e => e.type === "tool_call_start")).toBe(false);
      expect(observations).toBe(1); expect(journal.read(tokenHash)).toEqual(channel);
      const restored = store.read<OperationRecord>(executionKey)!;
      expect(restored.generation).toBe("final"); expect(restored.operationId).toBe(saved.operationId);
      expect(restored.rounds[roundKey]!.events.some(e => e.type === "provider_notice")).toBe(false);
      expect(events.filter(e => e.type === "provider_notice").map(e => e.type === "provider_notice" ? e.notice.kind : ""))
        .toEqual(["reconnecting", "conversation_restored", "resumed"]);
    } finally { worker.run = originalRun; }
  });
});

test("provider notices have bounded independent persistence and cannot enter assistant, reasoning or response output", async () => {
  const root = mkdtempSync(join(tmpdir(), "42-provider-notice-"));
  try {
    const journal = new OperationJournal(root); const record: OperationRecord = { version: 1, operationId: "op_notice", executionKey: "execution_notice", traceId: "trace_notice",
      requestIds: [], submission: "accepted", generation: "running", delivery: "attached", recovery: "none", seq: 0, attempt: 1, updatedAt: Date.now(), startedAt: Date.now(), rounds: {} };
    const operation = new DurableOperation(journal, record);
    for (let i = 0; i < 35; i++) operation.notice(i % 2 ? "reconnecting" : "resumed");
    const restored = new DurableOperation(journal, journal.read<OperationRecord>(record.executionKey)!);
    const notices: AdapterEvent[] = []; const stop = restored.observeNotices(notice => notices.push({ type: "provider_notice", notice })); stop();
    expect(notices.length).toBe(2); expect(restored.record.noticeSeq).toBe(2);
    expect(new Set(notices.map(event => event.type === "provider_notice" ? event.notice.id : "")).size).toBe(2);
    for (let i = 0; i < 35; i++) restored.notice("tool_waiting");
    expect(restored.record.notices).toHaveLength(32);
    expect(restored.record.noticeSeq).toBe(37);
    expect(restored.record.rounds).toEqual({});
    const events: AdapterEvent[] = [...notices, { type: "text_delta", text: "Only answer" }, { type: "done" }];
    async function* source() { yield* events; }
    const frames = await new Response(bridgeToResponsesSSE(source(), "fixture-model")).text();
    const noticeFrames = frames.split("\n\n").filter(frame => frame.startsWith("event: response.provider_notice"))
      .map(frame => JSON.parse(frame.split("\ndata: ")[1]!));
    expect(noticeFrames.length).toBe(2); expect(Object.keys(noticeFrames[0]).sort()).toEqual(["notice", "type"]);
    expect(noticeFrames[0].notice.id).toBe(record.notices![0]!.id); expect(noticeFrames.at(-1).notice.seq).toBe(2);
    expect(noticeFrames.every(frame => Buffer.byteLength(frame.notice.message, "utf8") <= 512 && frame.notice.source === "chatgpt-web" && frame.notice.evidence === "observed")).toBe(true);
    const output = buildResponseJSON(events, "fixture-model").output;
    expect(JSON.stringify(output)).toContain("Only answer"); expect(JSON.stringify(output)).not.toContain("notice");
    const completed = frames.split("\n\n").find(frame => frame.startsWith("event: response.completed"))!;
    expect(completed).not.toContain("provider_notice"); expect(completed).not.toContain("恢复");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("compaction forwards provider notices without adding them to summary, output items or accepted history", async () => {
  const notice: Extract<AdapterEvent, { type: "provider_notice" }>["notice"] = {
    version: 1, id: "notice_compaction_1", execution_id: "compaction_execution", seq: 1,
    kind: "reconnecting", observed_at: "2026-10-24T00:00:00.000Z", message: "正在只读接回原会话。",
    source: "chatgpt-web", evidence: "observed",
  };
  const events: AdapterEvent[] = [
    { type: "provider_notice", notice },
    { type: "text_delta", text: "Only compaction summary" },
    { type: "provider_notice", notice: { ...notice, id: "notice_compaction_2", seq: 2, kind: "resumed" } },
    { type: "done" },
  ];
  let accepted: Record<string, unknown> | undefined;
  async function* source() { yield* events; }
  const stream = bridgeToResponsesSSE(source(), "fixture-model", undefined, undefined, undefined,
    undefined, 2000, { compaction: true, onCompletedResponse(response) { accepted = response; } });
  const frames = (await new Response(stream).text()).split("\n\n").filter(frame => frame.startsWith("event: "))
    .map(frame => JSON.parse(frame.split("\ndata: ")[1]!));
  const notices = frames.filter(frame => frame.type === "response.provider_notice");
  expect(notices.map(frame => frame.notice.seq)).toEqual([1, 2]);
  expect(notices.every(frame => Object.keys(frame).sort().join() === "notice,type")).toBe(true);
  expect(frames.some(frame => frame.type === "response.output_text.delta" || frame.type === "response.reasoning_summary_text.delta")).toBe(false);
  const items = frames.filter(frame => frame.type === "response.output_item.done").map(frame => frame.item);
  expect(items).toHaveLength(1); expect(items[0].type).toBe("compaction");
  expect(decodeCompactionSummary(items[0].encrypted_content)).toBe("Only compaction summary");
  const completed = frames.find(frame => frame.type === "response.completed");
  expect(completed.response.output).toEqual(items); expect(accepted!.output).toEqual(items);
  expect(JSON.stringify(accepted)).not.toContain(notice.message); expect(JSON.stringify(accepted)).not.toContain("provider_notice");
  const batch = buildResponseJSON(events, "fixture-model", { compaction: true }).output as Array<Record<string, string>>;
  expect(batch).toHaveLength(1); expect(batch[0]!.type).toBe("compaction");
  expect(decodeCompactionSummary(batch[0]!.encrypted_content!)).toBe("Only compaction summary");
});
