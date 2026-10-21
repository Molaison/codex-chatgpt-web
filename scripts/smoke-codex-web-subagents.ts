import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config";
import { createWebSubagentSmokeGuard, webSubagentSmokeCatalog, WEB_SUBAGENT_SMOKE_MODEL } from "./live-web-smoke-guard";

const codexArg = process.argv.slice(2).find(argument => !argument.startsWith("--"));
const codex = resolve(codexArg ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
if (!existsSync(codex)) throw new Error(`Codex executable is missing: ${codex}`);

const runtimeConfig = loadConfig();

const bundled = spawnSync(codex, ["debug", "models", "--bundled"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 15_000,
});
if (bundled.status !== 0) {
  throw new Error(`Could not read bundled Codex models: ${bundled.error?.message || bundled.stderr}`);
}

const catalog = webSubagentSmokeCatalog(JSON.parse(bundled.stdout), runtimeConfig);
const guard = createWebSubagentSmokeGuard(loadConfig);
const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-live-subagents-"));
let relay: ReturnType<typeof Bun.serve> | undefined;
try {
  relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => guard.fetch(request) });
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  const catalogPath = join(root, "models.json");
  writeFileSync(
    catalogPath,
    `${JSON.stringify(catalog)}\n`,
  );

  const bridgeBaseUrl = `http://127.0.0.1:${relay.port}/v1`;
  writeFileSync(join(codexHome, "config.toml"), [
    `model = ${JSON.stringify(WEB_SUBAGENT_SMOKE_MODEL)}`,
    'model_reasoning_effort = "medium"',
    'model_provider = "live_bridge"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "",
    "[model_providers.live_bridge]",
    'name = "Live codex-chatgpt-web bridge"',
    `base_url = ${JSON.stringify(bridgeBaseUrl)}`,
    'env_key = "CODEX_WEB_LIVE_SMOKE_KEY"',
    'wire_api = "responses"',
    "supports_websockets = false",
    "",
    "[agents]",
    "max_depth = 2",
    "",
    "[features]",
    "multi_agent = true",
    "multi_agent_v2 = false",
    "",
  ].join("\n"));

  const expectedVersion = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    version?: unknown;
  }).version;
  if (typeof expectedVersion !== "string" || !expectedVersion) {
    throw new Error("Repository package.json has no version");
  }

  const prompt = [
    "Use the available agent tools; do not read package.json in the parent yourself.",
    `Spawn exactly one child with model ${WEB_SUBAGENT_SMOKE_MODEL}, reasoning_effort high, and no forked history.`,
    "Ask it to read package.json through its repository tools and return CHILD_RESULT followed by the",
    "exact version. Wait for that exact child id even if it has already completed, then return",
    "LIVE_WEB_SUBAGENT_OK followed by the same version.",
    "Do not use fallback models. If any requested model or agent operation is unavailable, fail explicitly.",
  ].join(" ");

  interface RolloutRecord {
    type?: string;
    payload?: Record<string, unknown>;
  }

  function rolloutFiles(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) result.push(...rolloutFiles(path));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
    }
    return result;
  }

  function records(path: string): RolloutRecord[] {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as RolloutRecord);
  }

  function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  function jsonObject(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "string") return undefined;
    try { return object(JSON.parse(value)); } catch { return undefined; }
  }

  function subagentDepth(meta: RolloutRecord | undefined): number {
    const source = object(meta?.payload?.source);
    const subagent = object(source?.subagent);
    const spawn = object(subagent?.thread_spawn);
    return typeof spawn?.depth === "number" ? spawn.depth : 0;
  }

  function responseItems(entries: RolloutRecord[]): Record<string, unknown>[] {
    return entries
      .filter(entry => entry.type === "response_item")
      .flatMap(entry => object(entry.payload) ? [entry.payload!] : []);
  }

  function compactOutput(value: string): string {
    return value.length <= 8_000 ? value : value.slice(-8_000);
  }

  const processHandle = Bun.spawn([
    codex,
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    WEB_SUBAGENT_SMOKE_MODEL,
    prompt,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_WEB_LIVE_SMOKE_KEY: "loopback-live-smoke",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: [number, string, string];
  try {
    result = await Promise.race([
      Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Live Web subagent smoke timed out after 8 minutes")), 8 * 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
  }
  const [exitCode, stdout, stderr] = result;

  const files = existsSync(join(codexHome, "sessions")) ? rolloutFiles(join(codexHome, "sessions")) : [];
  const sessions = files.map(path => {
    const entries = records(path);
    const meta = entries.find(entry => entry.type === "session_meta");
    const context = entries.find(entry => entry.type === "turn_context");
    const completion = entries.find(entry => entry.type === "event_msg"
      && object(entry.payload)?.type === "task_complete");
    return { path, entries, meta, context, completion, depth: subagentDepth(meta) };
  });
  const rootSessions = sessions.filter(session => session.depth === 0);
  const childSessions = sessions.filter(session => session.depth === 1);
  const rootSession = rootSessions[0];
  const childSession = childSessions[0];
  const failures: string[] = [];
  if (exitCode !== 0) failures.push(`Codex exited ${exitCode}`);
  if (guard.failure) failures.push(`request guard rejected the smoke: ${guard.failure}`);
  if (!rootSession) failures.push("missing root rollout");
  if (!childSession) failures.push("missing depth-1 Web child rollout");
  if (rootSessions.length !== 1 || childSessions.length !== 1 || sessions.length !== 2) {
    failures.push("expected exactly one root and one child rollout");
  }

  for (const [label, session, expectedEffort, marker] of [
    ["root", rootSession, "medium", "LIVE_WEB_SUBAGENT_OK"],
    ["child", childSession, "high", "CHILD_RESULT"],
  ] as const) {
    const context = object(session?.context?.payload);
    if (context?.cwd !== process.cwd()) failures.push(`${label} did not inherit the repository cwd`);
    const contexts = session?.entries.filter(entry => entry.type === "turn_context") ?? [];
    if (contexts.length === 0 || contexts.some(entry => entry.payload?.model !== WEB_SUBAGENT_SMOKE_MODEL
      || entry.payload?.effort !== expectedEffort)) {
      failures.push(`${label} did not stay on ${WEB_SUBAGENT_SMOKE_MODEL}/${expectedEffort}`);
    }
    if (context?.multi_agent_version !== "v1") failures.push(`${label} did not run on Compatibility V1`);
    const completion = object(session?.completion?.payload);
    if (!completion) failures.push(`${label} never completed`);
    if (completion?.error != null) failures.push(`${label} completed with ${JSON.stringify(completion.error)}`);
    const finalMessage = completion?.last_agent_message;
    if (typeof finalMessage !== "string" || !finalMessage.includes(marker) || !finalMessage.includes(expectedVersion)) {
      failures.push(`${label} did not return the acceptance marker for version ${expectedVersion}`);
    }
  }

  const rootId = rootSession?.meta?.payload?.id;
  const childId = childSession?.meta?.payload?.id;
  const childSource = object(childSession?.meta?.payload?.source);
  const childSpawn = object(object(childSource?.subagent)?.thread_spawn);
  if (typeof rootId !== "string" || !rootId || typeof childId !== "string" || !childId || rootId === childId
    || childSpawn?.parent_thread_id !== rootId) {
    failures.push("child rollout is not linked to the root");
  }
  const items = rootSession ? responseItems(rootSession.entries) : [];
  const waits = items.filter(item => {
    const targets = jsonObject(item.arguments)?.targets;
    return item.type === "function_call" && item.name === "wait_agent" && typeof item.call_id === "string"
      && Array.isArray(targets) && targets.length === 1 && targets[0] === childId;
  });
  if (waits.length === 0) failures.push("root never called wait_agent for the exact child id");
  const completedWait = waits.some(wait => items.some(item => {
    if (item.type !== "function_call_output" || item.call_id !== wait.call_id || typeof childId !== "string") return false;
    const output = jsonObject(item.output);
    const status = object(object(output?.status)?.[childId]);
    return output?.timed_out === false && typeof status?.completed === "string"
      && status.completed.includes("CHILD_RESULT") && status.completed.includes(expectedVersion);
  }));
  if (!completedWait) {
    failures.push("root never received the exact child's completed result from wait_agent");
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.join("; ")}\nCodex stdout:\n${compactOutput(stdout)}\nCodex stderr:\n${compactOutput(stderr)}`,
    );
  }
  process.stdout.write(
    `LIVE_WEB_SUBAGENT_CHAIN_OK model=${WEB_SUBAGENT_SMOKE_MODEL} root=medium child=high version=${expectedVersion}\n`,
  );
} finally {
  guard.close();
  relay?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
