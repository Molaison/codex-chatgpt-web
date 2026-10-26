import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETAINED_FORWARD_POLICY_ENV, retainedForwardIntentDigest, type RetainedForwardPolicy } from "../src/adapters/chatgpt-web/retained-forward-lane";
import { LAUNCHER_BROWSER_HOST_KIND, type LauncherBrowserHostDescriptor } from "../src/launcher-browser-host";

export function forwardFixture() {
  const root = mkdtempSync(join(tmpdir(), "retained-forward-"));
  const threadId = randomUUID(), turnId = randomUUID();
  const body: any = { model: "chatgpt-web/high", stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
    input: [{ type: "message", role: "user", content: "What is one plus one?",
      internal_chat_message_metadata_passthrough: { turn_id: turnId } }] };
  const policy: RetainedForwardPolicy = { version: 1, accountId: "isolated-account2", descriptorPath: join(root, "descriptor.json"),
    host: { pid: process.pid, instanceId: "i".repeat(32), profile: "production", partition: "persist:codex-web-gpt-chatgpt" },
    allow: { threadId, turnId, intentSha256: retainedForwardIntentDigest(body) },
    deny: { threadIds: ["01a17549-1b31-77d3-8640-389d10ab99b0"], turnIds: ["01a17549-3c6e-7df2-8081-4368cc91d9f8"],
      traceIds: ["f190656b7689"], conversationKeys: ["df01487ea2dd7350a4285f47bb298f58eb315a6e8162f092e6c831e93ad90316"],
      conversationUrls: ["https://chatgpt.com/c/retained-original"],
      surfaceIds: ["RdSgHfLqzRdlxxoYlAdrmETJz5mmNJk7"], targetIds: ["FB8D68CE269A96965E033C4C4B6B0CA0"] },
    navigateNewEmptySurface: true };
  const before: LauncherBrowserHostDescriptor = { version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: policy.host.profile, pid: policy.host.pid, observationInstanceId: policy.host.instanceId,
    endpoint: "http://127.0.0.1:32101", control: { endpoint: "http://127.0.0.1:32102", token: "t".repeat(48) },
    helper: { executable: process.execPath, script: import.meta.path }, partition: policy.host.partition,
    idleUrl: "https://chatgpt.com/", surfaceId: "h".repeat(32), surfaceTargets: {
      ["h".repeat(32)]: "home-target", [policy.deny.surfaceIds[0]!]: policy.deny.targetIds[0]!,
    }, createdAt: new Date().toISOString() };
  return { root, body, policy, before, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export async function withForwardPolicy<T>(f: ReturnType<typeof forwardFixture>, action: () => Promise<T>): Promise<T> {
  const previous = process.env[RETAINED_FORWARD_POLICY_ENV];
  const path = join(f.root, "policy.json");
  writeFileSync(path, JSON.stringify(f.policy), { mode: 0o600 }); chmodSync(path, 0o600);
  process.env[RETAINED_FORWARD_POLICY_ENV] = path;
  try { return await action(); }
  finally {
    if (previous === undefined) delete process.env[RETAINED_FORWARD_POLICY_ENV];
    else process.env[RETAINED_FORWARD_POLICY_ENV] = previous;
  }
}
