import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

const user = "group:user:accepted";
const assistant = "group:assistant:accepted";
const original = "group:assistant:temporary";
function observation(users: string[], responses: string[], turns = [...users, ...responses]) {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const binding = { identity: original, acceptedTurnIdentities: [original], locator: { count: async () => 0 } };
  worker.submissionDomState = async () => ({ userIdentities: users, responseIdentities: responses, turnIdentities: turns });
  worker.reconcileMultipartHistory = async () => {};
  const page = { locator: () => ({ count: async () => 1 }) };
  const baseline: any = { initialTurnIdentities: [], acceptedUserIdentity: user, domCache: {} };
  return { binding, worker, baseline, reconcile: () => worker.reconcileAssistantTurnBinding(page, baseline, binding) };
}

test("acknowledged user-only tool-confirmation frame waits without changing binding", async () => {
  const value = observation([user], []);
  expect(await value.reconcile()).toBe(value.binding);
});
test("foreign user-only frame remains rejected", async () => {
  await expect(observation(["group:user:foreign"], []).reconcile()).rejects.toThrow("opened another user turn");
});
test("acknowledged user with competing user remains rejected", async () => {
  await expect(observation([user, "group:user:foreign"], []).reconcile()).rejects.toThrow("opened another user turn");
});
test("acknowledged user with foreign assistant remains rejected", async () => {
  await expect(observation([user], ["group:assistant:foreign"]).reconcile()).rejects.toThrow("opened another user turn");
});
test("inconsistent surviving old group is not treated as the transient frame", async () => {
  await expect(observation([user], [], [user, original]).reconcile()).rejects.toThrow("opened another user turn");
});
test("assistant remount for the exact acknowledged user still rebinds normally", async () => {
  const value = await observation([user], [assistant]).reconcile();
  expect(value.identity).toBe(assistant);
});

test("real grouped DOM retains both logical roles while only the acknowledged user is rendered", async () => {
  const value = observation([user], [], [user, assistant]);
  expect(await value.reconcile()).toBe(value.binding);
});

function assistantBeforeUser(abortOnWait = false) {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const controller = new AbortController();
  const empty: any = { filter: () => empty, last: () => empty, isVisible: async () => false };
  const page = { isClosed: () => false, locator: () => empty };
  const baseline: any = { initialTurnIdentities: [], domCache: {} };
  let reads = 0;
  let waits = 0;
  worker.submissionDomState = async () => {
    reads += 1;
    const hydrated = reads > 1 && !abortOnWait;
    return { turnIdentities: [user, assistant], userIdentities: hydrated ? [user] : [],
      responseIdentities: [assistant], visibleStopButtonCount: 1 };
  };
  worker.reconcileMultipartHistory = async () => {};
  worker.waitForTurnDomOrExternalProgress = async () => {
    waits += 1;
    if (abortOnWait) controller.abort();
  };
  return { baseline, waits: () => waits,
    run: (requireUser: boolean) => worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000,
      controller.signal, undefined, 1000, undefined, undefined,
      { active: () => true, progress: () => {} }, requireUser) };
}
test("durable observation waits for the accepted user witness after an early assistant placeholder", async () => {
  const value = assistantBeforeUser();
  const binding = await value.run(true);
  expect(value.waits()).toBe(1);
  expect(value.baseline.acceptedUserIdentity).toBe(user);
  expect(binding.identity).toBe(assistant);
});
test("existing non-observer usage still returns an early assistant without a new prerequisite", async () => {
  const value = assistantBeforeUser();
  expect((await value.run(false)).identity).toBe(assistant);
  expect(value.waits()).toBe(0);
});
test("HTTP acceptance binds native identity only after the submitted user is visible", async () => {
  const value = assistantBeforeUser();
  let phase = "post_observed";
  let accepts = 0;
  value.baseline.nativeSubmission = {
    observed: async () => ({ phase, post: { userMessageId: "accepted" } }),
    accept: async () => { accepts += 1; phase = "accepted"; },
  };
  const binding = await value.run(true);
  expect(value.waits()).toBe(1);
  expect(accepts).toBe(1);
  expect(value.baseline.acceptedUserIdentity).toBe(user);
  expect(binding.identity).toBe(assistant);
});
test("waiting for the user witness respects cancellation without accepting another turn", async () => {
  await expect(assistantBeforeUser(true).run(true)).rejects.toThrow("aborted");
});

function tokenOwnedUserFrame(matches: boolean | undefined, users = [user]) {
  const value = observation(users, [], [...users, assistant]);
  value.baseline.acceptedUserIdentity = undefined;
  value.baseline.submittedText = "original native task";
  value.baseline.turnToken = matches === undefined ? undefined : "turn_" + "a".repeat(32);
  let checks = 0;
  value.worker.userMessageMatchesSubmission = async (_group: unknown, _text: string, _signal: unknown, token: string) => {
    checks += 1;
    expect(token).toBe(value.baseline.turnToken);
    return matches;
  };
  return { ...value, checks: () => checks };
}
test("a user-only remount without an earlier user witness waits after exact broker proof", async () => {
  const value = tokenOwnedUserFrame(true);
  expect(await value.reconcile()).toBe(value.binding);
  expect(value.checks()).toBe(1);
  expect(value.baseline.acceptedUserIdentity).toBe(user);
});
test("an unacknowledged user-only remount with mismatched broker proof remains rejected", async () => {
  await expect(tokenOwnedUserFrame(false).reconcile()).rejects.toThrow("opened another user turn");
});
test("shared text without a fresh broker token cannot authorize a user-only remount", async () => {
  const value = tokenOwnedUserFrame(undefined);
  await expect(value.reconcile()).rejects.toThrow("opened another user turn");
  expect(value.checks()).toBe(0);
});
test("broker proof cannot replace a different already acknowledged user identity", async () => {
  const value = tokenOwnedUserFrame(true);
  value.baseline.acceptedUserIdentity = "group:user:other";
  await expect(value.reconcile()).rejects.toThrow("opened another user turn");
  expect(value.checks()).toBe(0);
});
test("broker proof cannot admit a competing new user", async () => {
  const value = tokenOwnedUserFrame(true, [user, "group:user:foreign"]);
  await expect(value.reconcile()).rejects.toThrow("opened another user turn");
  expect(value.checks()).toBe(0);
});
