const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { createRequire } = require("node:module");
const downloader = require("@codex-chatgpt-web/build-downloader");
const localCertificate = require("./helpers/download-tls.cjs");

async function fixture(t, handler, tls) {
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { server, url: `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}` };
}
async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "build-download-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function env(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = entries => {
    // Windows environment names are case insensitive. Delete aliases first.
    for (const [key, value] of Object.entries(entries)) if (value === undefined) delete process.env[key];
    for (const [key, value] of Object.entries(entries)) if (value !== undefined) process.env[key] = value;
  };
  apply(values);
  t.after(() => apply(previous));
}
const hash = data => createHash("sha256").update(data).digest("hex");

test("build downloader retains custom agents, request timeout, and partial-file cleanup", async t => {
  const { url } = await fixture(t, (_req, res) => { res.writeHead(200); res.write("partial"); });
  const target = path.join(await scratch(t), "artifact");
  let calls = 0;
  const agent = new http.Agent();
  const create = agent.createConnection.bind(agent);
  agent.createConnection = (...args) => { calls++; return create(...args); };
  t.after(() => agent.destroy());
  await assert.rejects(downloader.download(url, target, { agent: { http: agent }, timeout: { request: 60 }, retry: 0 }),
    error => error.code === "ETIMEDOUT" && error.event === "request");
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});

test("connect timeout covers an agent that never establishes a socket", async t => {
  const target = path.join(await scratch(t), "artifact");
  const agent = new http.Agent();
  agent.createConnection = () => undefined;
  t.after(() => agent.destroy());
  await assert.rejects(downloader.download("http://127.0.0.1:1", target, {
    agent: { http: agent }, timeout: { connect: 30, request: 500 }, retry: 0,
  }), error => error.event === "connect");
});

test("response and socket timeout options are enforced", async t => {
  const { url } = await fixture(t, () => {});
  const target = path.join(await scratch(t), "artifact");
  for (const phase of ["response", "socket"]) {
    await assert.rejects(downloader.download(url, target, { timeout: { [phase]: 40, request: 1000 }, retry: 0 }), error => error.event === phase);
  }
});

test("TLS handshake timeout closes a peer that accepts TCP but never negotiates TLS", async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on("data", () => {}); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(downloader.download(`https://127.0.0.1:${server.address().port}`, path.join(await scratch(t), "artifact"), {
    timeout: { secureConnect: 40, request: 1000 }, retry: 0,
  }), error => error.event === "secureConnect");
});

test("request deadline spans the entire redirect chain", async t => {
  const { url } = await fixture(t, (req, res) => {
    const next = Number(req.url.slice(1) || "0") + 1;
    setTimeout(() => { res.writeHead(302, { location: `/${next}` }); res.end(); }, 40);
  });
  await assert.rejects(downloader.download(url, path.join(await scratch(t), "artifact"), {
    maxRedirects: 100, timeout: { request: 150 }, retry: 0,
  }), error => error.event === "request");
});

test("redirects retain same-origin headers and remove credentials across origins", async t => {
  let finalHeaders;
  const destination = await fixture(t, (req, res) => { finalHeaders = req.headers; res.end("done"); });
  const source = await fixture(t, (req, res) => {
    if (req.url === "/") { res.writeHead(302, { location: "/same" }); res.end(); }
    else { assert.equal(req.headers.authorization, "fixture"); res.writeHead(307, { location: destination.url }); res.end(); }
  });
  const target = path.join(await scratch(t), "artifact");
  await downloader.download(source.url, target, { headers: { Authorization: "fixture", Cookie: "fixture=1", "Proxy-Authorization": "fixture", "x-fixture": "kept" }, retry: 0 });
  assert.equal(await fs.readFile(target, "utf8"), "done");
  for (const header of ["authorization", "cookie", "proxy-authorization"]) assert.equal(finalHeaders[header], undefined);
  assert.equal(finalHeaders["x-fixture"], "kept");
  assert.equal(finalHeaders.host, new URL(destination.url).host);
});

test("redirect loops and non-HTTP redirects fail without retaining output", async t => {
  const { url } = await fixture(t, (req, res) => { res.writeHead(302, { location: req.url === "/file" ? "file:///invalid" : "/loop" }); res.end(); });
  const target = path.join(await scratch(t), "artifact");
  await assert.rejects(downloader.download(url, target, { maxRedirects: 2 }), /maxRedirects/);
  await assert.rejects(downloader.download(url + "/file", target), /Only HTTP/);
  await assert.rejects(downloader.download(url, target, { followRedirect: false }), /HTTP 302/);
});

test("retry-after retries transient responses and never retries 404", async t => {
  let requests = 0;
  const { url } = await fixture(t, (req, res) => {
    requests++;
    if (req.url === "/missing") { res.writeHead(404); res.end(); }
    else if (requests < 3) { res.writeHead(503, { "retry-after": "0" }); res.end(); }
    else res.end("retried");
  });
  const target = path.join(await scratch(t), "artifact");
  await downloader.download(url, target);
  assert.equal(requests, 3);
  assert.equal(await fs.readFile(target, "utf8"), "retried");
  await assert.rejects(downloader.download(url + "/missing", target), error => error.response.statusCode === 404);
  assert.equal(requests, 4);
});

