import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../src/config";
import * as integration from "../src/codex-integration";
import * as browserHost from "../src/launcher-browser-host";
import * as service from "../src/service";
import * as tunnel from "../src/tunnel";
import * as tunnelService from "../src/tunnel-service";
import { runDoctor } from "../src/doctor";

test.each(["automatic", "manual"] as const)("external HTTP %s doctor checks local ownership without claiming connector or proxy verification", async interaction => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-external-doctor-"));
  const config = {
    ...configModule.defaultConfig("full"),
    mcpProvider: "external-http" as const, browserInteractionMode: interaction,
    browserHost: "launcher" as const, browserHostDescriptorPath: join(root, "launcher.json"),
    appName: interaction === "manual" ? configModule.ZERO_RISK_CHATGPT_CONNECTOR_NAME : configModule.CHATGPT_CONNECTOR_NAME,
  };
  mkdirSync(join(root, "runtime"));
  writeFileSync(join(root, "runtime", "launcher-supervisor.json"), JSON.stringify({
    version: 1, ownerPid: process.pid, daemonPid: process.pid, tunnelPid: null, status: "ready",
  }));
  const forbidden = () => { throw new Error("doctor touched managed tunnel or automated browser"); };
  const mocks = [
    spyOn(configModule, "loadConfig").mockReturnValue(config),
    spyOn(configModule, "getConfigDir").mockReturnValue(root),
    spyOn(integration, "inspectCodexIntegration").mockReturnValue({ installed: true, errors: [] } as never),
    spyOn(browserHost, "inspectLauncherBrowserHostLiveness").mockResolvedValue({ pid: process.pid } as never),
    spyOn(browserHost, "readLauncherBrowserHostDescriptor").mockReturnValue({ pid: process.pid } as never),
    spyOn(browserHost, "inspectLauncherBrowserHost").mockImplementation(async () => {
      if (interaction === "manual") return forbidden();
      return { pid: process.pid } as never;
    }),
    spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(tunnel, "tunnelStatus").mockImplementation(forbidden),
    spyOn(tunnelService, "getTunnelServiceStatus").mockImplementation(forbidden),
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      service: "codex-chatgpt-web", status: "ok", mode: "full", version: config.releaseVersion,
      accepting_turns: true, pid: process.pid,
    })),
  ];
  try {
    const report = await runDoctor();
    expect(report.ok).toBe(true);
    expect(report.checks.find(check => check.id === "external-mcp")).toMatchObject({ status: "warning" });
    expect(report.checks.find(check => check.id === "external-mcp")?.detail).toContain("does not verify");
    expect(report.checks.find(check => check.id === "external-mcp")?.detail).toContain(interaction === "manual" ? "safe contract" : "native contract");
    expect(report.checks.some(check => check.id.startsWith("tunnel-"))).toBe(false);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
