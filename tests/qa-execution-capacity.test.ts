import { expect, test } from "bun:test";
import { ChatGptTurnSessions, ChatGptTraceFeed, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

test("execution admission exposes retryable 429 before the worker and recovers a settled slot", async () => {
  const sessions = new ChatGptTurnSessions();
  const finish: Array<() => void> = [];
  const runtime = () => {
    const browser = new Promise<string>(resolve => finish.push(() => resolve("OK")));
    return { mode: "read-only" as const, browser, physicalSettlement: browser.then(() => {}),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} };
  };
  try {
    for (let index = 0; index < 5; index++) sessions.getOrCreate("active-" + index, runtime);
    let rejection: unknown;
    try { sessions.getOrCreate("overflow", runtime); } catch (error) { rejection = error; }
    expect(rejection).toMatchObject({ status: 429, errorType: "rate_limit_error", code: "concurrency_limit_exceeded", retryable: true });
    expect(finish).toHaveLength(5);
    finish[0]!();
    await Bun.sleep(0);
    expect(sessions.activeCount()).toBe(4);
    expect(sessions.getOrCreate("recovered", runtime)).toBeDefined();
    expect(sessions.activeCount()).toBe(5);
  } finally { for (const resolve of finish) resolve(); sessions.clear(); }
});

test.each([false, true])("Responses preserves pre-session limit errors (stream=%s)", async stream => {
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "chatgpt-web/high", stream,
      input: [{ type: "message", role: "user", id: "capacity-user", content: "Hello" }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "capacity-thread", turn_id: "capacity-turn" }) },
    }),
  }), defaultConfig("browser-only"), () => ({
    name: "capacity-rejection-fixture", async runTurn() {
      throw new ChatGptWebAdapterError("Account capacity is full", {
        status: 429, errorType: "rate_limit_error", code: "concurrency_limit_exceeded", retryable: true,
      });
    },
  }), { rememberState: false });
  expect(response.status).toBe(stream ? 200 : 429);
  const wire = await response.text();
  const result = stream
    ? JSON.parse(wire.split("\n").find(line => line.startsWith('data: {"type":"response.failed"'))!.slice(6)).response
    : JSON.parse(wire);
  expect(result.status).toBe("failed");
  expect(result.error).toMatchObject({ type: "rate_limit_error", code: "concurrency_limit_exceeded" });
  expect(wire).not.toContain("upstream_server_error");
  expect(result.output).toEqual([]);
});
