const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { recordPackageSmokePhase } = require("../electron/package-smoke.cjs");
const helper = require.resolve("../electron/package-smoke.cjs");

function withScratch(work) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "package-smoke-test-"));
  try { return work(path.join(scratch, "ready.json")); }
  finally {
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function probe(markerPath, code, timeout = 5000) {
  return spawnSync(process.execPath, ["-e", `
    const { runSmokeCommand } = require(${JSON.stringify(helper)});
    try {
      runSmokeCommand(process.execPath, ["-e", ${JSON.stringify(code)}], {
        markerPath: ${JSON.stringify(markerPath)}, timeout: ${timeout}
      });
    } catch (error) { process.stderr.write("SMOKE_PROBE_ERROR " + error.message + "\\n"); process.exitCode = 1; }
  `], { encoding: "utf8", timeout: 10000, windowsHide: true });
}

test("package smoke records ordered phases without changing startup on a diagnostic write error", () => withScratch(markerPath => {
  recordPackageSmokePhase(undefined, "ignored");
  recordPackageSmokePhase(markerPath, "runtime-source");
  recordPackageSmokePhase(markerPath, "runtime-install");
  const phases = fs.readFileSync(`${markerPath}.progress`, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(phases.map(value => value.phase), ["runtime-source", "runtime-install"]);
  assert.ok(phases.every(value => Number.isFinite(value.elapsedMs)));
  assert.doesNotThrow(() => recordPackageSmokePhase(path.join(`${markerPath}.progress`, "invalid"), "blocked"));
}));

test("a failed smoke child exposes captured output and still fails", () => withScratch(markerPath => {
  const result = probe(markerPath, "process.stdout.write('child output'); process.stderr.write('child error'); process.exit(7)");
  assert.equal(result.status, 1);
  const diagnostic = JSON.parse(result.stderr.trim().split("\n")[0].split("PACKAGED_LAUNCHER_SMOKE_COMMAND_FAILED ")[1]);
  assert.equal(diagnostic.status, 7);
  assert.equal(diagnostic.markerWritten, false);
  assert.equal(diagnostic.stdout, "child output");
  assert.equal(diagnostic.stderr, "child error");
}));

for (const markerWritten of [false, true]) {
  test(`a timed-out smoke child reports whether readiness preceded the wait (${markerWritten})`, () => withScratch(markerPath => {
    recordPackageSmokePhase(markerPath, markerWritten ? "app-quit" : "runtime-install");
    if (markerWritten) fs.writeFileSync(markerPath, '{"ok":true}\n');
    const result = probe(markerPath, "setInterval(() => {}, 1000)", 200);
    assert.equal(result.status, 1);
    const diagnostic = JSON.parse(result.stderr.trim().split("\n")[0].split("PACKAGED_LAUNCHER_SMOKE_COMMAND_FAILED ")[1]);
    assert.equal(diagnostic.code, "ETIMEDOUT");
    assert.equal(diagnostic.timeoutMs, 200);
    assert.equal(diagnostic.markerWritten, markerWritten);
    assert.equal(diagnostic.phases.at(-1).phase, markerWritten ? "app-quit" : "runtime-install");
    assert.ok(fs.existsSync(`${markerPath}.progress`), "failure evidence is read before caller cleanup");
  }));
}


test("smoke output and the thrown failure reuse the existing export sanitizer", () => withScratch(markerPath => {
  const key = "sk-" + "synthetic".repeat(40);
  const bearer = "fixture".repeat(6);
  // The raw 8192-character tail starts inside the key; sanitize before slicing.
  const stdout = "prefix".repeat(100) + " runtime " + key + " https://fixture.invalid/private/path?opaque=value" + "z".repeat(8100);
  const stderr = "Authorization: Bearer " + bearer + " C:\\Users\\Fixture\\private";
  const code = "process.stdout.write(" + JSON.stringify(stdout) + "); process.stderr.write(" + JSON.stringify(stderr) + "); process.exit(7)";
  const result = probe(markerPath, code);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes(key));
  assert.ok(!result.stderr.includes("synthetic"), "even a key fragment at the raw tail boundary stays redacted");
  assert.ok(!result.stderr.includes(bearer));
  assert.ok(!result.stderr.includes("/private/path"));
  assert.ok(!result.stderr.includes("Fixture"));
  const diagnostic = JSON.parse(result.stderr.trim().split("\n")[0].split("PACKAGED_LAUNCHER_SMOKE_COMMAND_FAILED ")[1]);
  assert.match(diagnostic.stdout, /\[runtime-key\]/);
  assert.match(diagnostic.stderr, /Bearer \[redacted\]/);
  assert.match(result.stderr, /SMOKE_PROBE_ERROR/);
}));