test("truncated transfers retry from byte zero and report completed progress", async t => {
  let requests = 0;
  const { url } = await fixture(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "content-length": 8 });
    if (requests === 1) { res.write("part"); setTimeout(() => res.destroy(), 10); }
    else res.end("complete");
  });
  const target = path.join(await scratch(t), "artifact");
  const updates = [];
  await downloader.download(url, target, { retry: 1, getProgressCallback: async info => updates.push(info) });
  assert.equal(requests, 2);
  assert.equal(await fs.readFile(target, "utf8"), "complete");
  assert.deepEqual(updates.at(-1), { transferred: 8, total: 8, percent: 1 });
});

test("HTTP response caching is absent and unsupported options fail explicitly", async t => {
  let requests = 0;
  const { url } = await fixture(t, (_req, res) => {
    requests++; res.writeHead(200, { "cache-control": "public, max-age=3600", "set-cookie": "fixture=1" }); res.end(String(requests));
  });
  const target = path.join(await scratch(t), "artifact");
  await downloader.download(url, target);
  await downloader.download(url, target, { headers: { "cache-control": "max-stale" } });
  assert.equal(await fs.readFile(target, "utf8"), "2");
  for (const options of [{ cache: new Map() }, { timeout: { lookup: 2 } }, { hooks: {} }, { retry: { calculateDelay() {} } }]) {
    await assert.rejects(downloader.download(url, target, options), /unsupported/i);
  }
});

test("compressed response bodies are decoded before artifact verification", async t => {
  const body = gzipSync("artifact bytes");
  const { url } = await fixture(t, (_req, res) => { res.writeHead(200, { "content-encoding": "gzip", "content-length": body.length }); res.end(body); });
  const target = path.join(await scratch(t), "artifact");
  await downloader.download(url, target);
  assert.equal(await fs.readFile(target, "utf8"), "artifact bytes");
});

test("TLS verification rejects untrusted certificates and supports an explicit private CA", async t => {
  const tls = localCertificate();
  const { url } = await fixture(t, (_req, res) => res.end("verified TLS"), tls);
  const target = path.join(await scratch(t), "artifact");
  await assert.rejects(downloader.download(url, target, { retry: 0 }), error => /CERT|SELF_SIGNED/.test(error.code));
  await downloader.download(url, target, { https: { certificateAuthority: tls.cert }, retry: 0 });
  assert.equal(await fs.readFile(target, "utf8"), "verified TLS");
});

