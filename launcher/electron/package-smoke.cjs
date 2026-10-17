const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sanitizeForExport } = require("./logging.cjs");

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
    const diagnostic = sanitizeForExport({
      command: path.basename(command),
      code: result.error?.code || null,
      status: result.status,
      signal: result.signal,
      pid: result.pid,
      elapsedMs: Date.now() - started,
      timeoutMs: options.timeout || 45_000,
      markerWritten: Boolean(options.markerPath && fs.existsSync(options.markerPath)),
      phases: readPackageSmokeProgress(options.markerPath),
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr?.trim() || "",
    });
    // Sanitize before bounding output so cutting a token prefix cannot expose its tail.
    diagnostic.stdout = diagnostic.stdout.slice(-8192);
    diagnostic.stderr = diagnostic.stderr.slice(-8192);
    process.stderr.write(`PACKAGED_LAUNCHER_SMOKE_COMMAND_FAILED ${JSON.stringify(diagnostic)}\n`);
    if (result.error) throw result.error;
    throw new Error(`${diagnostic.command} failed with status ${result.status}: ${diagnostic.stderr || diagnostic.stdout || "no output"}`);
  }
  return result;
}

module.exports = { recordPackageSmokePhase, runSmokeCommand };
