import { expect, test } from "bun:test";
import { ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptCompletionPollDelayMs } from "../src/adapters/chatgpt-web/browser-worker";

const complete = { responsePresent: true, running: false, currentText: "1", currentHtml: "<p>1</p>", completionActionVisible: true };

test("completion polling waits exactly to the candidate boundary without a 250ms intermediate read", () => {
  for (const stableMs of [500, 1000]) {
    const tracker = new ChatGptCompletionTracker(stableMs);
    expect(chatGptCompletionPollDelayMs(tracker, false, 0)).toBe(100);
    expect(chatGptCompletionPollDelayMs(tracker, true, 0)).toBe(250);
    expect(tracker.update(complete, 0)).toBeFalse();
    expect(chatGptCompletionPollDelayMs(tracker, false, 0)).toBe(stableMs);
    expect(chatGptCompletionPollDelayMs(tracker, false, stableMs - 1)).toBe(1);
    expect(tracker.update(complete, stableMs - 1)).toBeFalse();
    expect(chatGptCompletionPollDelayMs(tracker, false, stableMs)).toBe(0);
    expect(tracker.update(complete, stableMs)).toBeTrue();
    // A DOM projection already in flight can race a tool batch: tool cadence wins.
    expect(chatGptCompletionPollDelayMs(tracker, true, stableMs)).toBe(250);
    tracker.observeToolBatch(1, complete.currentText);
    expect(chatGptCompletionPollDelayMs(tracker, false, stableMs)).toBe(100);
    expect(tracker.update(complete, stableMs + 100)).toBeFalse();
  }
});

test("completed receipts from the old page do not turn a replacement's existing final1 into a pre-tool baseline", () => {
  const tracker = new ChatGptCompletionTracker(500, 1000, 7);
  expect(tracker.needsToolBatchObservation(7)).toBe(false);
  expect(tracker.nextStabilityDelayMs(0)).toBeUndefined();
  expect(tracker.update(complete, 0)).toBe(false);
  expect(tracker.nextStabilityDelayMs(0)).toBe(500);
  expect(tracker.nextStabilityDelayMs(499)).toBe(1);
  expect(tracker.nextStabilityDelayMs(500)).toBe(0);
  expect(tracker.update(complete, 500)).toBe(true);
  // A genuinely new tool batch still requires fresh post-tool output, not the existing final.
  expect(tracker.observeToolBatch(8, "1")).toBe(true);
  expect(tracker.update(complete, 501)).toBe(false);
  expect(() => tracker.update(complete, 1502)).toThrow("without producing a final answer");
});

test("normal tool completion, live work and invalid page revisions keep their original fences", () => {
  const normal = new ChatGptCompletionTracker(500, 1000);
  expect(normal.needsToolBatchObservation(1)).toBe(true);
  normal.observeToolBatch(1, "1");
  expect(normal.update(complete, 0)).toBe(false);
  expect(() => normal.update(complete, 1001)).toThrow("without producing a final answer");
  const recovery = new ChatGptCompletionTracker(500, 1000, 1);
  expect(recovery.update({ ...complete, externalToolCallsInFlight: true }, 0)).toBe(false);
  expect(recovery.update({ ...complete, running: true }, 1000)).toBe(false);
  expect(() => new ChatGptCompletionTracker(500, 1000, -1)).toThrow();
});
