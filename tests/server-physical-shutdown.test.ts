import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

function fixture() {
  const signals = new Map<string, ReadonlySet<unknown>>((["SIGINT", "SIGTERM"] as const).map(signal => [signal, new Set<unknown>(process.listeners(signal))]));
  const config = { ...defaultConfig("browser-only"), port: 0, host: "127.0.0.1" as const, useSavedChats: false };
  let releaseBrowser!: (answer: string) => void, releasePhysical!: () => void;
  const browser = new Promise<string>(resolve => { releaseBrowser = resolve; });
  const physicalSettlement = new Promise<void>(resolve => { releasePhysical = resolve; });
  let cancellations = 0;
  chatGptTurnSessions.getOrCreate("server-physical-shutdown", () => ({
    mode: "read-only", browser, physicalSettlement, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel() { cancellations++; releaseBrowser("cancelled"); },
  }), "shutdown-physical-trace", "shutdown-physical-owner", "shutdown_turn_001", "shutdown_thread_001");
  const server = startServer(config, { fetchUpstream: async () => { throw new Error("upstream forbidden"); } });
  const base = `http://127.0.0.1:${server.port}`;
  const health = async () => await (await fetch(base + "/healthz")).json() as any;
  const control = (path: string, body?: unknown) => fetch(base + path, { method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { server, health, control, releasePhysical, cancellations: () => cancellations,
    // Dispatch only this runtime's registered signal handler: never signal another fixture.
    signalShutdown() {
      for (const listener of process.listeners("SIGTERM")) if (!signals.get("SIGTERM")!.has(listener)) listener("SIGTERM");
    },
    async close() {
      releaseBrowser("cleanup"); releasePhysical(); await chatGptTurnSessions.waitForPhysicalSettlement();
      chatGptTurnSessions.clear(); await server.stop(true);
      for (const signal of ["SIGINT", "SIGTERM"] as const) for (const listener of process.listeners(signal))
        if (!signals.get(signal)!.has(listener)) process.removeListener(signal, listener);
    },
  };
}

test("a drained runtime refuses shutdown until an interrupted helper physically exits", async () => {
  const f = fixture();
  try {
    const interrupted = await f.control("/admin/interrupt-turn", { threadId: "shutdown_thread_001", turnId: "shutdown_turn_001" });
    expect((await interrupted.json() as any).cancelled_browser_turns).toBe(1);
    expect(await f.health()).toMatchObject({ active_browser_turns: 1 });
    const drained = await f.control("/admin/drain");
    expect(await drained.json()).toMatchObject({ accepting_turns: false, active_browser_turns: 1 });
    const shutdown = await f.control("/admin/shutdown");
    expect(shutdown.status).toBe(409);
    expect(await shutdown.json()).toMatchObject({ status: "refused", active_browser_turns: 1 });
    f.releasePhysical(); await chatGptTurnSessions.waitForPhysicalSettlement();
    expect(await f.health()).toMatchObject({ active_browser_turns: 0 });
    expect(f.cancellations()).toBe(1);
  } finally { await f.close(); }
});

test("signal shutdown keeps its listener open until cancelled helper cleanup settles", async () => {
  const f = fixture();
  try {
    f.signalShutdown();
    await Bun.sleep(10);
    expect(f.cancellations()).toBe(1);
    expect(chatGptTurnSessions.find("server-physical-shutdown")).toBeUndefined();
    expect(await f.health()).toMatchObject({ accepting_turns: false, active_browser_turns: 1 });
    f.releasePhysical(); await chatGptTurnSessions.waitForPhysicalSettlement();
    let stopped = false;
    for (let n = 0; n < 100 && !stopped; n++) {
      try { await f.health(); await Bun.sleep(5); }
      catch { stopped = true; }
    }
    expect(stopped).toBe(true);
  } finally { await f.close(); }
});
