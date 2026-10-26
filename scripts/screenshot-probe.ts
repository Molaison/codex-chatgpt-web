// Real native Launcher leases; synthetic DOM only, no authentication or provider calls.
import { writeFileSync, mkdirSync } from "node:fs";
import { captureChatGptBrowserDiagnosticScreenshot } from "../src/adapters/chatgpt-web/browser-worker";
import { connectLauncherBrowserHost, notifyLauncherTurn } from "../src/launcher-browser-host";
const path = "/state/launcher-core/runtime/launcher-browser.json";
const evidence = "/state/evidence";
mkdirSync(evidence, { recursive: true });
const checks: unknown[] = [];
const diagnostic = process.argv.includes("--diagnostic");

const checkpoint = () => writeFileSync(evidence + "/screenshot-result.json", JSON.stringify({ diagnostic, checks }, null, 2));
for (let turn = 0; turn < (diagnostic ? 1 : 4); turn++) {
  const traceId = "q38-capture-" + crypto.randomUUID();
  const lease = await notifyLauncherTurn(path, { phase: "start", traceId, helperPid: process.pid });
  let connection = await connectLauncherBrowserHost(path, 10000, lease.surfaceId);
  try {
    let page = connection.page;
    await page.setContent(`<!doctype html><html><body style="background:white;color:#142434;font:24px sans-serif"><h1>Isolated capture — turn ${turn}</h1><label>Value <input id="value"></label><button onclick="document.querySelector('#result').textContent=document.querySelector('#value').value">Apply</button><p id="result">waiting</p></body></html>`);
    await page.locator("#value").fill("capture-" + turn);
    await page.getByRole("button", { name: "Apply" }).click();
    if (await page.locator("#result").innerText() !== "capture-" + turn) throw Error("real input failed");
    const cdp = await connection.context.newCDPSession(page);
    const layout = await cdp.send("Page.getLayoutMetrics");
    const dom = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, visibility: document.visibilityState, hidden: document.hidden, focused: document.hasFocus() }));
    for (let repeat = 0; repeat < 2; repeat++) {
      const start = performance.now();
      const row: any = { turn, repeat, lease: lease.surfaceId, layout, dom };
      try {
        const bytes = diagnostic
          ? await page.screenshot({ timeout: 5000 })
          : await captureChatGptBrowserDiagnosticScreenshot(page, "launcher");
        writeFileSync(`${evidence}/capture-${turn}-${repeat}.png`, bytes);
        if (bytes.readUInt32BE(16) !== dom.width || bytes.readUInt32BE(20) !== dom.height) throw Error("PNG viewport changed");
        row.status = "passed"; row.bytes = bytes.length;
      } catch (error) { row.status = "failed"; row.error = String(error); }
      row.ms = Math.round(performance.now() - start);
      checks.push(row); checkpoint();
      if (row.status !== "passed" && !diagnostic) throw Error("required repeated capture failed");
      if (row.status !== "passed" && diagnostic) {
        for (const fromSurface of [true, false]) {
          const start = performance.now();
          try {
            const shot: any = await Promise.race([cdp.send("Page.captureScreenshot", { format: "png", fromSurface, captureBeyondViewport: false }), new Promise((_, reject) => setTimeout(() => reject(Error("CDP 3s timeout")), 3000))]);
            writeFileSync(`${evidence}/raw-${turn}-${repeat}-${fromSurface}.png`, Buffer.from(shot.data, "base64"));
            checks.push({ turn, repeat, fromSurface, status: "passed", ms: Math.round(performance.now() - start), bytes: shot.data.length });
          } catch (error) { checks.push({ turn, repeat, fromSurface, status: "failed", error: String(error) }); }
          checkpoint();
        }
      }
      if (repeat === 0) {
        await connection.browser.close();
        await notifyLauncherTurn(path, { phase: "heartbeat", traceId, helperPid: process.pid, refreshViewport: true });
        connection = await connectLauncherBrowserHost(path, 10000, lease.surfaceId);
        page = connection.page;
      }
    }
  } finally {
    await connection.browser.close();
    await notifyLauncherTurn(path, { phase: "end", traceId, helperPid: process.pid, status: "aborted", message: "Synthetic capture qualification; no ChatGPT message sent" });
  }
}
if (checks.some((x: any) => x.status !== "passed")) process.exit(1);
