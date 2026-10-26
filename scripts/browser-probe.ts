// Bundled against rev37 source; executes in the real candidate image, never with production state.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { defaultConfig, providerConfig } from "../src/config";
import { managedChromeLaunchOptions, resolveBrowserConfig, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { connectLauncherBrowserHost, inspectLauncherBrowserHostLiveness, readLauncherBrowserHostDescriptor, notifyLauncherTurn } from "../src/launcher-browser-host";

const stage = process.argv[2] ?? "managed";
const evidence = "/state/evidence";
mkdirSync(evidence, { recursive: true });
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejects(action: () => unknown | Promise<unknown>, pattern: RegExp) {
  try { await action(); } catch (error) {
    check(pattern.test(String(error)), "unexpected rejection: " + String(error)); return String(error);
  }
  throw new Error("operation unexpectedly succeeded: " + pattern);
}
const fixture = `<!doctype html><html><head><title>Isolated browser qualification</title></head><body>
<h1>Independent browser — synthetic data only</h1><label>Value <input id="value"></label>
<button onclick="document.querySelector('#result').textContent=document.querySelector('#value').value">Apply</button>
<p id="result">waiting</p></body></html>`;
const result: Record<string, unknown> = { stage, realBrowser: true, authenticatedChatGpt: false, productionAccess: false };
if (stage === "managed") {
  const config = { ...defaultConfig("browser-only"), headed: false,
    chromeExecutablePath: "/browser-artifacts/chrome/chrome", chromiumSandbox: true,
    storageStatePath: "/state/managed-runtime/no-auth-state.json" };
  const provider = providerConfig(config);
  const resolved = resolveBrowserConfig(provider);
  const launch = managedChromeLaunchOptions(resolved);
  check(launch.chromiumSandbox === true, "sandbox opt-in not forwarded");
  const worker = ChatGptBrowserWorker.forProvider(provider);
  result.nativeUnauthenticatedGuard = await rejects(() => (worker as any).ensurePage(), /login state is missing/);
  await worker.close();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(fixture, { headers: { "content-type": "text/html" } }) });
  const origin = `http://127.0.0.1:${server.port}`;
  let browser = await chromium.launch(launch);
  try {
    let context = await browser.newContext();
    let page = await context.newPage();
    await page.goto("chrome://sandbox");
    const sandbox = await page.locator("body").innerText();
    const namespaceSandbox = /Namespace Sandbox\s+Yes/i.test(sandbox)
      || (/Layer 1 Sandbox\s+Namespace/i.test(sandbox) && /PID namespaces\s+Yes/i.test(sandbox) && /Network namespaces\s+Yes/i.test(sandbox));
    check(namespaceSandbox && /Seccomp-BPF sandbox\s+Yes/i.test(sandbox), "browser sandbox is not active: " + sandbox);
    // This is the private test pod's /proc, not the host. Do not enable automation just to inspect flags.
    const processes: Array<{ pid: number; noSandboxFlag: boolean; browserMain: boolean }> = [];
    for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (argv[0] === config.chromeExecutablePath) processes.push({ pid: Number(pid),
          noSandboxFlag: argv.includes("--no-sandbox"), browserMain: !argv.some(arg => arg.startsWith("--type=")) });
      } catch {} // A sandbox child can exit or become unreadable between the two reads.
    }
    check(processes.some(process => process.browserMain) && processes.every(process => !process.noSandboxFlag), "owned Chrome main process not found or sandbox disabled");
    result.sandbox = { namespace: true, seccompBpf: true, noSandboxFlag: false, processes, internals: sandbox };
    result.browserVersion = browser.version();
    await page.goto(origin);
    await page.locator("#value").fill("managed-real-dom");
    await page.getByRole("button", { name: "Apply" }).click();
    check(await page.locator("#result").innerText() === "managed-real-dom", "real managed DOM interaction failed");
    await context.addCookies([{ name: "synthetic_fixture", value: "retained", url: origin }]);
    await page.evaluate(() => localStorage.setItem("qualification", "retained"));
    const stateFile = evidence + "/managed-local-state.json";
    await context.storageState({ path: stateFile });
    await page.screenshot({ path: evidence + "/managed-dom.png" });
    await browser.close();
    browser = await chromium.launch(launch);
    context = await browser.newContext({ storageState: stateFile });
    page = await context.newPage();
    await page.goto(origin);
    check((await context.cookies(origin)).some(cookie => cookie.name === "synthetic_fixture" && cookie.value === "retained"), "synthetic browser cookie lost across replacement");
    check(await page.evaluate(() => localStorage.getItem("qualification")) === "retained", "synthetic local storage lost across replacement");
    result.domInteraction = true;
    result.syntheticStateAcrossBrowserReplacement = true;
  } finally { await browser.close(); server.stop(true); }
} else if (stage === "launcher") {
  const path = "/state/launcher-core/runtime/launcher-browser.json";
  const descriptor = await inspectLauncherBrowserHostLiveness(path, { expectedProfile: "production", timeoutMs: 5000 });
  result.descriptor = { pid: descriptor.pid, endpoint: descriptor.endpoint, controlEndpoint: descriptor.control.endpoint,
    profile: descriptor.profile, helper: descriptor.helper, targetCount: Object.keys(descriptor.surfaceTargets).length,
    ownerUid: process.getuid?.(), privatePermissionsRequired: true };
  const unauthorized = await fetch(descriptor.control.endpoint);
  check(unauthorized.status === 401, "real launcher control did not reject missing auth");
  const authorized = await fetch(descriptor.control.endpoint, { headers: { authorization: "Bearer " + descriptor.control.token } });
  check(authorized.status === 404, "real launcher control token not accepted");
  result.controlAuth = { missingToken: unauthorized.status, validTokenUnknownRoute: authorized.status };
  // The idle surface is intentionally not attached to a visible view. Acquire the real native
  // lease instead of forcing pointer events into a zero-sized page or overriding its viewport.
  const traceId = "q37-browser-" + crypto.randomUUID();
  const lease = await notifyLauncherTurn(path, { phase: "start", traceId, helperPid: process.pid });
  const connection = await connectLauncherBrowserHost(path, 10000, lease.surfaceId);
  try {
    const page = connection.page;
    const originalUrl = page.url();
    await page.setContent(fixture);
    await page.locator("#value").fill("launcher-real-cdp");
    await page.getByRole("button", { name: "Apply" }).click();
    check(await page.locator("#result").innerText() === "launcher-real-cdp", "real launcher CDP/DOM interaction failed");
    try {
      await page.screenshot({ path: evidence + "/launcher-dom.png", timeout: 5000 });
      result.capture = { status: "passed" };
    } catch (error) {
      // Keep the observed render failure as a failure; still check independent helper/recovery paths.
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      result.capture = { status: "failed", error: error.message, productionGate: "repeated Electron capture qualification" };
    }
    check(page.url() === originalUrl, "qualification navigated the owned idle target");
    result.domInteraction = true;
    result.nativeOwnedTargetSelected = true;
    const config = resolveBrowserConfig({ ...providerConfig({ ...defaultConfig("full"), browserHost: "launcher",
      browserHostDescriptorPath: path }), chatgptWeb: {
        ...providerConfig({ ...defaultConfig("full"), browserHost: "launcher", browserHostDescriptorPath: path }).chatgptWeb,
        browserHelperScriptPath: (process.env.QUALIFICATION_RUNTIME_ROOT ?? "/opt/codex-chatgpt-web") + "/app/browser-helper.cjs",
      } });
    const helper = new LauncherBrowserHelperClient(config);
    try {
      await (helper as any).ensureChild();
      const child = (helper as any).child;
      check(child?.pid && child.spawnargs[1] === config.browserHelperScriptPath, "not consuming the target bundled helper");
      result.actualHelper = { pid: child.pid, executable: child.spawnargs[0], script: child.spawnargs[1], ready: true,
        features: [...(helper as any).helperFeatures] };
    } finally { await helper.close(); }
  } finally {
    await connection.browser.close();
    await notifyLauncherTurn(path, { phase: "end", traceId, helperPid: process.pid, status: "aborted",
      message: "Isolated browser qualification; no ChatGPT message was sent" });
    result.nativeLeaseAcquiredAndReleased = true;
  }
  // Reject stale/foreign descriptors; modify copies, never the actual launcher descriptor.
  const stale = evidence + "/stale-descriptor.json";
  writeFileSync(stale, JSON.stringify({ ...descriptor, pid: 1073741824 }), { mode: 0o600 });
  result.stalePidRejected = await rejects(() => readLauncherBrowserHostDescriptor(stale), /process is not running/);
  const unsafe = evidence + "/unsafe-descriptor.json";
  writeFileSync(unsafe, JSON.stringify(descriptor), { mode: 0o600 }); chmodSync(unsafe, 0o644);
  result.unsafePermissionsRejected = await rejects(() => readLauncherBrowserHostDescriptor(unsafe), /unsafe permissions/);
  const broken = evidence + "/broken-endpoint.json";
  writeFileSync(broken, JSON.stringify({ ...descriptor, endpoint: "http://127.0.0.1:9" }), { mode: 0o600 });
  result.brokenCdpRejected = await rejects(() => inspectLauncherBrowserHostLiveness(broken, { timeoutMs: 300 }), /CDP endpoint is not ready/);
  result.wrongProfileRejected = await rejects(() => inspectLauncherBrowserHostLiveness(path, { expectedProfile: "development" }), /production, but development/);
  check(existsSync(`/proc/${descriptor.pid}`), "disconnect/helper shutdown stopped the launcher");
  result.launcherSurvivedDisconnectAndHelperShutdown = true;
} else throw new Error("unknown stage");
result.status = (result.capture as any)?.status === "failed" ? "completed_with_observation_failures" : "passed";
writeFileSync(evidence + "/" + stage + "-result.json", JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
