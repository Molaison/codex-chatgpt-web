import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("shutdown did not settle within 1 second")), 1_000);
    })]);
  } finally { clearTimeout(timer!); }
}

test("closing a never-ready real helper settles every waiting run", async () => {
  const root = mkdtempSync(join(tmpdir(), "helper-close-"));
  const script = join(root, "unready.cjs");
  writeFileSync(script, 'process.stdin.on("data", () => process.exit(0));\nsetInterval(() => {}, 1000);\n');
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: { endpoint: "http://127.0.0.1:39002", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "owned-target" }, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex", browserHost: "launcher", browserHostDescriptorPath: descriptor,
    browserHelperScriptPath: script, storageStatePath: join(root, "unused.json"),
    chromeExecutablePath: "unused", turnTimeoutMs: 60_000, headed: false,
    autoApproveToolCalls: false, useSavedChats: false,
  });
  let prepared = 0;
  const run = (traceId: string) => client.run({
    traceId, modelId: "gpt-5.6-sol", modelFamily: "5.6", reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => { prepared++; return { text: "unused", images: [], release() {} }; },
    onTextDelta() {},
  });
  try {
    const outcomes = [run("waiting-a"), run("waiting-b")].map(work => work.catch(error => error));
    await within(client.close());
    for (const outcome of await within(Promise.all(outcomes))) expect(outcome).toMatchObject({ name: "AbortError" });
    expect(prepared).toBe(0);
    await within(client.close());
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const input of ["", '{"method":"claim"']) {
  test.skipIf(process.platform === "win32")(`broker shutdown destroys ${input ? "partial-frame" : "idle"} sockets`, async () => {
    const root = mkdtempSync(join(tmpdir(), "broker-idle-"));
    const endpoint = join(root, "broker.sock");
    const broker = TurnBroker.forSocket(endpoint);
    let socket: ReturnType<typeof createConnection> | undefined;
    try {
      await broker.listen();
      socket = createConnection(endpoint);
      await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
      if (input) socket.write(input);
      const closed = new Promise<void>(resolve => socket!.once("close", () => resolve()));
      await within(broker.close());
      await within(closed);
      await expect(broker.listen()).rejects.toThrow("closed");
      await within(broker.close());
    } finally { socket?.destroy(); await broker.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test.skipIf(process.platform === "win32")("close racing a stale-socket probe cannot recreate the broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "broker-probe-"));
  const endpoint = join(root, "broker.sock");
  const child = Bun.spawn([process.execPath, "-e", 'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready\\n"))', endpoint], {
    stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const broker = TurnBroker.forSocket(endpoint);
  try {
    await within(reader.read());
    child.kill("SIGKILL");
    await child.exited;
    chmodSync(endpoint, 0o600);
    const starting = broker.listen().catch(error => error);
    await within(broker.close());
    expect(await within(starting)).toBeInstanceOf(Error);
    await expect(broker.listen()).rejects.toThrow("closed");
  } finally {
    child.kill();
    await reader.cancel();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
