import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, type AppConfig } from "../src/config";
import { responseRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";
import { createWebSubagentSmokeGuard, webSubagentSmokeCatalog, WEB_SUBAGENT_SMOKE_MODEL } from "../scripts/live-web-smoke-guard";

const nativeCatalog = { models: [{
  slug: "gpt-6-astra", visibility: "list", priority: 1, multi_agent_version: "v2",
  supported_reasoning_levels: [{ effort: "high", description: "High" }],
  tool_mode: "code_mode_only",
}] };

function config(port = 17841): AppConfig {
  return { ...defaultConfig("browser-only"), browserHost: "launcher", solAvailable: true,
    proAvailable: true, port };
}

function body(effort = "medium") {
  return { model: WEB_SUBAGENT_SMOKE_MODEL, reasoning: { effort }, input: "smoke fixture", stream: false };
}

function request(value: unknown, signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value), signal,
  });
}

test("the smoke catalog exposes only its pinned non-Pro model and explicit efforts", () => {
  const result = webSubagentSmokeCatalog(nativeCatalog, config());
  expect(result.models).toEqual([expect.objectContaining({
    slug: "chatgpt-web/gpt-5.6-sol", default_reasoning_level: "medium", multi_agent_version: "v1",
    supported_reasoning_levels: [expect.objectContaining({ effort: "medium" }), expect.objectContaining({ effort: "high" })],
  })]);
  for (const change of [{ browserInteractionMode: "manual" as const }, { solAvailable: false },
    { browserHost: "managed-chrome" as const }, { subagentProtocol: "native" as const }]) {
    expect(() => webSubagentSmokeCatalog(nativeCatalog, { ...config(), ...change })).toThrow();
  }
});

test("allowed requests pass through the real parser and model route exactly once", async () => {
  const observations: CodexParsedRequest[] = [];
  let upstreamCalls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    upstreamCalls += 1;
    return responseRequest(request, config(), () => ({ name: "offline-smoke-fixture",
      async runTurn(parsed, _raw, emit) {
        observations.push(parsed);
        emit({ type: "text_delta", text: "offline acceptance", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }), { rememberState: false });
  } });
  const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
  try {
    for (const [effort, stream] of [["medium", false], ["high", true]] as const) {
      const response = await guard.fetch(request({ ...body(effort), stream }));
      expect(response.status).toBe(200);
      const text = await response.text();
      const final = stream
        ? JSON.parse(text.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'))!.slice(6)).response
        : JSON.parse(text);
      expect(final).toMatchObject({ status: "completed", model: WEB_SUBAGENT_SMOKE_MODEL });
      expect(observations.at(-1)).toMatchObject({ modelId: "gpt-5.6-sol", _chatgptModelFamily: "5.6",
        options: { reasoning: effort } });
      expect(observations.at(-1)!._chatgptProModel).toBeUndefined();
    }
    expect(upstreamCalls).toBe(2);
    expect(observations).toHaveLength(2);
  } finally {
    guard.close();
    upstream.stop(true);
  }
});

test("Pro, aliases, native, unknown, default and malformed requests never reach the bridge", async () => {
  let upstreamCalls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    upstreamCalls += 1;
    return Response.json({ unexpected: true });
  } });
  try {
    const denied = [
      ...["chatgpt-web/gpt-6-pro", "chatgpt-web/pro", "chatgpt-web/gpt-5.6-pro", "chatgpt-web/zero-risk-pro",
        "gpt-6-pro", "gpt-6-astra", "gpt-5.6-sol", "chatgpt-web/medium", "chatgpt-web/high",
        "chatgpt-web/gpt-6-sol", "unknown", "", undefined, null, 6].map(model => ({ ...body(), model })),
      ...[undefined, null, "high", {}, { effort: "max" }, { effort: "ultra" }, { effort: "unknown" }]
        .map(reasoning => ({ ...body(), reasoning })),
      {}, null, [],
      { ...body(), client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn",
        thread_source: "composer_predictions", turn_trigger: "composer_predictions" }) } },
    ];
    for (const raw of denied) {
      const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
      const response = await guard.fetch(request(raw));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "smoke_model_rejected" } });
      guard.close();
    }
    const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
    const malformed = await guard.fetch(new Request("http://127.0.0.1/v1/responses", { method: "POST", body: "{" }));
    expect(malformed.status).toBe(403);
    guard.close();
    expect(upstreamCalls).toBe(0);
  } finally {
    upstream.stop(true);
  }
});

