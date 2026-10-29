const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === "electron" ? {} : originalLoad.call(this, id, ...args); };
const { BrowserHost } = require("../electron/browser-host.cjs");
Module._load = originalLoad;
const { PassiveSessionHealth } = require("../electron/passive-session-health.cjs");
const { digestUserId } = require("../electron/health-identity.cjs");

// Port of 114_health_binding_checks.cjs: exercise the repository's actual Host
// and health reader instead of loading a private ASAR or suppressing disk writes.
const endpoint = "https://chatgpt.com/api/auth/session";
const token = "__Secure-next-auth.session-token";
const cookie = (value, name = token + ".0") => ({ name, value, domain: ".chatgpt.com", path: "/", httpOnly: true });
const header = (value, name = token + ".0") => `${name}=${value}; Path=/; Secure; HttpOnly`;
const payload = (id = "expected") => ({ user: { id }, expires: new Date(Date.now() + 60_000).toISOString() });
function response(headers = [], id = "expected", status = 200) {
  return { status, ok: status >= 200 && status < 300, redirected: false,
    headers: { getSetCookie: () => headers, get: name => name === "content-type" ? "application/json" : null },
    json: async () => payload(id) };
}
function fixture(t, initial = [cookie("before")]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "health-cookie-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = path.join(root, "pin.json");
  fs.writeFileSync(pin, JSON.stringify({ version: 1, accountId: "account-3", profile: "development",
    partition: "persist:test-health-binding", principalDigest: digestUserId("expected") }), { mode: 0o600 });
  let jar = initial, calls = 0, refreshes = 0;
  const cookies = Object.assign(new EventEmitter(), { get: async () => structuredClone(jar) });
  const session = { cookies, fetch: async () => { calls++; return response(); } };
  const contents = { session, isDestroyed: () => false, getURL: () => "https://chatgpt.com/",
    executeJavaScript: async () => { throw Error("Unexpected page request"); } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    observationInstanceId: "A".repeat(32), profile: "development", partition: "persist:test-health-binding",
    getHealthPinPath: () => pin, getAccountId: () => "account-3", getBrowserInteractionMode: () => "automatic",
    view: { webContents: contents }, refreshAuthenticationFromSession: () => { refreshes++; },
  });
  host.bindAuthenticationChanges();
  return { host, session, contents, cookies, calls: () => calls, refreshes: () => refreshes,
    setJar(next) {
      const old = jar; jar = next;
      for (const c of old) if (!next.some(n => n.name === c.name && n.value === c.value)) cookies.emit("changed", {}, c, "overwrite", true);
      for (const c of next) if (!old.some(o => o.name === c.name && o.value === c.value)) cookies.emit("changed", {}, c, "explicit", false);
    },
    read: () => host.readPassiveHealth({ accountId: "account-3", expectedHost: host.healthIdentity() }),
  };
}

for (const scenario of ["own_response_rotation", "own_chunk_consolidation", "combined_cookie_header",
  "concurrent_other_login", "concurrent_logout", "missing_issued_chunk"]) {
  test(`114 cookie binding: ${scenario}`, async t => {
    const f = fixture(t, [cookie("before"), ...(scenario === "own_chunk_consolidation" ? [cookie("old-tail", token + ".1")] : [])]);
    f.session.fetch = async () => {
      f.setJar(scenario === "concurrent_logout" ? [] : [cookie(scenario === "concurrent_other_login" ? "other-user" : "issued"),
        ...(scenario === "combined_cookie_header" ? [cookie("tail", token + ".1")] : [])]);
      return response(scenario === "combined_cookie_header"
        ? [`${header("issued")}; Expires=Thu, 01 Jan 2037 00:00:00 GMT, ${header("tail", token + ".1")}`]
        : [header("issued"), ...(scenario === "missing_issued_chunk" ? [header("required-tail", token + ".1")] : [])]);
    };
    const result = await f.read();
    assert.equal(result.state, ["own_response_rotation", "own_chunk_consolidation", "combined_cookie_header"].includes(scenario) ? "ready" : "unknown");
    if (result.state === "ready") assert.equal(result.cookieRevision, f.host.passiveHealth.cookieRevision);
    assert.equal(f.refreshes(), 0, "passive cookie events do not start legacy page inspection");
  });
}

