import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptQuestionAnswerNamespace } from "../src/adapters/chatgpt-web/conversation-key";
import { chatGptWebExecutionNamespace, chatGptWebTraceId, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { DurableOperation, OperationJournal, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import type { BrowserObservationCheckpoint } from "../src/adapters/chatgpt-web/observation-recovery";
import type { ChatGptChartWidget } from "../src/adapters/chatgpt-web/rich-widget";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

for (const [deferred, settled] of [[true, false], [false, false], [true, true]] as const) test(`cold observation preserves the requested chart projection (deferred=${deferred}, settled=${settled})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cold-widgets-"));
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "browser://" + root,
    chatgptWeb: { accountId: root, appName: "ColdWidgetFixture", browserHost: "launcher",
      browserHostDescriptorPath: join(root, "not-opened.json"), localToolsEnabled: false,
      threadEnvironmentStatePath: join(root, "environment.json"), brokerSocketPath: join(root, "b.sock") } };
  const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "low" },
    context: { messages: [{ role: "user", content: "Show the original chart", timestamp: 1 }] },
    _rawBody: { client_metadata: { _chatgpt_defer_text_until_complete: deferred,
      "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "original-turn" }) },
      input: [{ type: "message", role: "user", content: "Show the original chart",
        internal_chat_message_metadata_passthrough: { turn_id: "original-turn" } }] } };
  const executionKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
  const traceId = chatGptWebTraceId(provider, parsed), roundKey = chatGptTurnRoundKey(parsed);
  const checkpoint: BrowserObservationCheckpoint = { version: 1,
    identity: { operationId: "original-operation", executionKey, roundKey, threadId: root, turnId: "original-turn" },
    traceId, modelId: parsed.modelId, accountId: root, appName: "ColdWidgetFixture",
    host: { pid: process.pid, instanceId: "h".repeat(32), profile: "production", partition: "persist:codex-web-gpt-chatgpt" },
    lease: { helperPid: process.pid, surfaceId: "s".repeat(32), targetId: "original-target" },
    conversation: { key: "original-conversation", url: "https://chatgpt.com/c/original", claim: "11111111-1111-4111-8111-111111111111" },
    submission: { receipt: "[codex-submission:11111111-1111-4111-8111-111111111111]", initialTurnIdentities: [],
      acceptedUserIdentity: "original-user", assistantIdentity: "original-assistant", acceptedTurnIdentities: ["original-user", "original-assistant"] } };
  const journal = new OperationJournal(root);
  const saved: OperationRecord = { version: 1, operationId: checkpoint.identity.operationId, executionKey, traceId,
    ownerKey: `${chatGptQuestionAnswerNamespace(root)}:${chatGptThreadOwnershipKey(parsed)}`, threadId: root, turnId: "original-turn",
    requestIds: [], conversationKey: checkpoint.conversation.key, submission: "accepted", generation: "running",
    delivery: "detached", recovery: "none", seq: 1, attempt: 1, updatedAt: Date.now(), startedAt: Date.now(),
    rounds: { [roundKey]: { events: [], reasoning: [], completed: false } }, observation: checkpoint };
  journal.write(executionKey, saved);
  const widget: ChatGptChartWidget = { version: 1, kind: "cartesian_chart", id: "chart-1", mark: "bar",
    title: "Original chart", xField: "label", yField: "value", points: [{ x: "original", y: 1 }] };
  const worker = ChatGptBrowserWorker.forProvider(provider), originalRun = worker.run;
  let observations = 0;
  if (settled) {
    saved.richWidgets = [widget];
    const text = new ChatGptTextFeed(); text.push("Original answer");
    const session = chatGptTurnSessions.getOrCreate(executionKey, () => ({ mode: "read-only",
      operation: new DurableOperation(journal, saved), browser: Promise.resolve("Original answer"),
      physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text, richWidgets: [widget],
      submission: { phase: "accepted" }, cancel() {} }), traceId, saved.ownerKey);
    await session.browserOutcome;
  }
  worker.run = async turn => {
    observations++;
    expect(turn.observation).toEqual(checkpoint);
    expect(turn.deferTextUntilComplete === true).toBe(deferred);
    await expect(turn.prepare()).rejects.toThrow("observer cannot prepare");
    turn.onTextDelta("Original answer");
    turn.onRichWidgets?.([widget]);
    if (deferred) {
      // The chart is already private-durable before the worker can publish its final result.
      expect(journal.read<OperationRecord>(executionKey)!.richWidgets).toEqual([widget]);
      turn.onRichWidgets?.([structuredClone(widget)]);
      expect(() => turn.onRichWidgets?.([{ ...widget, title: "Changed original chart" }]))
        .toThrow("retained");
      expect(journal.read<OperationRecord>(executionKey)!.richWidgets).toEqual([widget]);
    }
    return "Original answer";
  };
  try {
    const adapter = createChatGptWebAdapter(provider);
    for (let attempt = 0; attempt < 2; attempt++) {
      const events: AdapterEvent[] = [];
      await adapter.runTurn(parsed, { headers: new Headers() }, event => events.push(event));
      expect(events.filter(event => event.type === "rich_widget"))
        .toEqual(deferred ? [{ type: "rich_widget", widget }] : []);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
    }
    expect(observations).toBe(settled ? 0 : 1);
    expect(journal.read<OperationRecord>(executionKey)!.generation).toBe("final");
  } finally {
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
  }
});
