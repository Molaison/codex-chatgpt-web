import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { OperationJournal, operationDigest, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import { parseBrowserObservation, type BrowserObservationCheckpoint } from "../src/adapters/chatgpt-web/observation-recovery";
import type { NativeSubmissionRecord } from "../src/adapters/chatgpt-web/submission-identity";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

type Scenario = "fresh" | "recovery" | "resume" | "restored-after-prepare" | "metadata-only" | "before-send-failure" | "accepted-without-checkpoint" | "checkpoint-before-accept-failure" | "wrong-round" | "first";
let sequence = 0;

async function fixture(full: boolean, scenario: Scenario) {
  const home = join(import.meta.dir, "..", ".recovery-check-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(home, "fork-notice-"));
  const fd = openSync(root, "r");
  const socket = `/proc/self/fd/${fd}/fork${sequence++}.sock`;
  const descriptor = join(root, "launcher.json"), helper = join(root, "helper.cjs");
  const nativeAcceptanceFailure = !full && scenario === "checkpoint-before-accept-failure";
  // This scenario deliberately retains a physical Native owner beyond fixture cleanup.
  const accountId = nativeAcceptanceFailure ? `account-${randomUUID()}` : "account-2";
  writeFileSync(helper, "// fixture only; never started\n");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production", pid: process.pid, endpoint: "http://127.0.0.1:9",
    control: { endpoint: "http://127.0.0.1:10", token: "c".repeat(43) },
    helper: { executable: process.execPath, script: helper }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "s".repeat(32), surfaceTargets: { ["s".repeat(32)]: "fixture-target" },
    createdAt: new Date().toISOString(), observationInstanceId: "h".repeat(32),
  }), { mode: 0o600 });
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "browser://" + root,
    chatgptWeb: { accountId, appName: "Recovery42", browserHost: "launcher",
      browserHostDescriptorPath: descriptor, localToolsEnabled: full,
      threadEnvironmentStatePath: join(root, "environment.json"), brokerSocketPath: socket } };
  const thread = "child-" + randomUUID(), turnId = "turn-" + randomUUID();
  const environment = `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "low" },
    context: { systemPrompt: [], tools: full ? [{ name: "exec_command", description: "fixture, never invoked", parameters: { type: "object", properties: {} } }] : [],
      messages: [{ role: "user", content: "Inherited parent question", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Inherited parent answer" }], timestamp: 2 },
        { role: "user", content: "A new child question", timestamp: 3 }] },
    _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turnId,
      ...(scenario !== "first" ? { forked_from_thread_id: "parent-original" } : {}), sandbox: "none", workspaces: { [root]: {} } }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: turnId } },
        { type: "message", role: "user", content: "A new child question", internal_chat_message_metadata_passthrough: { turn_id: turnId } }] } };
  const key = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
  const store = new OperationJournal(root);
  const read = () => store.read<OperationRecord>(key)!;
  const events: AdapterEvent[] = [];
  const forkCount = () => events.filter(e => e.type === "provider_notice" && e.notice.kind === "conversation_forked").length;
  const worker = ChatGptBrowserWorker.forProvider(provider), originalRun = worker.run;
  const broker = TurnBroker.forSocket(socket);
  let sends = 0, freshPreparations = 0, resumePreparations = 0;
  worker.run = async browserTurn => {
    expect(browserTurn.observationIdentity).toBeDefined();
    if (scenario === "metadata-only") throw new Error("fixture rejected before preparation");
    let prompt = scenario === "resume" ? await browserTurn.prepareResume!() : await browserTurn.prepare();
    if (scenario === "resume") resumePreparations++; else freshPreparations++;
    if (scenario === "recovery") {
      expect(await browserTurn.authorizeRecovery!()).toBeTrue();
      prompt = await browserTurn.prepare(); freshPreparations++;
    }
    expect(prompt.text).not.toContain("已观察到独立的新会话分支");
    if (scenario === "before-send-failure") throw new Error("fixture failed before Send");
    if (scenario === "resume" || scenario === "restored-after-prepare") browserTurn.onConversationRestored?.();
    await browserTurn.onSendActivated?.(); sends++;
    const host = { pid: process.pid, instanceId: "h".repeat(32), profile: "production", partition: "persist:codex-web-gpt-chatgpt" };
    const lease = { helperPid: process.pid, surfaceId: "s".repeat(32), targetId: "fixture-target" };
    let native: NativeSubmissionRecord | undefined;
    if (nativeAcceptanceFailure) {
      // Ordinary QA durably binds its original Send before observing a v2 checkpoint.
      // onSendActivated alone is only preparation validation under that contract.
      expect(browserTurn.nativeSubmissionIdentity).toBeTrue();
      const observedAt = Date.now() - 100, userMessageId = randomUUID();
      const binding: NonNullable<NativeSubmissionRecord["binding"]> = {
        roundKey: browserTurn.nativeSubmissionRoundKey!, stage: { kind: "final" }, documentEpoch: null, host, lease,
      };
      native = { version: 1, sendId: randomUUID(), revision: 1, phase: "send_activated", initialTurnIdentities: [], binding };
      await browserTurn.onNativeSubmission!(native);
      const watch: NonNullable<NativeSubmissionRecord["hostWatch"]> = {
        version: 1, scope: browserTurn.nativeOperationScope!, traceId: browserTurn.traceId,
        sendId: native.sendId, currentSendId: native.sendId,
        binding: { ...binding, documentEpoch: "fork-document" }, segmentState: "watching", totalPostCount: 0,
        segments: [], latePosts: [], host, lease, sessionEpoch: randomUUID(), documentEpoch: "fork-document",
        mainFrame: { frameId: "frame", loaderId: "loader" }, seq: 1, active: true,
        gap: false, gapReasons: [], conflict: false, conflictReasons: [], postCount: 0, identities: [],
        startedAt: observedAt, readAt: observedAt, initialConversationId: null, boundConversationId: null,
        flush: { stable: true, pending: 0, throughSeq: 1 },
      };
      native = { ...native, revision: 2, phase: "watch_ready", binding: watch.binding!, hostWatch: watch };
      await browserTurn.onNativeSubmission!(native);
      const post: NonNullable<NativeSubmissionRecord["post"]> = {
        userMessageId, payloadSha256: operationDigest(prompt.text), action: { presence: "value", value: "next" },
        parentMessageId: { presence: "value", value: "fork-root" }, conversationId: { presence: "absent" }, observedAt: observedAt + 1,
      };
      native = { ...native, revision: 3, phase: "post_observed", post,
        hostWatch: { ...watch, seq: 2, postCount: 1, totalPostCount: 1,
          identities: [{ ...post, ordinal: 1, watchOrdinal: 1, endpoint: "/backend-api/f/conversation",
            requestId: "fork-request", frameId: "frame", loaderId: "loader" }],
          flush: { stable: true, pending: 0, throughSeq: 2 } } };
      await browserTurn.onNativeSubmission!(native);
      const acceptedUserIdentity = `group:user:${userMessageId}`, assistantIdentity = `group:assistant:${userMessageId}`;
      native = { ...native, revision: 4, phase: "accepted", dom: { acceptedUserIdentity, assistantIdentity,
        acceptedTurnIdentities: [acceptedUserIdentity, assistantIdentity], proof: "same-bound-assistant-progress", observedAt: observedAt + 2 } };
      await browserTurn.onNativeSubmission!(native);
    }
    const checkpoint = parseBrowserObservation({ version: native ? 2 : 1,
      identity: { ...browserTurn.observationIdentity!, ...(scenario === "wrong-round" ? { roundKey: "wrong-round" } : {}) },
      traceId: browserTurn.traceId, modelId: parsed.modelId, accountId, appName: "Recovery42", host, lease,
      conversation: { key: browserTurn.conversationKey!, url: "https://chatgpt.com/c/accepted-child", claim: randomUUID() },
      ...(full ? { toolChannel: { tokenHash: operationDigest(prompt.turnToken!) } } : {}),
      submission: native ? { native, initialTurnIdentities: [],
        acceptedUserIdentity: native.dom!.acceptedUserIdentity, assistantIdentity: native.dom!.assistantIdentity,
        acceptedTurnIdentities: native.dom!.acceptedTurnIdentities }
        : { receipt: `[codex-submission:${randomUUID()}]`, initialTurnIdentities: [],
          acceptedUserIdentity: "group:user:child", assistantIdentity: "group:assistant:child",
          acceptedTurnIdentities: ["group:user:child", "group:assistant:child"] },
    } satisfies BrowserObservationCheckpoint);
    if (scenario !== "accepted-without-checkpoint") {
      await browserTurn.onObservationReady?.(checkpoint);
      expect(read().observation).toEqual(checkpoint);
      expect(forkCount()).toBe(0);
    }
    if (scenario === "checkpoint-before-accept-failure") throw new Error("fixture rejected before acceptance publication");
    await browserTurn.onSubmitted?.();
    const expected = scenario === "fresh" ? 1 : 0;
    expect(forkCount()).toBe(expected);
    if (scenario === "recovery") {
      browserTurn.onConversationRecovered?.();
      expect(forkCount()).toBe(1);
    }
    expect(read().submission).toBe("accepted");
    if (scenario === "fresh") {
      expect(read().forkNoticeEmitted).toBeTrue();
      await browserTurn.onObservationReady?.(checkpoint);
      await browserTurn.onSubmitted?.();
      expect(forkCount()).toBe(1);
    }
    browserTurn.onTextDelta("Fixture final text");
    return "Fixture final text";
  };
  try {
    const execute = createChatGptWebAdapter(provider, { broker }).runTurn(parsed, { headers: new Headers() }, event => events.push(event));
    if (["metadata-only", "before-send-failure"].includes(scenario)) await expect(execute).rejects.toThrow();
    else await execute;
    if (scenario === "checkpoint-before-accept-failure") {
      expect(events.some(event => event.type === "error" && event.code === "chatgpt_submission_ambiguous")).toBeTrue();
      expect(read().generation).toBe("unknown");
      expect(read().recovery).toBe("retained");
      if (nativeAcceptanceFailure) {
        expect(read().nativeSubmissions?.at(-1)?.phase).toBe("accepted");
        expect(read().submission).toBe("send_activated");
      }
    }
    if (["accepted-without-checkpoint", "wrong-round"].includes(scenario)) {
      expect(events.some(event => event.type === "error")).toBeFalse();
      expect(read().generation).toBe("final");
    }
    expect(forkCount()).toBe(scenario === "fresh" || scenario === "recovery" ? 1 : 0);
    expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
    expect(events.some(event => event.type === "provider_notice" && event.notice.kind === "account_changed")).toBeFalse();
    expect(Object.values(read().rounds).every(round => round.events.every(event => event.type !== "provider_notice"))).toBeTrue();
    expect(JSON.stringify(parsed)).not.toContain("已观察到独立的新会话分支");
    expect(sends).toBe(["metadata-only", "before-send-failure"].includes(scenario) ? 0 : 1);
    expect(freshPreparations + resumePreparations).toBe(scenario === "metadata-only" ? 0 : scenario === "recovery" ? 2 : 1);
  } finally {
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close(); closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const full of [false, true]) {
  test(`a recovered native-fork branch reports one recovery fork, not another explicit fork (${full ? "Full" : "QA"})`, () => fixture(full, "recovery"));
  test(`explicit accepted fresh fork emits once outside history (${full ? "Full" : "QA"})`, () => fixture(full, "fresh"));
  test(`fork metadata on first/resume/restore never invents a fresh fork (${full ? "Full" : "QA"})`, async () => {
    for (const scenario of ["first", "resume", "restored-after-prepare"] as const) await fixture(full, scenario);
  });
  test(`fork metadata and failed or uncheckpointed submission emit no fork (${full ? "Full" : "QA"})`, async () => {
    for (const scenario of ["metadata-only", "before-send-failure", "accepted-without-checkpoint", "checkpoint-before-accept-failure", "wrong-round"] as const) await fixture(full, scenario);
  });
}