test("a policy violation closes the smoke to all later model requests", async () => {
  let upstreamCalls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    upstreamCalls += 1;
    return Response.json({ unexpected: true });
  } });
  const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
  try {
    expect((await guard.fetch(request({ ...body(), model: "chatgpt-web/gpt-6-pro" }))).status).toBe(403);
    const later = await guard.fetch(request(body()));
    expect(later.status).toBe(403);
    expect(await later.json()).toMatchObject({ error: { code: "smoke_guard_failed" } });
    expect(guard.failure).toBe("smoke_model_rejected");
    expect(upstreamCalls).toBe(0);
  } finally {
    guard.close();
    upstream.stop(true);
  }
});

test("a policy failure also stops an allowed request whose body is still being read", async () => {
  let upstreamCalls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    upstreamCalls += 1;
    return Response.json({ unexpected: true });
  } });
  const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
  let input!: ReadableStreamDefaultController<Uint8Array>;
  try {
    const pending = guard.fetch(new Request("http://127.0.0.1/v1/responses", { method: "POST",
      body: new ReadableStream<Uint8Array>({ start(controller) { input = controller; } }),
    }));
    expect((await guard.fetch(request({ ...body(), model: "chatgpt-web/pro" }))).status).toBe(403);
    input.enqueue(new TextEncoder().encode(JSON.stringify(body())));
    input.close();
    const stopped = await pending;
    expect(stopped.status).toBe(403);
    expect(await stopped.json()).toMatchObject({ error: { code: "smoke_guard_failed" } });
    expect(upstreamCalls).toBe(0);
  } finally {
    guard.close();
    upstream.stop(true);
  }
});

test("changed runtime configuration and unrecognized endpoints stop before forwarding", async () => {
  let upstreamCalls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    upstreamCalls += 1;
    return Response.json({ unexpected: true });
  } });
  try {
    for (const change of [{ solAvailable: false }, { browserInteractionMode: "manual" as const },
      { subagentProtocol: "native" as const }, { browserHost: "managed-chrome" as const },
      { port: upstream.port === 17841 ? 17842 : 17841 }]) {
      let current = config(upstream.port);
      const guard = createWebSubagentSmokeGuard(() => current);
      current = { ...config(upstream.port), ...change };
      const response = await guard.fetch(request(body()));
      expect(response.status).toBe(403);
      await response.text();
      guard.close();
    }
    for (const url of ["/v1/responses?model=chatgpt-web/pro", "/v1/responses/compact", "/v1/models"]) {
      const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
      const response = await guard.fetch(new Request(`http://127.0.0.1${url}`, {
        method: "POST", body: JSON.stringify(body()),
      }));
      expect(response.status).toBe(404);
      await response.text();
      guard.close();
    }
    const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
    expect((await guard.fetch(new Request("http://127.0.0.1/v1/responses"))).status).toBe(404);
    guard.close();
    expect(upstreamCalls).toBe(0);
  } finally {
    upstream.stop(true);
  }
});

test("redirects are rejected, and upstream errors do not retry or fall back", async () => {
  let redirectedCalls = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    redirectedCalls += 1;
    return Response.json({ unexpected: true });
  } });
  let upstreamCalls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    upstreamCalls += 1;
    return upstreamCalls === 1 ? Response.redirect(destination.url, 307)
      : Response.json({ error: { code: "fixture_unavailable" } }, { status: 503 });
  } });
  const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
  const retryableGuard = createWebSubagentSmokeGuard(() => config(upstream.port));
  try {
    const redirected = await guard.fetch(request(body()));
    expect(redirected.status).toBe(502);
    expect(await redirected.json()).toMatchObject({ error: { code: "smoke_upstream_redirect" } });
    expect(redirectedCalls).toBe(0);
    expect(upstreamCalls).toBe(1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const unavailable = await retryableGuard.fetch(request(body()));
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: { code: "fixture_unavailable" } });
      expect(upstreamCalls).toBe(2 + attempt);
      expect(retryableGuard.failure).toBeUndefined();
    }
  } finally {
    guard.close();
    retryableGuard.close();
    upstream.stop(true);
    destination.stop(true);
  }
});

test("cancellation before dispatch and guard closure send no request", async () => {
  let upstreamCalls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    upstreamCalls += 1;
    return Response.json({ unexpected: true });
  } });
  const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
  try {
    const response = await guard.fetch(request(body(), AbortSignal.abort()));
    expect(response.status).toBe(499);
    await response.text();
    guard.close();
    guard.close();
    const closed = await guard.fetch(request(body()));
    expect(closed.status).toBe(503);
    await closed.text();
    expect(upstreamCalls).toBe(0);
  } finally {
    guard.close();
    upstream.stop(true);
  }
});

