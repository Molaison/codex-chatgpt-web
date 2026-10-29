import { expect, test } from "bun:test";
import {
  CHATGPT_COMPLETION_SETTLE_MS,
  ChatGptBrowserWorker,
  ChatGptCompletionTracker,
  chatGptCompletionPollDelayMs,
  chatGptCompletionStableMs,
} from "../src/adapters/chatgpt-web/browser-worker";

const complete = {
  responsePresent: true, running: false, currentText: "complete answer",
  currentHtml: "<p>complete answer</p>", completionActionVisible: true,
};

test("perf Instant settles at 150 ms while Pro retains the original window", () => {
  expect(chatGptCompletionStableMs("low")).toBe(150);
  expect(chatGptCompletionStableMs("low", true)).toBe(CHATGPT_COMPLETION_SETTLE_MS);
  expect(chatGptCompletionStableMs("max")).toBe(CHATGPT_COMPLETION_SETTLE_MS);
  const tracker = new ChatGptCompletionTracker(chatGptCompletionStableMs("low"));
  expect(tracker.update(complete, 1_000)).toBe(false);
  expect(tracker.update(complete, 1_149)).toBe(false);
  expect(tracker.update(complete, 1_150)).toBe(true);
  expect(chatGptCompletionPollDelayMs(tracker, true, 1_149)).toBe(250);
  expect(chatGptCompletionPollDelayMs(tracker, false, 1_149)).toBe(1);
  expect(chatGptCompletionPollDelayMs(new ChatGptCompletionTracker(150), false)).toBe(50);
});

test("perf settling cannot cross live tools or reuse the pre-tool answer", () => {
  const tracker = new ChatGptCompletionTracker(150);
  expect(tracker.update(complete, 1_000)).toBe(false);
  expect(tracker.update({ ...complete, externalToolCallsInFlight: true }, 2_000)).toBe(false);
  expect(tracker.update(complete, 3_000)).toBe(false);
  expect(tracker.observeToolBatch(1, complete.currentText)).toBe(true);
  expect(tracker.update(complete, 9_000)).toBe(false);
  const fresh = { ...complete, currentText: "answer after tool", currentHtml: "<p>answer after tool</p>" };
  expect(tracker.update(fresh, 10_000)).toBe(false);
  expect(tracker.update(fresh, 10_150)).toBe(true);
});

test("perf completion still requires a non-running bound answer and visible action", () => {
  for (const override of [
    { responsePresent: false }, { running: true }, { completionActionVisible: false },
    { pendingImages: true }, { currentText: "" },
    { responseStreamActive: true },
  ]) {
    const tracker = new ChatGptCompletionTracker(150);
    expect(tracker.update({ ...complete, ...override }, 1_000)).toBe(false);
    expect(tracker.update({ ...complete, ...override }, 3_000)).toBe(false);
  }
});

test("perf telemetry records resets, elapsed stages, and selected wait without changing result", () => {
  const tracker = new ChatGptCompletionTracker(150);
  const start = tracker.settlementTelemetry().turnStartedAt;
  tracker.update({ ...complete, running: true }, start + 10);
  tracker.update(complete, start + 100);
  tracker.update({ ...complete, running: true }, start + 120);
  tracker.update(complete, start + 200);
  tracker.recordSettlementDelay(50, false);
  expect(tracker.update(complete, start + 350)).toBe(true);
  expect(tracker.settlementTelemetry(start + 350)).toMatchObject({
    responseVisibleMs: 10, eligibleMs: 100, candidateMs: 100, lastCandidateMs: 200,
    stabilityResetCount: 1, finalStableMs: 150, finalPollMs: 50, lastScheduledDelayMs: 50,
    externalProgressFinal: false, responseVisibleToEligibleMs: 90,
    finalCandidateToTurnCompletedMs: 150,
  });
  expect(() => tracker.recordSettlementDelay(-1, false)).toThrow("Invalid completion settlement delay");
});

test("perf low presend keeps cheap selection proof but Pro still verifies family", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype);
  const checks: boolean[] = [];
  worker.assertSelectedEffort = async (_page: unknown, _mode: unknown, verifyFamily: boolean) => {
    checks.push(verifyFamily);
  };
  const mode = { effort: "low" };
  await worker.reconcileSelectedEffortBeforeSend({}, mode, () => { throw new Error("unexpected reselection"); });
  await worker.reconcileSelectedEffortBeforeSend({}, mode, () => { throw new Error("unexpected reselection"); }, undefined, true);
  expect(checks).toEqual([false, true]);
});

test("perf cached composer insertion and verification skip rediscovery while preserving text", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype);
  worker.activeComposer = () => { throw new Error("unexpected composer rediscovery"); };
  let writes = 0;
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, text?: string) => {
      if (text !== undefined) { expect(text).toBe("full prompt"); writes += 1; return true; }
      return "full prompt";
    },
  };
  await worker.insertPromptText({}, "full prompt", undefined, composer);
  await worker.assertPromptAttached({}, "full prompt", undefined, composer);
  expect(writes).toBe(1);
});
