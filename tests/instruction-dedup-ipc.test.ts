import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const modern of [true, false]) {
  for (const withFingerprint of [true, false]) {
    test("real IPC selects safe instruction mode: modern=" + modern + " fingerprint=" + withFingerprint, async () => {
      const root = mkdtempSync(join(tmpdir(), "instructions-ipc-")); roots.push(root);
      const helper = join(root, "helper.ts");
      const fingerprint = "a".repeat(64);
      const expectedInclude = !modern || !withFingerprint;
      const workerUrl = new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href;
      const mainUrl = new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href;
      const source = modern ? [
        "import { ChatGptBrowserWorker } from " + JSON.stringify(workerUrl) + ";",
        "ChatGptBrowserWorker.prototype.run = async function(turn) {",
        "  if (turn.instructionFingerprint !== " + JSON.stringify(withFingerprint ? fingerprint : undefined) + ") throw new Error('Instruction identity lost in IPC');",
        "  await turn.onPreparedSelected(true, " + JSON.stringify(!withFingerprint) + ");",
        "  const prepared = await turn.prepareResume();",
        "  await turn.onSendActivated();",
        "  await turn.onSubmitted();",
        "  turn.onTextDelta(prepared.text); return prepared.text;",
        "};",
        "await import(" + JSON.stringify(mainUrl) + ");",
      ].join("\n") : [
        'import { createInterface } from "node:readline";',
        "const write = frame => process.stdout.write(JSON.stringify(frame) + '\\n');",
        "write({ type: 'ready', features: [] });",
        "createInterface({ input: process.stdin }).on('line', line => {",
        "  const message = JSON.parse(line);",
        "  if (message.type === 'shutdown') process.exit(0);",
        "  if (message.type === 'run') {",
        "    if (message.turn.instructionFingerprint !== undefined) throw new Error('Unnegotiated fingerprint sent to old helper');",
        "    write({ type: 'event', id: message.id, event: 'prepared_selected', reused: true, includeInstructions: false });",
        "  }",
        "  if (message.type === 'prepared_selected_ack') write({ type: 'result', id: message.id, text: message.prepared.text });",
        "});",
      ].join("\n");
      writeFileSync(helper, source);
      const descriptorPath = join(root, "launcher.json");
      writeFileSync(descriptorPath, JSON.stringify({
        version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
        endpoint: "http://127.0.0.1:39001",
        control: { endpoint: "http://127.0.0.1:39002", token: "isolated-control-" + "a".repeat(32) },
        helper: { executable: process.execPath, script: helper },
        partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
        surfaceId: "s".repeat(32), surfaceTargets: { ["s".repeat(32)]: "fixture-target" },
        createdAt: new Date().toISOString(),
      }), { mode: 0o600 });
      const config: ResolvedBrowserConfig = {
        accountId: "isolated-account", conversationStoreDirectory: root,
        appName: "Codex Cloudflare", browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
        browserHelperScriptPath: helper, storageStatePath: join(root, "unused.json"),
        chromeExecutablePath: join(root, "unused-chrome"), headed: true, autoApproveToolCalls: false,
        turnTimeoutMs: 10000,
      };
      const selections: boolean[] = [];
      const client = new LauncherBrowserHelperClient(config);
      try {
        const result = await client.run({
          traceId: "instructions-" + (modern ? "modern" : "legacy") + "-" + withFingerprint,
          modelId: "gpt-5.6-sol", reasoning: "low", retainConversation: true, conversationKey: "c".repeat(64),
          ...(withFingerprint ? { instructionFingerprint: fingerprint } : {}),
          capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
          prepare: async () => { throw new Error("Unexpected fresh preparation"); },
          prepareResume: async selection => {
            selections.push(selection?.includeSystemPrompt ?? true);
            return { text: selection?.includeSystemPrompt === false ? "DELTA" : "FULL_CONTRACT", images: [], release() {} };
          },
          onTextDelta() {},
        });
        expect(result).toBe(expectedInclude ? "FULL_CONTRACT" : "DELTA");
        expect(selections).toEqual([expectedInclude]);
      } finally { await client.close(); }
    }, 15000);
  }
}
