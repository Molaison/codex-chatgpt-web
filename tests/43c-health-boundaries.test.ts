import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { fixture } from "./43c-health-fixture";
import { createQaPool } from "../src/qa-pool";
import { QaHealthAdmission } from "../src/qa-health";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const owners = (path: string) => {
  const db = new Database(path);
  try {
    return { owners: db.query("SELECT COUNT(*) AS n FROM sessions").get(),
      admissions: db.query("SELECT receipt_json FROM qa_health_admissions").all() as { receipt_json: string }[] };
  } finally { db.close(); }
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

test("all candidate waits precede selected account admission; stale selected never falls through to another account", async () => {
  const a = await fixture("synthetic-a"), b = await fixture("synthetic-b");
  const aReady = deferred(), bWaiting = deferred(), releaseB = deferred();
  const report = a.host.reportHealthMaintenance.bind(a.host);
  a.host.reportHealthMaintenance = (request: any) => { const result = report(request); if (request.state === "ready") aReady.resolve(); return result; };
  const readB = b.host.readPassiveHealth.bind(b.host);
  b.host.readPassiveHealth = async (request: any) => { bWaiting.resolve(); await releaseB.promise; return readB(request); };
  const pool = createQaPool({ ...a.config, accounts: [a.account, b.account] });
  try {
    const pending = pool.fetch(a.request("slow-other-candidate"));
    await Promise.all([aReady.promise, bWaiting.promise]);
    a.switchUser("changed-principal-before-selection"); releaseB.resolve();
    const refused = await pending;
    expect(refused.status).toBe(503);
    expect(owners(a.config.databasePath)).toEqual({ owners: { n: 0 }, admissions: [] });
    expect(a.dispatched() + b.dispatched()).toBe(0);
    // A later fresh request may select another configured, healthy fixture.
    const healthy = await pool.fetch(a.request("later-fresh-other-account")); await healthy.text();
    expect(healthy.status).toBe(200); expect(a.dispatched()).toBe(0); expect(b.dispatched()).toBe(1);
    const stored = owners(a.config.databasePath);
    expect(stored.owners).toEqual({ n: 1 });
    expect(JSON.parse(stored.admissions[0]!.receipt_json).runtime.accountId).toBe(b.account.id);
    expect(a.host.activeTraceId).toBe("original-test-writer");
  } finally { releaseB.resolve(); pool.close(); await a.close(); await b.close(); }
});

test.each(["cookie", "runtime-restart", "runtime-drain", "foreign-receipt"] as const)(
  "selected admission rejects %s before owner persistence and dispatch", async kind => {
    const f = await fixture();
    const admit = f.host.admitHealthAssignment.bind(f.host);
    const report = f.host.reportHealthMaintenance.bind(f.host);
    let injected = false;
    if (kind === "runtime-restart") f.host.reportHealthMaintenance = (request: any) => {
      const result = report(request);
      if (request.state === "ready" && !injected) { injected = true; f.restartRuntime(); }
      return result;
    };
    else if (kind === "foreign-receipt") f.corrupt((proof: any) => {
      if (proof.admission) { injected = true; proof.admission.assignment.sessionHash = "f".repeat(64); }
      return proof;
    });
    else f.host.admitHealthAssignment = (request: any) => {
      injected = true;
      if (kind === "cookie") { f.switchUser("wrong-principal-at-admission"); return admit(request); }
      const receipt = admit(request); f.drain(true); return receipt;
    };
    const pool = createQaPool(f.config);
    try {
      const response = await pool.fetch(f.request("reject-" + kind));
      expect(response.status).toBe(503); expect(injected).toBe(true); expect(f.dispatched()).toBe(0);
      expect(owners(f.config.databasePath)).toEqual({ owners: { n: 0 }, admissions: [] });
      expect(f.host.activeTraceId).toBe("original-test-writer");
    } finally { pool.close(); await f.close(); }
  },
);

test("Host decision is retained metadata: later cookie invalidation fences next assignment, preserving admitted owner and receipt", async () => {
  const f = await fixture(), admit = f.host.admitHealthAssignment.bind(f.host);
  let original: any;
  f.host.admitHealthAssignment = (request: any) => {
    const receipt = admit(request);
    expect(f.host.healthAssignments.get(receipt.assignment.admissionId)).toEqual(receipt);
    original = receipt;
    f.switchUser("changed-after-admission-decision");
    return receipt;
  };
  const pool = createQaPool(f.config);
  try {
    const first = await pool.fetch(f.request("already-admitted")); expect(first.status).toBe(200);
    const body = await first.json();
    const state = owners(f.config.databasePath);
    expect(state.owners).toEqual({ n: 1 });
    expect(JSON.parse(state.admissions[0]!.receipt_json)).toEqual(original);
    expect((await pool.fetch(f.request("new-not-admitted"))).status).toBe(503);
    const replay = await pool.fetch(f.request("already-admitted"));
    expect(await replay.json()).toEqual(body); expect(f.dispatched()).toBe(1);
    expect(f.host.activeTraceId).toBe("original-test-writer");
  } finally { pool.close(); await f.close(); }
});

test("exact selected receipt consumed once; stale at local transaction fails; control cannot spoof Host or runtime", async () => {
  const f = await fixture(), health = new QaHealthAdmission([f.account]);
  try {
    expect(await health.check(f.account)).toBe(true);
    const consume = await health.authorizeSelected(f.account, "a".repeat(64));
    const receipt = consume!()!; expect(receipt.assignment.sessionHash).toBe("a".repeat(64)); expect(consume!()).toBeUndefined();
    const request = { accountId: f.account.id, expectedHost: f.host.healthIdentity(),
      assignment: receipt.assignment, runtime: receipt.runtime, expectedProof: receipt.host };
    expect(f.host.admitHealthAssignment(request)).toEqual(receipt);
    expect(() => f.host.admitHealthAssignment({ ...request, assignment: { ...receipt.assignment, sessionHash: "b".repeat(64) } })).toThrow("conflict");
    expect(() => f.host.admitHealthAssignment({ ...request, expectedHost: { ...request.expectedHost, instanceId: "foreign" } })).toThrow("binding");
    const stale = await health.authorizeSelected(f.account, "c".repeat(64));
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try { expect(stale!()).toBeUndefined(); } finally { clock.mockRestore(); }
    const endpoint = f.control.descriptor().endpoint + "/v1/health/admit";
    expect((await fetch(endpoint, { method: "POST", body: JSON.stringify(request) })).status).toBe(401);
    const runtimeBad = await fetch(f.runtime.url.origin + "/admin/qa-health", { method: "POST",
      headers: { authorization: "Bearer " + f.token }, body: JSON.stringify({ accountId: f.account.id,
        expectedHost: f.host.healthIdentity(), probeId: randomUUID(),
        assignment: { admissionId: randomUUID(), sessionHash: "d".repeat(64),
          expectedRuntime: { ...receipt.runtime, instanceId: randomUUID() }, expectedProof: receipt.host } }) });
    expect(runtimeBad.status).toBe(503);
  } finally { health.close(); await f.close(); }
});

test("pool admin drain during selected runtime await prevents both owner and admission rows", async () => {
  const f = await fixture();
  const token = "pool-control-" + "a".repeat(40);
  const tokenFile = join(f.root, "pool-control.key");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const pool = createQaPool({ ...f.config, releaseControl: { tokenFile, stateFile: join(f.root, "release-state.json") } });
  const entered = deferred(), release = deferred();
  // The runtime response can be delayed after Host's synchronous decision. Its
  // original method stays synchronous; delay the HTTP runtime proof instead.
  const originalFetch = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: any, init?: any) => {
    const response = await originalFetch(input, init);
    if (String(input).endsWith("/admin/qa-health") && JSON.parse(init?.body ?? "{}").assignment) {
      entered.resolve(); await release.promise;
    }
    return response;
  }, { preconnect: originalFetch.preconnect }));
  try {
    const response = pool.fetch(f.request("drain-before-pool-commit"));
    await entered.promise;
    const drained = await pool.fetch(new Request("http://pool/admin/release/drain", { method: "POST",
      headers: { authorization: "Bearer " + token } }));
    expect(drained.status).toBe(200);
    release.resolve();
    const refused = await response; await refused.text();
    expect(refused.status).toBe(503); expect(f.dispatched()).toBe(0);
    expect(owners(f.config.databasePath)).toEqual({ owners: { n: 0 }, admissions: [] });
  } finally { release.resolve(); spy.mockRestore(); pool.close(); await f.close(); }
});

test("admission receipt persistence failure rolls back owner in the same original pool transaction", async () => {
  const f = await fixture(), pool = createQaPool(f.config);
  const db = new Database(f.config.databasePath);
  db.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON qa_health_admissions BEGIN SELECT RAISE(ABORT, 'injected admission persistence fault'); END");
  try {
    const response = await pool.fetch(f.request("admission-storage-failed"));
    expect(response.status).toBe(503); expect(f.dispatched()).toBe(0);
    expect(owners(f.config.databasePath)).toEqual({ owners: { n: 0 }, admissions: [] });
    expect(f.host.activeTraceId).toBe("original-test-writer");
  } finally { db.close(); pool.close(); await f.close(); }
});