for (const scenario of ["bound_rotation", "unbound_rotation", "signed_out", "wrong_principal"]) {
  test(`114 proof binding: ${scenario}`, async () => {
    let health;
    const session = { fetch: async () => {
      health.invalidate();
      if (scenario !== "unbound_rotation") session.healthCookieRevision = health.cookieRevision;
      return response([], scenario === "wrong_principal" ? "other" : "expected", scenario === "signed_out" ? 401 : 200);
    } };
    health = new PassiveSessionHealth({ identity: () => ({ accountId: "account-3" }), session: () => session,
      available: () => true, timeoutMs: 1000, pin: () => digestUserId("expected") });
    assert.equal((await health.read()).state, scenario === "bound_rotation" ? "ready" : "unknown");
  });
}

function pageFallback(f, { observed = true, status = 200, id = "expected", redirected = false,
  type = "application/json", throws = false } = {}) {
  let listener, probeUrl, cleanups = 0, pageCalls = 0;
  f.session.fetch = async () => response([], "expected", 403);
  f.session.webRequest = { onHeadersReceived(filter, callback) {
    if (filter === null) { listener = null; cleanups++; return; }
    assert.deepEqual(filter.urls.length, 1);
    probeUrl = filter.urls[0]; listener = callback;
    assert.equal(new URL(probeUrl).origin + new URL(probeUrl).pathname, endpoint);
    assert.match(new URL(probeUrl).searchParams.get("cpr_health"), /^[a-f0-9-]{36}$/);
  } };
  f.contents.executeJavaScript = async (script, userGesture) => {
    pageCalls++; assert.equal(userGesture, false);
    assert.doesNotMatch(script, /document\.|querySelector|loadURL/);
    if (throws) throw Error("Page transport failed");
    return vm.runInNewContext(script, { location: { origin: "https://chatgpt.com" }, AbortController, setTimeout, clearTimeout,
      fetch: async (url, options) => {
        assert.equal(url, probeUrl); assert.equal(options.credentials, "include");
        assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error");
        if (observed) listener({ url, statusCode: status, responseHeaders: { "Set-Cookie": [header("issued")] } }, result => assert.equal(result.cancel, false));
        f.setJar([cookie("issued")]);
        return { status, redirected, headers: { get: () => type }, json: async () => payload(id) };
      },
    });
  };
  return { cleanups: () => cleanups, pageCalls: () => pageCalls, listener: () => listener };
}

test("403 uses same auth endpoint in page, observes response cookies, and removes listener", async t => {
  const f = fixture(t), p = pageFallback(f);
  assert.equal((await f.read()).state, "ready");
  assert.equal(p.pageCalls(), 1); assert.equal(p.cleanups(), 1); assert.equal(p.listener(), null);
});

test("all six noise cookies preserve proof and never start a legacy page refresh", async t => {
  const f = fixture(t), first = await f.read();
  assert.equal(first.state, "ready");
  const revision = f.host.passiveHealth.cookieRevision;
  for (const name of ["__oailb", "__cflb", "__cf_bm", "_cfuvid", "cf_clearance", "oai-mweb-route"]) {
    f.cookies.emit("changed", {}, cookie("noise", name), "explicit", false);
    f.cookies.emit("changed", {}, cookie("noise", name), "expired", true);
    assert.deepEqual(await f.read(), first);
  }
  assert.equal(f.host.passiveHealth.cookieRevision, revision); assert.equal(f.calls(), 1); assert.equal(f.refreshes(), 0);
});

