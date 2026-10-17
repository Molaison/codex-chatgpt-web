const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const startedAt = Date.now();

function recordPackageSmokePhase(markerPath, phase) {
  if (!markerPath || !path.isAbsolute(markerPath)) return;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.appendFileSync(`${markerPath}.progress`, `${JSON.stringify({ phase, elapsedMs: Date.now() - startedAt })}\n`);
  } catch { /* Diagnostic writes must not change the launcher outcome. */ }
}

function readPackageSmokeProgress(markerPath) {
  if (!markerPath) return [];
  try {
    return fs.readFileSync(`${markerPath}.progress`, "utf8").trim().split("\n").slice(-24).map(line => {
      const value = JSON.parse(line);
      return { phase: value.phase, elapsedMs: value.elapsedMs };
    });
  } catch (error) {
    return [{ phase: "progress-unavailable", code: error.code || "invalid-progress" }];
  }
}

function runSmokeCommand(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout || 45_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(`PACKAGED_LAUNCHER_SMOKE_COMMAND_FAILED ${JSON.stringify({
      command: path.basename(command),
      code: result.error?.code || null,
      status: result.status,
      signal: result.signal,
      pid: result.pid,
      elapsedMs: Date.now() - started,
      timeoutMs: options.timeout || 45_000,
      markerWritten: Boolean(options.markerPath && fs.existsSync(options.markerPath)),
      phases: readPackageSmokeProgress(options.markerPath),
      stdout: result.stdout?.trim().slice(-8192) || "",
      stderr: result.stderr?.trim().slice(-8192) || "",
    })}\n`);
    if (result.error) throw result.error;
    throw new Error(`${command} failed with status ${result.status}: ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`);
  }
  return result;
}

module.exports = { recordPackageSmokePhase, runSmokeCommand };
