import { expect, test } from "bun:test";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function controlledRuntime() {
  const browser = deferred<string>();
  const physical = deferred<void>();
  const cancellations: Array<Error | undefined> = [];
  const runtime: ChatGptTurnRuntime = {
    mode: "read-only", browser: browser.promise, physicalSettlement: physical.promise,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel(reason) { cancellations.push(reason); browser.reject(reason ?? new Error("cancelled")); },
  };
  return { runtime, browser, physical, cancellations };
}

test("detaching a response observer keeps its owner and counts cleanup after the final answer", async () => {
  const sessions = new ChatGptTurnSessions();
  const f = controlledRuntime();
  const session = sessions.getOrCreate("detached", () => f.runtime);
  const detach = session.observeRound("response", () => {});
  try {
    detach();
    expect(f.cancellations).toEqual([]);
    expect(sessions.find("detached")).toBe(session);
    f.browser.resolve("saved answer");
    await session.browserOutcome;
    expect(session.isActive()).toBeFalse();
    expect(sessions.activeCount()).toBe(1);
    let drained = false;
    const waiting = sessions.waitForPhysicalSettlement().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBeFalse();
    f.physical.resolve();
    await waiting;
    expect(sessions.activeCount()).toBe(0);
    expect(f.cancellations).toEqual([]);
  } finally { f.browser.resolve("cleanup"); f.physical.resolve(); sessions.clear(); }
});

test("cache expiry does not revoke a completed response before its helper exits", async () => {
  const sessions = new ChatGptTurnSessions(1);
  const f = controlledRuntime();
  const session = sessions.getOrCreate("expiring", () => f.runtime);
  try {
    f.browser.resolve("saved answer");
    await session.browserOutcome;
    await Bun.sleep(5);
    expect(sessions.activeCount()).toBe(1);
    expect(f.cancellations).toEqual([]);
    f.physical.resolve();
    await sessions.waitForPhysicalSettlement();
    expect(sessions.activeCount()).toBe(0);
  } finally { f.browser.resolve("cleanup"); f.physical.resolve(); sessions.clear(); }
});

test("native cancellation remains busy and same-key replacement waits for physical exit", async () => {
  const sessions = new ChatGptTurnSessions();
  const old = controlledRuntime(), next = controlledRuntime();
  const first = sessions.getOrCreate("same", () => old.runtime, "old-trace", "owner", "old-turn", "thread");
  try {
    const cancellation = sessions.cancelNativeTurn("thread", "old-turn", new Error("interrupted"));
    await first.browserOutcome;
    expect(cancellation.cancelled).toBe(1);
    expect(sessions.find("same")).toBeUndefined();
    expect(sessions.activeCount()).toBe(1);
    let starts = 0;
    const replacement = sessions.getOrCreateAfterOwnerRetirement("same", "owner", () => {
      starts += 1;
      return next.runtime;
    }, "new-trace", undefined, "new-turn", "thread");
    await Promise.resolve();
    expect(starts).toBe(0);
    old.physical.resolve();
    await cancellation.settlement;
    const current = await replacement;
    expect(starts).toBe(1);
    await Promise.resolve();
    expect(sessions.find("same")).toBe(current);
    expect(sessions.activeCount()).toBe(1);
    expect(old.cancellations).toHaveLength(1);
    expect(next.cancellations).toEqual([]);
    next.browser.resolve("replacement answer");
    next.physical.resolve();
    await sessions.waitForPhysicalSettlement();
    await current.browserOutcome;
    expect(sessions.activeCount()).toBe(0);
  } finally {
    old.browser.resolve("cleanup"); old.physical.resolve();
    next.browser.resolve("cleanup"); next.physical.resolve(); sessions.clear();
  }
});

test("clear keeps one physical retirement tracked even when called repeatedly", async () => {
  const sessions = new ChatGptTurnSessions();
  const f = controlledRuntime();
  const session = sessions.getOrCreate("clear", () => f.runtime);
  try {
    expect(sessions.clear()).toBe(1);
    await session.browserOutcome;
    expect(sessions.clear()).toBe(0);
    expect(sessions.activeCount()).toBe(1);
    expect(f.cancellations).toHaveLength(1);
    let drained = false;
    const waiting = sessions.waitForPhysicalSettlement().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBeFalse();
    f.physical.resolve();
    await waiting;
    expect(sessions.activeCount()).toBe(0);
  } finally { f.browser.resolve("cleanup"); f.physical.resolve(); sessions.clear(); }
});

