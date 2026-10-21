import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Run with Bun and an explicit checkout. This script never delegates to real fetch.
const checkoutArg = process.env.SMOKE_AUDIT_UPSTREAM_ROOT;
if (!checkoutArg || !isAbsolute(checkoutArg)) {
  throw new Error("Set SMOKE_AUDIT_UPSTREAM_ROOT to an absolute codex-chatgpt-web checkout path");
}
const checkout = resolve(checkoutArg);
const revision = spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
assert.equal(revision.status, 0, "The selected checkout must have a readable Git revision");
const sourcePaths = ["scripts/live-web-smoke-guard.ts", "src/server.ts", "src/config.ts",
  "src/responses/parser.ts", "src/chatgpt-web-models.ts", "src/model-catalog.ts"];
const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path,
  createHash("sha256").update(readFileSync(join(checkout, path))).digest("hex")]));
const root = mkdtempSync(join(tmpdir(), "independent-smoke-review-"));
const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;
const originalFetch = globalThis.fetch;
process.env.CODEX_CHATGPT_WEB_HOME = root;
globalThis.fetch = (async () => { throw new Error("All real network access is disabled in this replay"); }) as typeof fetch;

try {
  const moduleUrl = (path: string) => pathToFileURL(join(checkout, path)).href;
  const [{ defaultConfig }, { responseRequest }, { createWebSubagentSmokeGuard, WEB_SUBAGENT_SMOKE_MODEL }] = await Promise.all([
    import(moduleUrl("src/config.ts")), import(moduleUrl("src/server.ts")),
    import(moduleUrl("scripts/live-web-smoke-guard.ts")),
  ]);
  const config = { ...defaultConfig("browser-only"), browserHost: "launcher",
    solAvailable: true, proAvailable: true, port: 43231 };
  const observations: Array<{ model: string; family: unknown; pro: unknown; effort: unknown }> = [];
  let forwarded = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "http://127.0.0.1:43231/v1/responses", "Every other network path is forbidden");
    assert.equal(init?.redirect, "manual");
    forwarded++;
    return responseRequest(request, config, () => ({
      name: "offline-independent-review",
      async runTurn(parsed, _raw, emit) {
        observations.push({ model: parsed.modelId, family: parsed._chatgptModelFamily,
          pro: parsed._chatgptProModel, effort: parsed.options.reasoning });
        emit({ type: "text_delta", text: "review fixture", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }), { rememberState: false });
  }) as typeof fetch;
  const base = { model: WEB_SUBAGENT_SMOKE_MODEL, reasoning: { effort: "medium" }, input: "synthetic review", stream: false };
  const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const variants = [
    {}, { _chatgptProModel: true }, { _chatgptModelFamily: "6" }, { modelId: "gpt-6-pro" },
    { options: { reasoning: "max", model: "gpt-6-pro" } }, { reasoning_effort: "max" },
    { _rawBody: { model: "chatgpt-web/gpt-6-pro", reasoning: { effort: "max" } } },
    { service_tier: "fast" }, { metadata: { model: "chatgpt-web/gpt-6-pro" } },
    { client_metadata: { model: "chatgpt-web/gpt-6-pro", "x-codex-turn-metadata": JSON.stringify({
      model: "chatgpt-web/gpt-6-pro", reasoning_effort: "max", _chatgptProModel: true,
    }) } },
  ];
  for (const effort of ["medium", "high"]) {
    for (const extra of variants) {
      const guard = createWebSubagentSmokeGuard(() => config);
      try {
        const response = await guard.fetch(request({ ...base, reasoning: { effort }, ...extra }, {
          "x-codex-turn-metadata": JSON.stringify({ model: "chatgpt-web/gpt-6-pro", turn_trigger: "composer_predictions", request_kind: "turn" }),
        }));
        assert.equal(response.status, 200, await response.clone().text());
        await response.text();
        assert.deepEqual(observations.at(-1), { model: "gpt-5.6-sol", family: "5.6", pro: undefined, effort });
        assert.equal(guard.failure, undefined);
      } finally { guard.close(); }
    }
  }
  const beforeDenied = forwarded;
  const denied = [
    { ...base, model: "chatgpt-web/gpt-6-pro" }, { ...base, model: "chatgpt-web/pro" },
    { ...base, model: "gpt-5.6-sol" }, { ...base, model: "chatgpt-web/high" },
    { ...base, model: "chatgpt-web/gpt-6-sol" }, { ...base, model: WEB_SUBAGENT_SMOKE_MODEL + " " },
    { ...base, reasoning: undefined }, { ...base, reasoning: { effort: "ultra" } },
    { ...base, reasoning: { effort: "max" } },
    { ...base, client_metadata: { "x-codex-turn-metadata": { request_kind: "turn", turn_trigger: "composer_predictions" } } },
  ];
  for (const value of denied) {
    const guard = createWebSubagentSmokeGuard(() => config);
    try {
      const response = await guard.fetch(request(value));
      assert.equal(response.status, 403);
      await response.text();
      assert.equal(guard.failure, "smoke_model_rejected");
    } finally { guard.close(); }
  }
  assert.equal(forwarded, beforeDenied);
  const guard = createWebSubagentSmokeGuard(() => config);
  try {
    const response = await guard.fetch(request({ ...base, previous_response_id: "independent-review-missing-response" }));
    assert.equal(response.status, 409);
    assert.match(await response.text(), /continuation state/);
    assert.equal(observations.length, variants.length * 2);
  } finally { guard.close(); }
  console.log(JSON.stringify({ status: "passed", upstreamHead: revision.stdout.trim(), sourceSha256,
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    productionHandlerRequests: forwarded, syntheticAdapterCalls: observations.length,
    allowedInjectionVariants: variants.length * 2, deniedVariants: denied.length,
    missingPreviousResponseSafelyRejected: true, realNetworkCalls: 0, realModelCalls: 0,
    realBrowserSend: 0, realPdfUploads: 0 }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
}