test("noise cookies during a response do not prevent a fully bound rotation", async t => {
  const f = fixture(t, [cookie("before"), cookie("old-noise", "__cf_bm")]);
  f.session.fetch = async () => {
    f.setJar([cookie("issued"), cookie("new-noise", "__cf_bm")]);
    return response([header("issued")]);
  };
  assert.equal((await f.read()).state, "ready");
});

test("invalidation outside a pending read immediately allows a fresh signed-out result", async t => {
  const f = fixture(t); assert.equal((await f.read()).state, "ready");
  f.setJar([]); f.session.fetch = async () => response([], "expected", 401);
  assert.equal(f.host.passiveHealth.proof, null);
  assert.equal(f.host.passiveHealth.lastAttemptAt, -Infinity);
  assert.equal((await f.read()).state, "signed_out");
});

for (const [name, configure] of [
  ["non-200 successful response", f => { f.session.fetch = async () => { f.setJar([cookie("issued")]); return response([header("issued")], "expected", 201); }; }],
  ["rotation without complete Set-Cookie", f => { f.session.fetch = async () => { f.setJar([cookie("issued")]); return response(); }; }],
  ["unrelated relevant cookie change", f => { f.session.fetch = async () => { f.setJar([cookie("issued"), cookie("foreign", "csrf")]); return response([header("issued")]); }; }],
  ["concurrent change while reading live jar", f => {
    let reads = 0;
    f.cookies.get = async () => {
      if (++reads === 1) return [cookie("before")];
      const snapshot = [cookie("issued")];
      f.setJar([cookie("other-user")]);
      return snapshot;
    };
    f.session.fetch = async () => { f.setJar([cookie("issued")]); return response([header("issued")]); };
  }],
  ["redirected native response", f => { f.session.fetch = async () => { f.setJar([cookie("issued")]); return { ...response([header("issued")]), redirected: true }; }; }],
]) {
  test(`${name} cannot renew proof`, async t => {
    const f = fixture(t); configure(f); assert.equal((await f.read()).state, "unknown");
  });
}

for (const [name, options] of [
  ["unobserved response", { observed: false }], ["wrong principal", { id: "other" }],
  ["redirect", { redirected: true }], ["non-JSON", { type: "text/html" }],
  ["failed response", { status: 403 }], ["page transport rejection", { throws: true }],
]) {
  test(`403 page fallback rejects ${name} and cleans up`, async t => {
    const f = fixture(t), p = pageFallback(f, options);
    assert.equal((await f.read()).state, "unknown");
    assert.equal(p.cleanups(), p.pageCalls()); assert.equal(p.listener(), null);
  });
}

test("403 on a foreign page never invokes page transport", async t => {
  const f = fixture(t), p = pageFallback(f);
  f.contents.getURL = () => "https://example.com/";
  assert.equal((await f.read()).state, "unknown"); assert.equal(p.pageCalls(), 0);
});

test("combined Set-Cookie via headers.get also preserves Expires commas", async t => {
  const f = fixture(t);
  f.session.fetch = async () => {
    f.setJar([cookie("issued"), cookie("tail", token + ".1")]);
    const combined = `${header("issued")}; Expires=Thu, 01 Jan 2037 00:00:00 GMT, ${header("tail", token + ".1")}`;
    return { ...response(), headers: { get: name => name === "set-cookie" ? combined : "application/json" } };
  };
  assert.equal((await f.read()).state, "ready");
});

for (const names of [[token + ".1"], [token + ".0", token + ".2"], [token, token + ".0"]]) {
  test(`incomplete or mixed token chunks cannot bind: ${names.join(", ")}`, async t => {
    const f = fixture(t);
    f.session.fetch = async () => {
      f.setJar(names.map(name => cookie("issued", name)));
      return response(names.map(name => header("issued", name)));
    };
    assert.equal((await f.read()).state, "unknown");
  });
}

test("a complete unchunked session token can bind its response", async t => {
  const f = fixture(t);
  f.session.fetch = async () => { f.setJar([cookie("issued", token)]); return response([header("issued", token)]); };
  assert.equal((await f.read()).state, "ready");
});
