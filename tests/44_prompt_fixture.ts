import { writeFileSync } from "node:fs";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

export function writePromptTestDescriptor(path: string): void {
  writeFileSync(path, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:9", control: { endpoint: "http://127.0.0.1:10", token: "c".repeat(43) },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "s".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
}
