const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const root = __dirname;
const runtime = path.resolve(root, 'payload/unpacked/resources/runtime');
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));
const sourceRequire = createRequire(path.join(root, 'runtime-install.cjs'));
const log = path.join(root, '../overnight-installer-timings.jsonl');
const scratch = path.join(root, 'scratch');
fs.mkdirSync(scratch, { recursive: true });
function loadImplementation(side, measurements) {
  const filename = path.join(root, side, 'runtime-install.cjs');
  let code = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  code = code.replace('function inspectRuntimeBundle(runtimeRoot, identity) {',
    'function inspectRuntimeBundle(runtimeRoot, identity) { return __measureScan(runtimeRoot, () => __inspectRuntimeBundle(runtimeRoot, identity)); }\nfunction __inspectRuntimeBundle(runtimeRoot, identity) {');
  const wrappedFs = new Proxy(fs, { get(target, key) {
    if (key === 'cpSync') return (...args) => {
      const start = performance.now();
      try { return target.cpSync(...args); }
      finally { measurements.copyMs += performance.now() - start; }
    };
    return target[key];
  } });
  const sandbox = {
    module: { exports: {} }, exports: {}, process, Buffer, setTimeout,
    require(name) { return name === 'node:fs' ? wrappedFs : sourceRequire(name); },
    __measureScan(runtimeRoot, run) {
      const start = performance.now();
      try { return run(); }
      finally { measurements.scans.push({ phase: runtimeRoot === runtime ? 'source' : runtimeRoot.includes('.tmp-') ? 'temporary' : 'destination', ms: performance.now() - start }); }
    },
  };
  vm.runInNewContext(code, sandbox, { filename });
  return sandbox.module.exports;
}
async function sample(side, pair) {
  const home = path.join(scratch, `home-${pair}-${side}`);
  if (fs.existsSync(home)) throw new Error(`sample must be cold: ${home}`);
  const resources = path.dirname(runtime);
  const measurements = { copyMs: 0, scans: [] };
  const impl = loadImplementation(side, measurements);
  const start = performance.now();
  const app = { isPackaged: true, getVersion: () => manifest.appVersion };
  await impl.waitForPackagedRuntimeSource({ app, resourcesPath: resources });
  const installed = impl.ensurePackagedRuntime({ app, coreHome: home, resourcesPath: resources });
  const totalMs = performance.now() - start;
  const destination = path.join(home, 'versions', `${manifest.appVersion}-${process.platform}-${process.arch}`);
  if (path.resolve(installed) !== destination) throw new Error('wrong returned destination');
  const record = { side, pair, timestamp: new Date().toISOString(), appVersion: manifest.appVersion,
    bundleId: manifest.bundleId, node: process.version, platform: process.platform, arch: process.arch,
    files: manifest.files.length, fileBytes: manifest.files.reduce((n, f) => n + f.size, 0),
    totalMs, ...measurements, scanMs: measurements.scans.reduce((n, s) => n + s.ms, 0),
    rss: process.memoryUsage().rss, loadavg: os.loadavg() };
  fs.appendFileSync(log, JSON.stringify(record) + '\n');
  console.log(JSON.stringify(record));
  const resolved = path.resolve(home);
  if (!resolved.startsWith(path.resolve(scratch) + path.sep)) throw new Error('cleanup escaped scratch');
  fs.rmSync(resolved, { recursive: true, force: true });
}
(async () => {
  for (let pair = 1; pair <= 5; pair++) {
    for (const side of pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) await sample(side, pair);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
