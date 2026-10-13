import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatGptBrowserWorker, resolveBrowserConfig, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { CHATGPT_WEB_MODEL_ID, CHATGPT_WEB_LUNA_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { DEFAULT_CHATGPT_STANDARD_CONCURRENCY, DEFAULT_CHATGPT_PRO_CONCURRENCY, MAX_CHATGPT_BROWSER_TABS } from "../src/adapters/chatgpt-web/concurrency";
import { defaultConfig, providerConfig } from "../src/config";
import type { CodexProviderConfig } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const limitError = { status: 429, errorType: "rate_limit_error", code: "concurrency_limit_exceeded", retryable: true };
type Settings = NonNullable<CodexProviderConfig["chatgptWeb"]>;
const provider = (settings: Settings = {}): CodexProviderConfig => ({
  adapter: "chatgpt-web", baseUrl: "browser://qa-concurrency", chatgptWeb: { accountId: randomUUID(), ...settings },
});
const turn = (options: Partial<BrowserTurn> = {}): BrowserTurn => ({
  traceId: randomUUID(), modelId: CHATGPT_WEB_MODEL_ID, reasoning: "high", capabilities,
  prepare: async () => ({ text: "test", images: [], release() {} }), onTextDelta() {}, ...options,
});

/** Only generation is simulated: admission, accounting and cleanup run through the real worker. */
function fixture(settings: Settings = {}, helper = false) {
  const configured = provider({
    ...(helper ? { browserHost: "launcher", browserHostDescriptorPath: join(tmpdir(), randomUUID() + ".json") } : {}),
    ...settings,
  });
  const worker = ChatGptBrowserWorker.forProvider(configured);
  const executions = new Map<string, { resolve: () => void; reject: (reason: unknown) => void }>();
  const submitted: Promise<string>[] = [];
  const execute = (current: BrowserTurn): Promise<string> => new Promise((resolve, reject) => {
    const abort = () => fail(new DOMException("cancelled generation", "AbortError"));
    const cleanup = () => { executions.delete(current.traceId); current.abortSignal?.removeEventListener("abort", abort); };
    const fail = (reason: unknown) => { cleanup(); reject(reason); };
    if (current.abortSignal?.aborted) { fail(new DOMException("cancelled generation", "AbortError")); return; }
    executions.set(current.traceId, { resolve: () => { cleanup(); resolve("OK"); }, reject: fail });
    current.abortSignal?.addEventListener("abort", abort, { once: true });
  });
  const spy = helper
    ? spyOn(LauncherBrowserHelperClient.prototype, "run").mockImplementation(execute)
    : spyOn(worker as unknown as { runExclusive: typeof execute }, "runExclusive").mockImplementation(execute);
  return {
    worker, configured, executions, spy,
    start(current: BrowserTurn = turn()) {
      const promise = worker.run(current);
      submitted.push(promise);
      void promise.catch(() => {});
      return { current, promise };
    },
    async ready() { await Promise.resolve(); },
    async close() {
      for (const pending of executions.values()) pending.resolve();
      await Promise.allSettled(submitted);
      spy.mockRestore();
      await worker.close();
    },
  };
}

test("concurrency defaults and config overrides survive provider resolution", () => {
  expect(MAX_CHATGPT_BROWSER_TABS).toBe(5);
  expect(DEFAULT_CHATGPT_STANDARD_CONCURRENCY).toBe(5);
  expect(DEFAULT_CHATGPT_PRO_CONCURRENCY).toBe(2);
  const config = defaultConfig();
  config.standardConcurrencyLimit = 3;
  config.proConcurrencyLimit = 1;
  expect(resolveBrowserConfig(providerConfig(config))).toMatchObject({ standardConcurrencyLimit: 3, proConcurrencyLimit: 1 });
  expect(resolveBrowserConfig(provider())).toMatchObject({ standardConcurrencyLimit: 5, proConcurrencyLimit: 2 });
});

test.each([0, -1, 1.5, 6, NaN, Infinity, "2", false])("worker rejects invalid concurrency override %s", invalid => {
  for (const name of ["standardConcurrencyLimit", "proConcurrencyLimit"] as const) {
    expect(() => resolveBrowserConfig(provider({ [name]: invalid } as unknown as Settings)))
      .toThrow(name + " must be an integer from 1 to 5");
  }
});

test.each([
  { reasoning: "high", standardConcurrencyLimit: 2, proConcurrencyLimit: 1, limit: 2 },
  { reasoning: "max", standardConcurrencyLimit: 2, proConcurrencyLimit: 1, limit: 1 },
  { reasoning: "max", standardConcurrencyLimit: 1, proConcurrencyLimit: 4, limit: 4 },
])("configured limit admits exactly $limit $reasoning turns under a simultaneous burst", async spec => {
  const f = fixture(spec);
  try {
    const burst = Array.from({ length: 40 }, () => f.start(turn({ reasoning: spec.reasoning })));
    await f.ready();
    expect(f.spy).toHaveBeenCalledTimes(spec.limit);
    expect(f.executions.size).toBe(spec.limit);
    for (const pending of burst.slice(spec.limit)) await expect(pending.promise).rejects.toMatchObject(limitError);
  } finally { await f.close(); }
});

test("Pro and ordinary counters are independent while their combined browser cap stays five", async () => {
  const f = fixture({ standardConcurrencyLimit: 5, proConcurrencyLimit: 2 });
  try {
    f.start(turn({ reasoning: "max" })); f.start(turn({ reasoning: "max" }));
    await expect(f.start(turn({ reasoning: "max" })).promise).rejects.toMatchObject(limitError);
    for (const reasoning of ["low", "medium", "xhigh"]) f.start(turn({ reasoning }));
    await f.ready();
    expect(f.spy).toHaveBeenCalledTimes(5);
    await expect(f.start().promise).rejects.toMatchObject(limitError);
  } finally { await f.close(); }
});

test("ordinary efforts and model families share their account's ordinary counter", async () => {
  const f = fixture({ standardConcurrencyLimit: 2 });
  try {
    f.start(turn({ reasoning: "low", modelFamily: "5.6" }));
    f.start(turn({ reasoning: "xhigh", modelFamily: "6" }));
    await expect(f.start(turn({ reasoning: "medium" })).promise).rejects.toMatchObject(limitError);
    await expect(f.start(turn({ reasoning: undefined })).promise).rejects.toMatchObject(limitError);
    f.start(turn({ reasoning: "max", modelFamily: "6" }));
    await f.ready();
    expect(f.spy).toHaveBeenCalledTimes(3);
  } finally { await f.close(); }
});

test("different accounts have independent capacity and may use identical trace identities", async () => {
  const first = fixture({ proConcurrencyLimit: 1 });
  const second = fixture({ proConcurrencyLimit: 1 });
  try {
    const shared = turn({ reasoning: "max" });
    first.start(shared); second.start(shared);
    await first.ready(); await second.ready();
    expect(first.spy).toHaveBeenCalledTimes(1); expect(second.spy).toHaveBeenCalledTimes(1);
    await expect(first.start(turn({ reasoning: "max" })).promise).rejects.toMatchObject(limitError);
    await expect(second.start(turn({ reasoning: "max" })).promise).rejects.toMatchObject(limitError);
    expect(ChatGptBrowserWorker.forProvider(first.configured)).toBe(first.worker);
  } finally { await first.close(); await second.close(); }
});

test("duplicate trace rejection never releases or replaces its existing reservation", async () => {
  const f = fixture({ proConcurrencyLimit: 1 });
  try {
    const current = turn({ reasoning: "max" });
    const accepted = f.start(current);
    await expect(f.start(current).promise).rejects.toThrow("Duplicate ChatGPT web browser turn");
    await expect(f.start(turn({ reasoning: "max" })).promise).rejects.toMatchObject(limitError);
    await f.ready();
    expect(f.spy).toHaveBeenCalledTimes(1);
    f.executions.get(current.traceId)!.resolve();
    await accepted.promise;
    const reused = f.start(current);
    await f.ready();
    f.executions.get(current.traceId)!.resolve();
    await expect(reused.promise).resolves.toBe("OK");
    expect(f.spy).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

test.each(["cancel", "failure", "success"] as const)("%s releases only its own Pro slot", async outcome => {
  const f = fixture({ proConcurrencyLimit: 2 });
  try {
    const controller = new AbortController();
    const first = f.start(turn({ reasoning: "max", abortSignal: controller.signal }));
    const second = f.start(turn({ reasoning: "max" }));
    await f.ready();
    if (outcome === "cancel") controller.abort();
    else if (outcome === "failure") f.executions.get(first.current.traceId)!.reject(new Error("generation failed"));
    else f.executions.get(first.current.traceId)!.resolve();
    if (outcome === "success") await expect(first.promise).resolves.toBe("OK");
    else await expect(first.promise).rejects.toThrow(outcome === "cancel" ? "cancelled generation" : "generation failed");
    const replacement = f.start(turn({ reasoning: "max" }));
    await f.ready();
    expect(f.executions.has(second.current.traceId)).toBe(true);
    expect(f.executions.has(replacement.current.traceId)).toBe(true);
    await expect(f.start(turn({ reasoning: "max" })).promise).rejects.toMatchObject(limitError);
  } finally { await f.close(); }
});

test("synchronous generation failure releases its reservation", async () => {
  const f = fixture({ standardConcurrencyLimit: 1 });
  try {
    f.spy.mockImplementationOnce(() => { throw new Error("sync failure"); });
    await expect(f.start().promise).rejects.toThrow("sync failure");
    f.start(); await f.ready();
    expect(f.executions.size).toBe(1);
    await expect(f.start().promise).rejects.toMatchObject(limitError);
  } finally { await f.close(); }
});

test("already cancelled turns release capacity and never retain a generation", async () => {
  const f = fixture({ standardConcurrencyLimit: 1 });
  try {
    const controller = new AbortController(); controller.abort();
    await expect(f.start(turn({ abortSignal: controller.signal })).promise).rejects.toMatchObject({ name: "AbortError" });
    expect(f.executions.size).toBe(0);
    f.start(); await f.ready();
    expect(f.executions.size).toBe(1);
  } finally { await f.close(); }
});

test("native and Zero Risk Pro share the Pro quota regardless of the latter's reasoning option", async () => {
  const f = fixture({ proConcurrencyLimit: 1 });
  try {
    const first = f.start(turn({ modelId: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, reasoning: "low" }));
    await expect(f.start(turn({ reasoning: "max" })).promise).rejects.toMatchObject(limitError);
    await f.ready(); f.executions.get(first.current.traceId)!.resolve(); await first.promise;
    f.start(turn({ reasoning: "max" }));
    await expect(f.start(turn({ modelId: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, reasoning: undefined })).promise).rejects.toMatchObject(limitError);
    f.start(turn({ modelId: CHATGPT_WEB_LUNA_MODEL_ID, reasoning: "medium" }));
    await f.ready(); expect(f.executions.size).toBe(2);
  } finally { await f.close(); }
});

test("launcher helper is reached only after admission and cannot bypass Pro or total limits", async () => {
  const previous = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  const f = fixture({ proConcurrencyLimit: 1, standardConcurrencyLimit: 5 }, true);
  try {
    const accepted = f.start(turn({ reasoning: "max" }));
    await expect(f.start(turn({ reasoning: "max" })).promise).rejects.toMatchObject(limitError);
    for (let i = 0; i < 4; i++) f.start();
    await expect(f.start().promise).rejects.toMatchObject(limitError);
    await f.ready(); expect(f.spy).toHaveBeenCalledTimes(5);
    f.executions.get(accepted.current.traceId)!.reject(new Error("helper stopped"));
    await expect(accepted.promise).rejects.toThrow("helper stopped");
    f.start(turn({ reasoning: "max" })); await f.ready();
    expect(f.spy).toHaveBeenCalledTimes(6);
  } finally {
    await f.close();
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = previous;
  }
});

test("helper-process execution itself still passes through the worker concurrency gate", async () => {
  const previous = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  const f = fixture({ browserHost: "launcher", browserHostDescriptorPath: join(tmpdir(), randomUUID() + ".json"), proConcurrencyLimit: 1 });
  try {
    f.start(turn({ reasoning: "max" }));
    await expect(f.start(turn({ reasoning: "max" })).promise).rejects.toMatchObject(limitError);
    await f.ready(); expect(f.spy).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = previous;
  }
});
