import { expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import { assertRetainedForwardRequest, readRetainedForwardPolicy, retainedForwardIntentDigest,
  RETAINED_FORWARD_POLICY_ENV } from "../src/adapters/chatgpt-web/retained-forward-lane";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { forwardFixture, withForwardPolicy } from "./retained-forward-fixtures";

function provider(f: ReturnType<typeof forwardFixture>): any {
  return { adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", chatgptWeb: { accountId: f.policy.accountId,
    browserHost: "launcher", browserHostDescriptorPath: f.policy.descriptorPath,
    brokerSocketPath: join(f.root, "broker.sock"), threadEnvironmentStatePath: join(f.root, "runtime/environment.json") } };
}
const req = (body: unknown) => new Request("http://local.test/v1/responses", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("policy omitted preserves the unrestricted default; digest sorts keys but binds every value", () => {
  const previous = process.env[RETAINED_FORWARD_POLICY_ENV];
  delete process.env[RETAINED_FORWARD_POLICY_ENV];
  try {
    expect(readRetainedForwardPolicy()).toBeUndefined();
    expect(() => assertRetainedForwardRequest({} as any, {} as any)).not.toThrow();
    expect(retainedForwardIntentDigest({ b: [2, 1], a: "x" })).toBe(retainedForwardIntentDigest({ a: "x", b: [2, 1] }));
    expect(retainedForwardIntentDigest({ a: "x", b: [1, 2] })).not.toBe(retainedForwardIntentDigest({ a: "x", b: [2, 1] }));
  } finally { if (previous !== undefined) process.env[RETAINED_FORWARD_POLICY_ENV] = previous; }
});

test("strict private file permissions and immutable policy bytes fail closed", async () => {
  const f = forwardFixture();
  try { await withForwardPolicy(f, async () => {
    const path = process.env[RETAINED_FORWARD_POLICY_ENV]!;
    chmodSync(path, 0o644);
    expect(() => readRetainedForwardPolicy()).toThrow("retained-forward");
    chmodSync(path, 0o600);
    expect(readRetainedForwardPolicy()?.allow).toEqual(f.policy.allow);
    writeFileSync(path, JSON.stringify({ ...f.policy, navigateNewEmptySurface: false }));
    expect(() => readRetainedForwardPolicy()).toThrow("retained-forward");
  }); } finally { f.cleanup(); }
});

for (const stream of [true, false]) {
  for (const fault of ["missing-thread", "missing-turn", "wrong-turn", "wrong-intent", "old-thread", "old-turn", "old-conversation", "previous-response"] as const) {
    test(`private gate rejects ${fault} before real HTTP adapter/SSE/operation, stream=${stream}`, async () => {
      const f = forwardFixture(); f.body.stream = stream;
      const native = JSON.parse(f.body.client_metadata["x-codex-turn-metadata"]);
      if (fault === "missing-thread") delete native.thread_id;
      if (fault === "missing-turn") delete native.turn_id;
      if (fault === "wrong-turn") native.turn_id = crypto.randomUUID();
      if (fault === "old-thread") native.thread_id = f.policy.deny.threadIds[0];
      if (fault === "old-turn") native.turn_id = f.policy.deny.turnIds[0];
      if (fault === "old-conversation") f.body.client_metadata.conversation_url = f.policy.deny.conversationUrls[0];
      if (fault === "previous-response") f.body.previous_response_id = "resp_retained";
      f.body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(native);
      f.policy.allow.intentSha256 = retainedForwardIntentDigest(f.body);
      if (fault === "wrong-intent") f.body.input[0].content = "Different human intent";
      let factories = 0;
      try { await withForwardPolicy(f, async () => {
        const config = { ...defaultConfig("browser-only"), browserHost: "launcher" as const,
          accountId: f.policy.accountId, browserHostDescriptorPath: f.policy.descriptorPath };
        const response = responseRequest(req(f.body), config, () => { factories++; throw new Error("adapter must not exist"); });
        if (fault === "previous-response") {
          // Saved-chat ownership rejects an unknown alias before trace admission.
          expect((await response).status).toBe(409);
        } else {
          await expect(response).rejects.toThrow("retained-forward");
        }
        expect(factories).toBe(0);
        expect(existsSync(join(f.root, "runtime/operations"))).toBe(false);
      }); } finally { f.cleanup(); }
    });
  }
}

test("exact fresh wire reaches HTTP adapter once; direct adapter calls also enforce the private gate", async () => {
  const f = forwardFixture();
  try { await withForwardPolicy(f, async () => {
    const config = { ...defaultConfig("browser-only"), browserHost: "launcher" as const,
      accountId: f.policy.accountId, browserHostDescriptorPath: f.policy.descriptorPath };
    let factories = 0;
    const response = await responseRequest(req(f.body), config, () => {
      factories++;
      return { async runTurn(_p: any, _i: any, emit: any) {
        emit({ type: "error", message: "offline boundary", status: 409, retryable: false });
      } } as any;
    }, { rememberState: false });
    await response.text(); expect(factories).toBe(1);
    const parsed = parseRequest(f.body); parsed._chatgptLocalTools = false;
    assertRetainedForwardRequest(provider(f), parsed);
    parsed._rawBody = { ...f.body, instructions: "changed" };
    let events = 0;
    await expect(createChatGptWebAdapter(provider(f)).runTurn!(parsed, { headers: new Headers() }, () => { events++; }))
      .rejects.toThrow("retained-forward");
    expect(events).toBe(0);
    expect(existsSync(join(f.root, "runtime/operations"))).toBe(false);
  }); } finally { f.cleanup(); }
});
