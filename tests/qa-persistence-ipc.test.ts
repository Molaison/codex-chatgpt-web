import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const useSavedChats of [true, false]) {
  test("real helper IPC preserves portable account/storage and saved-chat preference=" + useSavedChats, async () => {
    const root = mkdtempSync(join(tmpdir(), "qa-persistence-ipc-")); roots.push(root);
    const store = join(root, "moved-account-home", "durable-chat-mappings");
    const accountId = "portable-account";
    const helper = join(root, "helper.ts");
    const workerUrl = new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href;
    const mainUrl = new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href;
    writeFileSync(helper, [
      "import { ChatGptBrowserWorker } from " + JSON.stringify(workerUrl) + ";",
      "process.env.CODEX_CHATGPT_WEB_HOME = " + JSON.stringify(join(root, "unrelated-helper-home")) + ";",
      "const forProvider = ChatGptBrowserWorker.forProvider;",
      "ChatGptBrowserWorker.forProvider = function(provider) {",
      "  if (provider.chatgptWeb.accountId !== " + JSON.stringify(accountId) + ") throw new Error('Account identity lost in IPC');",
      "  if (provider.chatgptWeb.conversationStoreDirectory !== " + JSON.stringify(store) + ") throw new Error('Store directory lost in IPC');",
      "  if (provider.chatgptWeb.useSavedChats !== " + JSON.stringify(useSavedChats) + ") throw new Error('Saved/temporary preference lost in IPC');",
      "  return forProvider.call(this, provider);",
      "};",
      "ChatGptBrowserWorker.prototype.run = async function(turn) {",
      "  if (this.config.accountId !== " + JSON.stringify(accountId) + ") throw new Error('Wrong resolved account');",
      "  if (this.config.useSavedChats !== " + JSON.stringify(useSavedChats) + ") throw new Error('Wrong resolved preference');",
      "  if (this.config.useSavedChats && this.config.conversationStoreDirectory !== " + JSON.stringify(store) + ") throw new Error('Helper replaced account directory');",
      "  if (!turn.retainConversation || turn.conversationKey !== 'c'.repeat(64)) throw new Error('Conversation identity lost in IPC');",
      "  if (turn.project?.id !== 'g-p-' + 'a'.repeat(32) || turn.project?.name !== 'random_knowledge') throw new Error('Project route lost in IPC');",
      "  const reused = turn.traceId === 'fork-resumed';",
      "  await turn.onPreparedSelected(reused);",
      "  const prepared = await (reused ? turn.prepareResume() : turn.prepare());",
      "  const answer = prepared.text; prepared.release(); turn.onTextDelta(answer); return answer;",
      "};",
      "await import(" + JSON.stringify(mainUrl) + ");",
    ].join("\n"), { mode: 0o700 });
    const descriptorPath = join(root, "launcher.json");
    writeFileSync(descriptorPath, JSON.stringify({
      version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
      endpoint: "http://127.0.0.1:39001",
      control: { endpoint: "http://127.0.0.1:39002", token: "isolated-test-control-token-0123456789abcdef" },
      helper: { executable: process.execPath, script: helper },
      partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "launcher_surface_id_0123456789AB",
      surfaceTargets: { launcher_surface_id_0123456789AB: "isolated-owned-target" },
      createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    const config: ResolvedBrowserConfig = {
      accountId, conversationStoreDirectory: store, useSavedChats,
      appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
      browserHelperScriptPath: helper, storageStatePath: join(root, "unused-state.json"),
      chromeExecutablePath: join(root, "unused-chrome"), headed: true, autoApproveToolCalls: false,
      turnTimeoutMs: 10000,
    };
    const client = new LauncherBrowserHelperClient(config);
    const chosen: boolean[] = [], compiled: string[] = [];
    let released = 0;
    try {
      for (const traceId of ["fork-fresh", "fork-resumed"]) {
        const result = await client.run({
          traceId, modelId: "gpt-5.6-sol", reasoning: "low", retainConversation: true, conversationKey: "c".repeat(64),
          project: { id: "g-p-" + "a".repeat(32), name: "random_knowledge" },
          capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
          prepare: async () => { compiled.push("history"); return { text: "Inherited history plus first child question", images: [], release: () => { released++; } }; },
          prepareResume: async () => { compiled.push("suffix"); return { text: "Only next child question", images: [], release: () => { released++; } }; },
          onPreparedSelected: reused => { chosen.push(reused); }, onReasoningSummary() {}, onTextDelta() {},
        });
        expect(result).toBe(traceId === "fork-fresh" ? "Inherited history plus first child question" : "Only next child question");
      }
      expect(chosen).toEqual([false, true]);
      expect(compiled).toEqual(["history", "suffix"]);
      expect(released).toBe(2);
    } finally { await client.close(); }
  });
}