test("a failed physical retirement is observed and drain still waits for the other helper", async () => {
  const sessions = new ChatGptTurnSessions();
  const failed = controlledRuntime(), remaining = controlledRuntime(), replacement = controlledRuntime();
  const first = sessions.getOrCreate("failed", () => failed.runtime, "failed-trace", "owner");
  const second = sessions.getOrCreate("remaining", () => remaining.runtime, "remaining-trace", "owner");
  try {
    sessions.clear();
    let drained = false;
    const waiting = sessions.waitForPhysicalSettlement().then(
      () => { drained = true; return undefined; },
      error => { drained = true; return error; },
    );
    const failure = new Error("helper cleanup failed");
    failed.physical.reject(failure);
    await first.physicalSettlement.catch(() => {});
    await Promise.resolve();
    expect(sessions.activeCount()).toBe(1);
    expect(drained).toBeFalse();
    let starts = 0;
    const admitted = sessions.getOrCreateAfterOwnerRetirement("new", "owner", () => {
      starts += 1;
      return replacement.runtime;
    }).then(session => ({ session }), error => ({ error }));
    // Let any rejection cleanup run: neither failure nor its observers may open the fence early.
    await Bun.sleep(0);
    expect(starts).toBe(0);
    remaining.physical.resolve();
    const admission = await admitted;
    expect(admission).toHaveProperty("error");
    const current = await sessions.getOrCreateAfterOwnerRetirement("new", "owner", () => {
      starts += 1;
      return replacement.runtime;
    });
    expect(starts).toBe(1);
    replacement.browser.resolve("cleanup"); replacement.physical.resolve();
    await current.browserOutcome;
    const error = await waiting;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure]);
    await Promise.all([first.browserOutcome, second.browserOutcome]);
    expect(sessions.activeCount()).toBe(0);
    await sessions.waitForRetirement("failed");
    await sessions.waitForRetirement("remaining");
  } finally {
    failed.browser.resolve("cleanup"); failed.physical.resolve();
    remaining.browser.resolve("cleanup"); remaining.physical.resolve();
    replacement.browser.resolve("cleanup"); replacement.physical.resolve(); sessions.clear();
  }
});

test.each(["clear", "conversation"] as const)("a failed helper keeps the retained conversation fenced until every exit (%s)", async mode => {
  const sessions = new ChatGptTurnSessions();
  const failed = controlledRuntime(), remaining = controlledRuntime();
  failed.runtime.conversationKey = remaining.runtime.conversationKey = "retained";
  const first = sessions.getOrCreate("failed", () => failed.runtime);
  sessions.getOrCreate("remaining", () => remaining.runtime);
  try {
    let settled = false;
    if (mode === "clear") sessions.clear();
    const retirement = mode === "clear"
      ? sessions.waitForConversationRetirement("retained")
      : sessions.retireConversationAndWait("retained");
    const waiting = retirement.then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; },
    );
    failed.physical.reject(new Error("helper cleanup failed"));
    await first.physicalSettlement.catch(() => {});
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    expect(sessions.activeCount()).toBe(1);
    remaining.physical.resolve();
    expect(await waiting).toBeInstanceOf(AggregateError);
    await sessions.waitForConversationRetirement("retained");
    expect(sessions.activeCount()).toBe(0);
  } finally {
    failed.browser.resolve("cleanup"); failed.physical.resolve();
    remaining.browser.resolve("cleanup"); remaining.physical.resolve(); sessions.clear();
  }
});

test.each([false, true])("legacy runtime without physicalSettlement exits with browser settlement (failed=%s)", async failed => {
  const sessions = new ChatGptTurnSessions();
  const f = controlledRuntime();
  const legacy = { ...f.runtime } as Partial<ChatGptTurnRuntime>;
  delete legacy.physicalSettlement;
  const session = sessions.getOrCreate("legacy", () => legacy as ChatGptTurnRuntime);
  try {
    expect(sessions.activeCount()).toBe(1);
    if (failed) f.browser.reject(new Error("browser failed"));
    else f.browser.resolve("done");
    await session.browserOutcome;
    await sessions.waitForPhysicalSettlement();
    expect(sessions.activeCount()).toBe(0);
  } finally { f.browser.resolve("cleanup"); f.physical.resolve(); sessions.clear(); }
});

test("capacity is not released by a final answer while all five helpers still run", async () => {
  const sessions = new ChatGptTurnSessions();
  const fixtures = Array.from({ length: 5 }, controlledRuntime);
  const existing = fixtures.map((f, index) => sessions.getOrCreate(`turn-${index}`, () => f.runtime));
  const replacement = controlledRuntime();
  try {
    fixtures.forEach(f => f.browser.resolve("done"));
    await Promise.all(existing.map(session => session.browserOutcome));
    expect(sessions.activeCount()).toBe(5);
    let starts = 0;
    const start = () => { starts += 1; return replacement.runtime; };
    expect(() => sessions.getOrCreate("replacement", start)).toThrow("at most 5 simultaneous browser turns");
    expect(starts).toBe(0);
    fixtures[0]!.physical.resolve();
    await existing[0]!.physicalSettlement;
    expect(sessions.getOrCreate("replacement", start)).toBeDefined();
    expect(starts).toBe(1);
    expect(sessions.activeCount()).toBe(5);
  } finally {
    fixtures.forEach(f => { f.browser.resolve("cleanup"); f.physical.resolve(); });
    replacement.browser.resolve("cleanup"); replacement.physical.resolve(); sessions.clear();
    await sessions.waitForPhysicalSettlement();
  }
});
