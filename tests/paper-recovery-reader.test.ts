import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLauncherPaperRecovery } from "../src/paper-recovery";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("native recovery closes its owned interception without waiting for Fetch.disable and rereads the same target", async () => {
  const root = mkdtempSync(join(tmpdir(), "paper-native-reader-"));
  const chrome = Bun.spawn([process.env.CHATGPT_DOM_TEST_BROWSER!, "--headless=new", "--no-sandbox",
    "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
    "--remote-debugging-port=0", "--user-data-dir=" + root, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const surfaceId = "a".repeat(32), projectId = "g-p-" + "b".repeat(32), conversationId = "saved-fixture";
  const conversationUrl = `https://chatgpt.com/g/${projectId}/c/${conversationId}`;
  const native = { conversation_id: conversationId, fixture: "Native GET fixture" };
  const phases: any[] = [];
  let stallDisable = false, holdHistory = false, historyWaiting!: () => void, forcedDisconnect = false;
  const historyStarted = new Promise<void>(resolve => { historyWaiting = resolve; });
  const sockets = new Set<Bun.ServerWebSocket<ProxyData>>();
  type ProxyData = { upstream?: WebSocket; queue: string[]; dropped: Set<number>; urls: Map<string, string> };
  let proxy: ReturnType<typeof Bun.serve<ProxyData>> | undefined;
  let control: ReturnType<typeof Bun.serve> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let i = 0; !existsSync(join(root, "DevToolsActivePort")) && i < 100; i++) await Bun.sleep(50);
    const endpoint = "http://127.0.0.1:" + readFileSync(join(root, "DevToolsActivePort"), "utf8").split("\n")[0];
    const version = await (await fetch(endpoint + "/json/version")).json() as any;
    const targets = await (await fetch(endpoint + "/json/list")).json() as any[];
    const targetId = targets.find(target => target.type === "page").id;
    proxy = Bun.serve<ProxyData>({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        if (request.headers.get("upgrade") === "websocket") {
          if (server.upgrade(request, { data: { queue: [], dropped: new Set(), urls: new Map() } })) return;
        }
        return Response.json({ ...version, webSocketDebuggerUrl: server.url.origin.replace("http:", "ws:") + "/devtools/browser/fixture" });
      },
      websocket: {
        open(socket) {
          sockets.add(socket);
          const upstream = new WebSocket(version.webSocketDebuggerUrl);
          socket.data.upstream = upstream;
          upstream.onopen = () => { for (const message of socket.data.queue.splice(0)) upstream.send(message); };
          upstream.onmessage = event => {
            const message = JSON.parse(String(event.data));
            if (message.method === "Fetch.requestPaused") socket.data.urls.set(message.params.requestId, message.params.request.url);
            if (!socket.data.dropped.has(message.id)) socket.send(String(event.data));
          };
          upstream.onclose = () => socket.close();
        },
        message(socket, payload) {
          let message = JSON.parse(String(payload));
          if (message.method === "Fetch.continueRequest") {
            const url = new URL(socket.data.urls.get(message.params.requestId)!);
            // Fulfill every paused browser GET locally; no real website is contacted.
            const history = url.pathname === "/backend-api/conversation/" + conversationId;
            if (history && holdHistory) { historyWaiting(); return; }
            const body = history ? JSON.stringify(native)
              : '<!doctype html><title>Saved fixture</title><script>fetch("/backend-api/conversation/' + conversationId + '").then(r=>r.json())</script>';
            message = { ...message, method: "Fetch.fulfillRequest", params: { requestId: message.params.requestId,
              responseCode: 200, responseHeaders: [{ name: "Content-Type", value: history ? "application/json" : "text/html" }],
              body: Buffer.from(body).toString("base64") } };
          }
          if (message.method === "Fetch.disable" && stallDisable) {
            socket.data.dropped.add(message.id);
          }
          const text = JSON.stringify(message);
          if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(text);
          else socket.data.queue.push(text);
        },
        close(socket) { sockets.delete(socket); socket.data.upstream?.close(); },
      },
    });
    control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const activity = await request.json() as any; phases.push(activity);
      return Response.json(activity.phase === "start" ? { surfaceId, reused: true, connectorBound: true } : { cancelledByUser: false });
    } });
    const descriptor = join(root, "launcher.json");
    writeFileSync(descriptor, JSON.stringify({ version: 3, kind: "codex-web-gpt-launcher", profile: "production",
      pid: chrome.pid, endpoint: proxy.url.origin, control: { endpoint: control.url.origin, token: "t".repeat(48) },
      helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId, surfaceTargets: { [surfaceId]: targetId }, createdAt: new Date().toISOString() }), { mode: 0o600 });
    const request = { accountId: "fixture-account", sessionHash: "c".repeat(64), browserHostDescriptorPath: descriptor, conversationUrl };
    // First use succeeds. Reuse the same target while dropping any Fetch.disable replies;
    // the native reader must finish by disconnecting its own CDP connection.
    expect(await readLauncherPaperRecovery({ ...request, signal: new AbortController().signal })).toEqual(native);
    expect(phases.at(-1)).toMatchObject({ phase: "end", status: "completed", retain: true });
    stallDisable = true;
    watchdog = setTimeout(() => {
      forcedDisconnect = true;
      for (const socket of sockets) socket.close();
    }, 1_200);
    expect(await readLauncherPaperRecovery({ ...request, signal: new AbortController().signal })).toEqual(native);
    clearTimeout(watchdog);
    expect(forcedDisconnect).toBe(false);
    expect(phases.at(-1)).toMatchObject({ phase: "end", status: "completed", retain: true });
    // A subsequent GET on that target proves the previous transport left no stuck interception.
    expect(await readLauncherPaperRecovery({ ...request, signal: new AbortController().signal })).toEqual(native);
    expect(phases.filter(phase => phase.phase === "end" && phase.status === "completed")).toHaveLength(3);

    holdHistory = true;
    const abort = new AbortController();
    const pending = readLauncherPaperRecovery({ ...request, signal: abort.signal });
    await historyStarted;
    abort.abort();
    watchdog = setTimeout(() => {
      forcedDisconnect = true;
      for (const socket of sockets) socket.close();
    }, 1_200);
    await expect(pending).rejects.toMatchObject({ code: "paper_recovery_unavailable" });
    clearTimeout(watchdog);
    expect(forcedDisconnect).toBe(false);
    expect(phases.at(-1)).toMatchObject({ phase: "end", status: "aborted", retain: true });
    expect(phases.filter(phase => phase.phase === "start")).toHaveLength(4);
    expect(phases.filter(phase => phase.phase === "end")).toHaveLength(4);
    expect(chrome.exitCode).toBeNull();
    expect((await (await fetch(endpoint + "/json/list")).json() as any[]).some(target => target.id === targetId)).toBe(true);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    for (const socket of sockets) socket.close();
    proxy?.stop(true); control?.stop(true); chrome.kill(); await chrome.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