for (const action of ["request", "response", "close"] as const) {
  test(`${action} cancellation releases the active upstream stream`, async () => {
    let upstreamCalls = 0;
    const cancelled = Promise.withResolvers<void>();
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      upstreamCalls += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(output) { output.enqueue(new TextEncoder().encode("data: first\n\n")); },
        cancel() { cancelled.resolve(); },
      }), { headers: { "content-type": "text/event-stream" } });
    } });
    const guard = createWebSubagentSmokeGuard(() => config(upstream.port));
    const controller = new AbortController();
    try {
      const response = await guard.fetch(request(body(), controller.signal));
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: first");
      if (action === "request") controller.abort();
      else if (action === "response") await reader.cancel();
      else guard.close();
      await cancelled.promise;
      expect(upstreamCalls).toBe(1);
      if (action !== "response") expect(await reader.read().then(() => false, () => true)).toBeTrue();
    } finally {
      guard.close();
      upstream.stop(true);
    }
  });
}

type CliScenario = "pro" | "allowed" | "rejected-then-complete" | "startup-error" | "timeout"
  | "missing-child-completion" | "wrong-child-version" | "unlinked-child"
  | "wrong-wait-child" | "uncorrelated-wait-output" | "wrong-result-child" | "errored-wait";

async function runCliFixture(scenario: CliScenario) {
  const directory = mkdtempSync(join(tmpdir(), "web-smoke-policy-"));
  const received: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    received.push(await request.json() as Record<string, unknown>);
    return Response.json({ status: "completed", output: [] });
  } });
  try {
    writeFileSync(join(directory, "config.json"), JSON.stringify({ ...config(upstream.port),
      browserHostDescriptorPath: join(directory, "fixture-host.json") }));
    const codex = join(directory, "codex-fixture");
    writeFileSync(codex, `#!${process.execPath}
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
if (process.argv.includes("debug")) {
  console.log(${JSON.stringify(JSON.stringify(nativeCatalog))});
  if (scenario === "startup-error") unlinkSync(process.argv[1]);
  process.exit(0);
}
const home = process.env.CODEX_HOME;
const config = readFileSync(home + "/config.toml", "utf8");
const base = JSON.parse(config.match(/^base_url = (.+)$/m)[1]);
const model = JSON.parse(config.match(/^model = (.+)$/m)[1]);
const catalog = JSON.parse(readFileSync(JSON.parse(config.match(/^model_catalog_json = (.+)$/m)[1]), "utf8"));
if (model !== ${JSON.stringify(WEB_SUBAGENT_SMOKE_MODEL)} || catalog.models.length !== 1 || catalog.models[0].slug !== model) {
  throw new Error("The isolated Codex configuration is not pinned");
}
async function send(model, effort) {
  const response = await fetch(base + "/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, reasoning: { effort }, input: "fake Codex fixture", stream: false }) });
  console.log("SMOKE_POLICY_STATUS " + response.status);
  await response.text();
}
if (scenario === "pro" || scenario === "rejected-then-complete") await send("chatgpt-web/gpt-6-pro", "max");
else {
  await send(model, "medium");
  if (scenario === "timeout") await new Promise(() => setInterval(() => {}, 1000));
  await send(model, "high");
}
if (scenario === "pro") process.exit(0);
if (scenario === "rejected-then-complete") await send(model, "medium");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
mkdirSync(home + "/sessions", { recursive: true });
for (const [name, effort, source, marker] of [
  ["root", "medium", "cli", "LIVE_WEB_SUBAGENT_OK"],
  ["child", "high", { subagent: { thread_spawn: { parent_thread_id: scenario === "unlinked-child" ? "other" : "root", depth: 1 } } }, "CHILD_RESULT"],
]) {
  const entries = [
    { type: "session_meta", payload: { id: name, source } },
    { type: "turn_context", payload: { cwd: process.cwd(), model, effort, multi_agent_version: "v1" } },
    ...(name === "root" ? [
      { type: "response_item", payload: { type: "function_call", name: "wait_agent", call_id: "wait-child",
        arguments: JSON.stringify({ targets: [scenario === "wrong-wait-child" ? "other" : "child"] }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: scenario === "uncorrelated-wait-output" ? "other" : "wait-child",
        output: JSON.stringify({ status: { [scenario === "wrong-result-child" ? "other" : "child"]:
          scenario === "errored-wait" ? { errored: "fixture failure" } : { completed: "CHILD_RESULT " + version } }, timed_out: false }) } },
    ] : []),
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: marker + " " + version } },
  ];
  if (name === "child" && scenario === "missing-child-completion") entries.pop();
  if (name === "child" && scenario === "wrong-child-version") entries.at(-1).payload.last_agent_message = "CHILD_RESULT wrong-version";
  writeFileSync(home + "/sessions/" + name + ".jsonl", entries.map(entry => JSON.stringify(entry)).join("\\n") + "\\n");
}
`, { mode: 0o755 });
    const script = resolve(import.meta.dir, "../scripts/smoke-codex-web-subagents.ts");
    const wrapper = join(directory, "timeout-wrapper.ts");
    if (scenario === "timeout") {
      writeFileSync(wrapper, `const original = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 8 * 60_000 ? 500 : delay, ...args);
process.argv = [process.execPath, ${JSON.stringify(script)}, ${JSON.stringify(codex)}];
await import(${JSON.stringify(script)});
`);
    }
    const child = Bun.spawn([process.execPath, scenario === "timeout" ? wrapper : script, codex], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: directory },
      stdout: "pipe", stderr: "pipe",
    });
    let watchdogExpired = false;
    const timeout = setTimeout(() => { watchdogExpired = true; child.kill("SIGKILL"); }, 10_000);
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timeout));
    expect(watchdogExpired).toBeFalse();
    return { exit, stdout, stderr, received };
  } finally {
    upstream.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

const posixCliTest = test.skipIf(process.platform === "win32");

posixCliTest("the live smoke blocks a fake Codex Pro fallback before the bridge receives it", async () => {
  const result = await runCliFixture("pro");
  expect(result.exit).not.toBe(0);
  expect(result.received).toHaveLength(0);
  expect(result.stdout + result.stderr).toContain("SMOKE_POLICY_STATUS 403");
}, 15_000);

posixCliTest("the actual smoke script completes with a fake Codex using its isolated model catalog", async () => {
  const result = await runCliFixture("allowed");
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("LIVE_WEB_SUBAGENT_CHAIN_OK model=chatgpt-web/gpt-5.6-sol root=medium child=high");
  expect(result.received).toEqual(["medium", "high"].map(effort => expect.objectContaining({
    model: WEB_SUBAGENT_SMOKE_MODEL, reasoning: { effort },
  })));
}, 15_000);

posixCliTest("a rejected request cannot be hidden by apparently successful fake Codex rollouts", async () => {
  const result = await runCliFixture("rejected-then-complete");
  expect(result.exit).not.toBe(0);
  expect(result.received).toHaveLength(0);
  expect(result.stderr).toContain("request guard rejected the smoke: smoke_model_rejected");
  expect(result.stderr).not.toContain("missing root rollout");
}, 15_000);

posixCliTest("a fake Codex startup failure closes the smoke relay and exits promptly", async () => {
  const result = await runCliFixture("startup-error");
  expect(result.exit).not.toBe(0);
  expect(result.received).toHaveLength(0);
  expect(result.stderr).toContain("ENOENT");
}, 15_000);

posixCliTest("the smoke timeout kills fake Codex and closes its local relay", async () => {
  const result = await runCliFixture("timeout");
  expect(result.exit).not.toBe(0);
  expect(result.received).toHaveLength(1);
  expect(result.stderr).toContain("Live Web subagent smoke timed out after 8 minutes");
}, 15_000);

for (const [scenario, failure] of [
  ["missing-child-completion", "child never completed"],
  ["wrong-child-version", "child did not return the acceptance marker"],
  ["unlinked-child", "child rollout is not linked to the root"],
  ["wrong-wait-child", "root never called wait_agent for the exact child id"],
  ["uncorrelated-wait-output", "root never received the exact child's completed result"],
  ["wrong-result-child", "root never received the exact child's completed result"],
  ["errored-wait", "root never received the exact child's completed result"],
] as const) {
  posixCliTest(`the actual smoke rejects fake Codex lifecycle failure: ${scenario}`, async () => {
    const result = await runCliFixture(scenario);
    expect(result.exit).not.toBe(0);
    expect(result.received).toHaveLength(2);
    expect(result.stderr).toContain(failure);
  }, 15_000);
}
