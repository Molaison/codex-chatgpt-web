import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { operationDigest, OperationJournal, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import { parseBrowserObservation } from "../src/adapters/chatgpt-web/observation-recovery";
import { nativeSubmissionDigest, submissionIdentityUnproven, type NativeSubmissionRecord } from "../src/adapters/chatgpt-web/submission-identity";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { NativeReleaseReceipt, NativeResultReady } from "../src/adapters/chatgpt-web/native-execution";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

async function recover(scenario: "helper_exit" | "durable_ready" | "permission") {
  const directory = mkdtempSync(join(tmpdir(), "native-observation-recovery-"));
  const descriptor = join(directory, "launcher.json"), helper = join(directory, "helper.cjs");
  let release: NativeReleaseReceipt | undefined, completed: NativeSubmissionRecord | undefined;
  let completeRequests = 0;
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any;
    if (body.phase === "observe-complete") {
      completeRequests++;
      expect(body.helperPid).toBe(process.pid);
      expect(body.receipt.record).toEqual(completed);
      release = releaseFor(completed!);
    }
    return Response.json({ ok: true, nativeRelease: release ?? null });
  } });
  writeFileSync(helper, "// fixture only\n");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production", pid: process.pid, endpoint: `http://127.0.0.1:${host.port}`,
    control: { endpoint: `http://127.0.0.1:${host.port}`, token: "c".repeat(43) },
    helper: { executable: process.execPath, script: helper }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "s".repeat(32), surfaceTargets: { ["s".repeat(32)]: "original-target" },
    createdAt: new Date().toISOString(), observationInstanceId: "h".repeat(32),
  }), { mode: 0o600 });
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://${directory}`,
    chatgptWeb: { accountId: "account-original", appName: "ObservationRegression", browserHost: "launcher",
      browserHostDescriptorPath: descriptor, localToolsEnabled: false,
      threadEnvironmentStatePath: join(directory, "environment.json"), brokerSocketPath: join(directory, "broker.sock") } };
  const turnId = randomUUID(), threadId = randomUUID();
  const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "low" },
    context: { messages: [{ role: "user", content: "Original question", timestamp: 0 }] },
    _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
      input: [{ type: "message", role: "user", content: "Original question", internal_chat_message_metadata_passthrough: { turn_id: turnId } }] } };
  const key = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
  const journal = new OperationJournal(directory);
  const worker = ChatGptBrowserWorker.forProvider(provider), originalRun = worker.run;
  let sends = 0, runs = 0;
  const events: AdapterEvent[] = [];
  function releaseFor(slot: NativeSubmissionRecord): NativeReleaseReceipt {
    return { version: 1, releaseId: randomUUID(), sendId: slot.sendId, roundKey: slot.binding!.roundKey,
      sessionEpoch: slot.hostWatch!.sessionEpoch, host: slot.binding!.host, lease: slot.binding!.lease,
      documentEpoch: slot.binding!.documentEpoch!, outcome: "completed", terminalDigest: nativeSubmissionDigest(slot) };
  }
  async function finish(turn: BrowserTurn, slot: NativeSubmissionRecord, physicalRelease: boolean) {
    completed = { ...slot, revision: 5, phase: "completed", completion: { proof: "same-bound-assistant-completed",
      assistantIdentity: slot.dom!.assistantIdentity, userMessageId: slot.post!.userMessageId,
      payloadSha256: slot.post!.payloadSha256, watchSeq: slot.hostWatch!.seq, observedAt: Date.now() } };
    await turn.onNativeSubmission!(completed);
    const ready: NativeResultReady = { version: 1, scope: turn.nativeOperationScope!, sendId: slot.sendId,
      completedDigest: nativeSubmissionDigest(completed), answer: "Original answer",
      answerSha256: operationDigest("Original answer"), readyAt: Date.now() };
    await turn.onNativeResultReady!(ready);
    if (physicalRelease) {
      release = releaseFor(completed);
      await turn.onNativeRelease!(release);
    }
  }
  worker.run = async turn => {
    runs++;
    if (turn.observation) {
      expect(scenario).toBe("helper_exit");
      expect(turn.nativeSubmissionIdentity).toBe(true);
      expect(turn.nativeObservationSubmission).toEqual(turn.observation.submission.native);
      expect(turn.nativeOperationScope).toEqual(journal.read<OperationRecord>(key)!.nativeScope);
      await expect(turn.prepare()).rejects.toThrow("observer cannot prepare");
      turn.onObservationResumed?.();
      turn.onTextDelta("Original answer");
      await finish(turn, turn.nativeObservationSubmission!, true);
      return "Original answer";
    }
    await turn.prepare();
    await turn.onSendActivated!(); sends++;
    const t = Date.now() - 100, id = randomUUID();
    const binding: any = { roundKey: turn.nativeSubmissionRoundKey, stage: { kind: "final" }, documentEpoch: null,
      host: { pid: process.pid, instanceId: "h".repeat(32), profile: "production", partition: "persist:codex-web-gpt-chatgpt" },
      lease: { helperPid: process.pid, surfaceId: "s".repeat(32), targetId: "original-target" } };
    let slot: NativeSubmissionRecord = { version: 1, sendId: randomUUID(), revision: 1, phase: "send_activated", initialTurnIdentities: [], binding };
    await turn.onNativeSubmission!(slot);
    const watch: any = { version: 1, traceId: turn.traceId, sendId: slot.sendId, currentSendId: slot.sendId,
      binding: { ...binding, documentEpoch: "original-document" }, segmentState: "watching", totalPostCount: 0,
      segments: [], latePosts: [], host: binding.host, lease: binding.lease, sessionEpoch: randomUUID(),
      documentEpoch: "original-document", mainFrame: { frameId: "frame", loaderId: "loader" }, seq: 1,
      active: true, gap: false, gapReasons: [], conflict: false, conflictReasons: [], postCount: 0,
      identities: [], startedAt: t, readAt: t, initialConversationId: null, boundConversationId: null,
      flush: { stable: true, pending: 0, throughSeq: 1 } };
    slot = { ...slot, revision: 2, phase: "watch_ready", binding: watch.binding, hostWatch: watch };
    await turn.onNativeSubmission!(slot);
    const post: any = { userMessageId: id, payloadSha256: operationDigest("original actual bytes"),
      action: { presence: "value", value: "next" }, parentMessageId: { presence: "value", value: "original-root" },
      conversationId: { presence: "absent" }, observedAt: t + 1 };
    slot = { ...slot, revision: 3, phase: "post_observed", post, hostWatch: { ...watch, seq: 2, postCount: 1, totalPostCount: 1,
      identities: [{ ...post, ordinal: 1, watchOrdinal: 1, endpoint: "/backend-api/f/conversation", requestId: "original-request", frameId: "frame", loaderId: "loader" }],
      flush: { stable: true, pending: 0, throughSeq: 2 } } };
    await turn.onNativeSubmission!(slot);
    const identities = [`group:user:${id}`, `group:assistant:${id}`];
    slot = { ...slot, revision: 4, phase: "accepted", dom: { acceptedUserIdentity: identities[0]!, assistantIdentity: identities[1]!,
      acceptedTurnIdentities: identities, proof: "same-bound-assistant-progress", observedAt: t + 2 } };
    await turn.onNativeSubmission!(slot);
    await turn.onObservationReady!(parseBrowserObservation({ version: 2, identity: turn.observationIdentity!,
      traceId: turn.traceId, modelId: parsed.modelId, accountId: "account-original", appName: "ObservationRegression",
      host: binding.host, lease: binding.lease, conversation: { key: turn.conversationKey!, url: "https://chatgpt.com/c/original", claim: randomUUID() },
      submission: { native: slot, initialTurnIdentities: [], acceptedUserIdentity: identities[0]!,
        assistantIdentity: identities[1]!, acceptedTurnIdentities: identities } }));
    await turn.onSubmitted!();
    turn.onTextDelta("Original");
    if (scenario === "durable_ready") await finish(turn, slot, false);
    if (scenario === "permission") throw new ChatGptWebAdapterError("permission required", {
      status: 403, errorType: "permission_error", code: "chatgpt_tool_approval_required", retryable: false,
    });
    throw submissionIdentityUnproven("helper exited while original browser ownership is unresolved");
  };
  try {
    await createChatGptWebAdapter(provider).runTurn(parsed, { headers: new Headers() }, event => events.push(event));
    const session = chatGptTurnSessions.findPhysicalOwner(key)!;
    if (scenario === "permission") {
      expect(runs).toBe(1);
      expect(events.find(event => event.type === "error")).toMatchObject({ code: "chatgpt_tool_approval_required" });
      expect(journal.read<OperationRecord>(key)!.nativeRelease).toBeUndefined();
      return;
    }
    await session.waitForPhysicalSettlement();
    expect(sends).toBe(1);
    expect(runs).toBe(scenario === "helper_exit" ? 2 : 1);
    expect(completeRequests).toBe(scenario === "durable_ready" ? 1 : 0);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events.flatMap(event => event.type === "text_delta" && event.phase === "final_answer" ? [event.text] : []).join("")).toBe("Original answer");
    expect(journal.read<OperationRecord>(key)!.nativeRelease).toEqual(release);
    expect(journal.unresolvedOwner(journal.read<OperationRecord>(key)!.ownerKey!, "next")).toBeUndefined();
  } finally {
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await host.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepted helper death resumes original Native generation inside the same response", () => recover("helper_exit"));
test("durable final after helper death finishes Host release without another browser run", () => recover("durable_ready"));
test("Native observation recovery preserves explicit permission failures", () => recover("permission"));