test("builder proxy agents route HTTP and HTTPS CONNECT downloads with TLS validation", async t => {
  const tls = localCertificate();
  const origin = await fixture(t, (_req, res) => res.end("through proxy"), tls);
  let plain = 0;
  let tunnels = 0;
  const proxy = await fixture(t, (req, res) => { plain++; assert.equal(req.url, "http://fixture.invalid/asset"); res.end("plain proxy"); });
  proxy.server.on("connect", (req, socket, head) => {
    tunnels++;
    assert.equal(req.url, new URL(origin.url).host);
    const upstream = net.connect(new URL(origin.url).port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  env(t, { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: undefined, https_proxy: undefined });
  const agent = require("builder-util").buildGotProxyAgent();
  t.after(() => { agent.http.destroy(); agent.https.destroy(); });
  const target = path.join(await scratch(t), "artifact");
  await downloader.download("http://fixture.invalid/asset", target, { agent, retry: 0 });
  assert.equal(await fs.readFile(target, "utf8"), "plain proxy");
  await downloader.download(origin.url, target, { agent, https: { certificateAuthority: tls.cert }, retry: 0 });
  assert.equal(await fs.readFile(target, "utf8"), "through proxy");
  assert.equal(plain, 1); assert.equal(tunnels, 1);
});

test("upstream artifact checksum verification and all four disk cache modes remain active", async t => {
  const { downloadArtifact, ElectronDownloadCacheMode: mode } = await import("@electron/get");
  let requests = 0;
  const { url } = await fixture(t, (_req, res) => { requests++; res.end("artifact"); });
  const dir = await scratch(t);
  const config = { version: "9.9.9", artifactName: "artifact.zip", isGeneric: true, downloader,
    cacheRoot: path.join(dir, "cache"), tempDirectory: dir,
    checksums: { "artifact.zip": hash("artifact") }, mirrorOptions: { resolveAssetURL: async () => url } };
  const cached = await downloadArtifact(config);
  await downloadArtifact({ ...config, cacheMode: mode.ReadOnly });
  assert.equal(requests, 1);
  const bypass = await downloadArtifact({ ...config, cacheMode: mode.Bypass });
  assert.notEqual(bypass, cached); assert.equal(requests, 2);
  await downloadArtifact({ ...config, cacheMode: mode.WriteOnly });
  assert.equal(requests, 3);
  await fs.writeFile(cached, "corrupted cache");
  assert.equal(await fs.readFile(await downloadArtifact(config), "utf8"), "artifact");
  assert.equal(requests, 4);
  await assert.rejects(downloadArtifact({ ...config, cacheMode: mode.Bypass, checksums: { "artifact.zip": "0".repeat(64) } }), /checksum/i);
  const readOnly = await downloadArtifact({ ...config, cacheRoot: path.join(dir, "empty"), cacheMode: mode.ReadOnly });
  assert.equal(await fs.readFile(readOnly, "utf8"), "artifact");
  await assert.rejects(fs.stat(path.join(dir, "empty")), { code: "ENOENT" });
});

test("installed electron-builder uses the adapter for Electron and recursive checksum downloads", async t => {
  const dir = await scratch(t);
  env(t, { HTTP_PROXY: undefined, HTTPS_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, ELECTRON_DOWNLOAD_CACHE_MODE: "3" });
  const artifact = "electron-v41.10.7-win32-x64.zip";
  let agentCalls = 0;
  const agent = new http.Agent();
  const create = agent.createConnection.bind(agent);
  agent.createConnection = (...args) => { agentCalls++; return create(...args); };
  t.after(() => agent.destroy());
  const requested = [];
  const { url } = await fixture(t, (req, res) => {
    requested.push(req.url);
    res.end(req.url.endsWith("SHASUMS256.txt") ? `${hash("electron fixture")} *${artifact}\n` : "electron fixture");
  });
  const { downloadElectronArtifactZip } = require("app-builder-lib/out/util/electronGet");
  const file = await downloadElectronArtifactZip({ version: "41.10.7", platformName: "win32", arch: "x64", artifactName: "electron", cacheDir: path.join(dir, "cache"),
    electronDownload: { tempDirectory: dir, mirrorOptions: { mirror: url + "/" }, downloadOptions: { agent: { http: agent }, timeout: { request: 1000 }, retry: 0 } } });
  assert.equal(await fs.readFile(file, "utf8"), "electron fixture");
  assert.equal(requested.length, 2); assert.equal(agentCalls, 2);
  assert.ok(requested.some(value => value.endsWith("SHASUMS256.txt")));
});

test("builder generic binary downloads preserve proxies, integrity and default adapter integration", async t => {
  const dir = await scratch(t);
  let requests = 0;
  const proxy = await fixture(t, (req, res) => { requests++; assert.equal(req.url, "http://fixture.invalid/tool.zip"); res.end("tool fixture"); });
  env(t, { HTTP_PROXY: proxy.url, HTTPS_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, ELECTRON_BUILDER_CACHE: dir });
  const { download } = require("app-builder-lib/out/binDownload");
  const target = path.join(dir, "out");
  await download("http://fixture.invalid/tool.zip", target, hash("tool fixture"));
  assert.equal(await fs.readFile(target, "utf8"), "tool fixture");
  assert.equal(requests, 1);
  await assert.rejects(download("http://fixture.invalid/tool.zip", target, "0".repeat(64)), /checksum/i);
});

test("builder legacy force still bypasses cached artifacts and rejects conflicting cache mode", async t => {
  const dir = await scratch(t);
  env(t, { HTTP_PROXY: undefined, HTTPS_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, ELECTRON_DOWNLOAD_CACHE_MODE: undefined });
  let requests = 0;
  const { url } = await fixture(t, (_req, res) => { requests++; res.end("forced fixture"); });
  const { downloadElectronArtifactZip } = require("app-builder-lib/out/util/electronGet");
  const config = { version: "41.10.7", platformName: "win32", arch: "x64", artifactName: "electron", cacheDir: path.join(dir, "cache"),
    electronDownload: { tempDirectory: dir, checksums: { "electron-v41.10.7-win32-x64.zip": hash("forced fixture") },
      mirrorOptions: { mirror: url + "/" } } };
  await downloadElectronArtifactZip(config);
  await downloadElectronArtifactZip(config);
  assert.equal(requests, 1);
  await downloadElectronArtifactZip({ ...config, electronDownload: { ...config.electronDownload, force: true } });
  assert.equal(requests, 2);
  process.env.ELECTRON_DOWNLOAD_CACHE_MODE = "1";
  assert.throws(() => downloadElectronArtifactZip({ ...config, electronDownload: { ...config.electronDownload, force: true } }), /both "force" and "cacheMode"/);
});

test("builder resolves maintained @electron/get without the vulnerable Got cache chain", async () => {
  const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
  const manifest = JSON.parse(await fs.readFile(path.resolve(path.dirname(builderRequire.resolve("@electron/get")), "../package.json"), "utf8"));
  assert.equal(manifest.version, "5.1.0");
  for (const name of ["got", "cacheable-request", "http-cache-semantics"]) {
    assert.throws(() => builderRequire.resolve(name), { code: "MODULE_NOT_FOUND" });
  }
});
