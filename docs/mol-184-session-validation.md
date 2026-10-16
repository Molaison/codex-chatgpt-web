# MOL-184: session-history and request-receipt validation packet

## Delivery boundary and release gates

The original sections through Method provenance record the **stage 1 delivery**, not completion of MOL-184. They are historical evidence for PR6 head `fe8cd68b47ed0c258499f87391a0b8fccae190b1`. The original `docs/evidence/mol-184/manifest.json` and baseline/candidate expiry/mapping logs remain unchanged; their source/test hashes and test counts describe that stage 1 snapshot, not the current files modified in stage 2. Stage 2 evidence is separately identified by `receipt-*` artifacts and the addendum below. Do not rerun a changed test file and label its results as the original stage 1 red/green comparison.

In stage 1, The bounded change concerns QA pool temporary-history expiry. It does not implement general Rewind, Web branch selection, multi-end synchronization, measured context capacity, or full Steer semantics. No production rollout, remote execution, GPU use, pipeline change, or workflow change is part of this packet.

- Baseline source: `26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1` in [Molaison/codex-chatgpt-web](https://github.com/Molaison/codex-chatgpt-web/tree/26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1).
- Candidate commit: resolve the reviewed PR head with `git rev-parse HEAD` in its verified checkout and record that full SHA in the external evidence manifest. Do not embed this document’s own future commit hash inside itself.
- Review/PR: use the verified PR URL in the task owner’s final delivery and record it in the external evidence manifest. Publication is a separate step.
- Candidate working-tree regression results: **10 pass / 0 fail / 74 assertions** in the new expiry suite. Independent combined rerun: **65 pass / 0 fail / 292 assertions** across expiry + five session-core files, captured in `/workspace/shared/mol184-evidence/focused-final.log`. Bind these results to the committed candidate SHA before release. Typecheck passes; related paper suites show 33 pass / 2 existing skips / 0 fail / 433 assertions.
- Real acceptance: **not run**. The main task owner must arrange execution through the designated executor. This document does not authorize remote access or live calls.
- GPU requirement: **0**.

Do not present this packet as an executable-ready remote runbook until the candidate hash, reviewed patch, exact environment, allowed launch commands, artifact destination and live budget have been filled and approved. Baseline observations below are historical evidence; they are not candidate results.

## Evidence types and current findings

Use these labels in every result: **static** (source inspection), **mock** (real code with mocked external boundary), **synthetic DOM** (browser fixtures, no authenticated ChatGPT), **real** (actual approved integration), **unknown/not run**. A mock model returning a marker proves nothing about model recall.

| Claim | Evidence | Current classification and limit |
|---|---|---|
| Expired temporary history can fail once and then silently continue without its old context | Actual `createQaPool`, in-process `Request`, SQLite expiry, captured upstream payload; first request 409, repeat 200, one new upstream invocation with only the latest user input | **Mock, reproduced** on baseline; fetch is replaced, no model call |
| Restart can erase the evidence needed to reject an expired continuation | Expire row, close/recreate pool, request returns 200 with only latest user input | **Mock, reproduced** on baseline |
| A deliberately new thread can still start | Independent thread returns 200 in same harness | **Mock, reproduced** control |
| Rewind selects the same retained conversation and only the latest suffix | Actual adapter/selector with mocked browser boundary, six tests / 38 assertions: `[U1,A1,U3]` uses the same key and `prepareResume` emits U3 without conflict | **Mock, reproduced** selection defect; actual Web retention/contamination remains unverified |
| Same URL means same Web branch/head | Durable mapping contains URL and reservation state but no current Web branch/message head | **Not established**; restore checks do not prove branch agreement |
| Expiry fix works with real ChatGPT and installed Codex | No execution evidence yet | **Unknown/not run** |
| Entire MOL-184 is complete | Wider acceptance matrix remains open | **False; stage 1 only** |

Committed, sanitized evidence: [final baseline expiry run](./evidence/mol-184/baseline-expiry.log), [final candidate expiry run](./evidence/mol-184/candidate-expiry.log), [combined candidate mapping run](./evidence/mol-184/candidate-mapping.log), and [source/test hashes and provenance manifest](./evidence/mol-184/manifest.json). The identical final ten-test suite yields baseline **1 pass / 9 fail / 26 assertions (exit 1)** and candidate **10 pass / 0 fail / 74 assertions**; combined candidate coverage is **65 pass / 0 fail / 292 assertions**. Nine baseline failures include new state/schema expectations and do not represent nine independent bugs. The earlier eight-test red run below is historical, not this final comparison.

Local historical artifacts supplied with the investigation:

- `/workspace/shared/mol184-baseline/README.md` and sibling logs: baseline build/runtime/test provenance.
- `/tmp/mol184-repros/audit/expiry-repro.ts`: executable offline baseline reproduction.
- `/tmp/mol184-repros/audit/expiry-result.jsonl`: captured status and forwarded-input evidence.
- `/tmp/mol184-history-red.log` and `/tmp/mol184-history-green.log`: initial eight red regressions and final ten-test green suite. Three key regressions were also reported independently red on original baseline (200 instead of expected 409).
- `/tmp/mol184-history-related.log` and `/tmp/mol184-history-types.log`: related-suite and typecheck evidence.
- `/tmp/mol184-repros/rewind/rewind.test.ts`, `results.log`, and `REPORT.md`: six tests / 38 assertions proving adapter selection only, with incremental, ordinary append and new-thread fork controls.
- `/workspace/shared/mol184-evidence/focused-final.log`: independent final combined rerun. Independent review additionally reports passing mode-disabled/re-enable and promotion-database-rollback controls; retain its review artifact in the final bundle.

These local paths are not public download links. Copy the synthetic reproduction and its output into the approved evidence bundle before their temporary workspace disappears. Record SHA-256 hashes there. Never include account cookies, bearer tokens, actual chat history or private reasoning.

## Architecture and source-to-behavior comparison

```text
Native client
  thread_id / turn_id / optional fork metadata
        |
        v
QA pool: authenticated client scope + native thread -> session hash
  sessions: durable account owner, project binding, expected-history marker (candidate)
  temporary_history: private serialized Q&A + response ID + 48-hour idle expiry
        |
        | normalize identity; enforce owner; reconstruct temporary input
        v
QA adapter: account namespace + native thread -> stable QA conversation key
        |
        v
Durable saved mapping: pending/bound reservation + saved conversation URL
  response alias -> current mapping (not an historical snapshot)
        |
        v
Browser worker -> physical Send -> observed Web turn -> completion/settlement
        |
        v
Pool completion: save temporary history OR finish promotion to persistent mode
```

Source links below are pinned to the baseline; candidate review must compare the actual changed hunks rather than assume line numbers remain stable.

| Source | Established behavior | Implication |
|---|---|---|
| [qa-pool.ts](https://github.com/Molaison/codex-chatgpt-web/blob/26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1/src/qa-pool.ts), initialization and temporary-history request/completion paths | Startup/minute sweep deletes expired prompt content; request only rejects while expired row remains; completed temporary response refreshes 48-hour expiry | Baseline loses the distinction between a fresh thread and an old thread whose content was purged |
| [qa-conversation-key.ts](https://github.com/Molaison/codex-chatgpt-web/blob/26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1/src/adapters/chatgpt-web/qa-conversation-key.ts) | QA identity is account namespace + thread; model/effort changes do not create a new QA identity | Fix must preserve owner/identity compatibility |
| [conversation-key.ts](https://github.com/Molaison/codex-chatgpt-web/blob/26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1/src/adapters/chatgpt-web/conversation-key.ts) | Retained input compilation can select suffix after the latest assistant; Full identity includes additional execution/model/effort/compaction dimensions | Truncated history alone is not a proven Web rewind |
| [conversation-persistence.ts](https://github.com/Molaison/codex-chatgpt-web/blob/26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1/src/adapters/chatgpt-web/conversation-persistence.ts) | Durable reservation + URL binding, not a persisted branch/head journal | Successful URL restore is insufficient proof of canonical history agreement |
| [saved-chat-aliases.ts](https://github.com/Molaison/codex-chatgpt-web/blob/26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1/src/responses/saved-chat-aliases.ts) | Response IDs validate/resume the current saved mapping | Old `previous_response_id` is not historical branch selection |
| [turn-execution.ts](https://github.com/Molaison/codex-chatgpt-web/blob/26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1/src/adapters/chatgpt-web/turn-execution.ts) | Execution, request replay, instruction lineage and physical retirement have different identities/lifetimes | Expiry fix must not silently change transport retry/cancel/Steer semantics |

### Bounded candidate state contract

The intended implementation records that temporary history is expected on the **existing sessions row**. This avoids storing expired prompt text indefinitely and avoids introducing a second session identity system. The implemented column is `temporary_history_expected INTEGER NOT NULL DEFAULT 0`. Startup backfill, successful temporary save and successful persistent promotion use transactions. JSON and SSE completion paths are covered; failed HTTP, incomplete responses, failed SSE promotion and atomic write rollback are included in the ten-test suite.

```text
Fresh owner binding; no temporary history expected
  | successful completed temporary turn
  v
Temporary history expected + live content
  | next successful temporary turn -> refresh content and 48-hour idle expiry
  | expiry / startup purge / periodic purge
  v
Temporary history expected + no usable content
  | repeat request / process restart / mode-switch attempt
  +---------------------------> explicit 409; ZERO upstream calls
  |
  +-- explicit new independent thread -> new state, old state unchanged

Temporary history expected + live content
  | persistent-mode request with inherited content
  | failure / incomplete stream / cancellation -> keep expected state
  | successful completed persistent promotion
  v
Persistent state; temporary content removed; expected marker cleared
```

Migration must mark sessions whose legacy history rows still exist **before any startup purge**, including already-expired rows. Content expiry still deletes `input_json` and the stored response from `temporary_history` after the existing 48 idle hours. The non-content marker survives restart and purge. Already-purged legacy rows cannot be reconstructed by migration; do not claim retroactive recovery.

An expired thread must not be silently reset by retry, persistent-mode selection, `previous_response_id`, or an unverified assertion that caller input is full history. Recovery/import support needs its own explicit validation contract. The safe stage-1 path is an explicit new thread. Preserve the last trusted owner binding on all failures.

## Offline reproduction and regression commands

The following commands are local evidence reproduction, not remote deployment commands. Run from a verified checkout; do not change the shared working tree to baseline while another task is editing it. Use separate approved worktrees/checkouts for red/green comparison. The historical reproduction imports `/workspace/shared/mol184/src/qa-pool.ts` absolutely: on another checkout, copy the synthetic script into the evidence directory and change **only that import** to the selected checkout, recording both script hashes and the diff.

Historical baseline invocation, as used in this workspace:

```sh
cd /workspace/shared/mol184
PATH=/workspace/shared/mol184-tools/node_modules/.bin:$PATH \
  bun /tmp/mol184-repros/audit/expiry-repro.ts
```

This script asserts the **buggy** behavior (409 then 200, and 200 after restart). It is a red reproduction, not a passing candidate acceptance test. On the fixed code its original assertions should fail. Do not change expected statuses in its recorded baseline output.

Candidate regression invocation after the test file exists and the candidate SHA is recorded:

```sh
cd /workspace/shared/mol184
RUN_ROOT=$(mktemp -d /tmp/mol184-validation.XXXXXX)
export PATH=/workspace/shared/mol184-tools/node_modules/.bin:$PATH
git rev-parse HEAD
git status --short
bun --version
node --version
env -u CODEX_SQLITE_HOME CODEX_HOME="$RUN_ROOT/codex" \
  CODEX_CHATGPT_WEB_HOME="$RUN_ROOT/app" \
  bun test tests/qa-pool-history-expiry.test.ts
env -u CODEX_SQLITE_HOME CODEX_HOME="$RUN_ROOT/codex" \
  CODEX_CHATGPT_WEB_HOME="$RUN_ROOT/app" \
  bun test tests/qa-sessions.test.ts tests/qa-portable-sessions.test.ts \
  tests/qa-conversation-persistence.test.ts tests/prompt-history-metadata.test.ts \
  tests/subagent-environment-history.test.ts
bun run typecheck
bun run check-version
```

Capture stdout, stderr and exit status separately for every command. The new expiry suite should remain socket-free with mocked fetch and temporary SQLite files. Existing `tests/qa-pool.test.ts` uses loopback listeners; execute it only in an environment where those are permitted, and classify an infrastructure denial separately from an assertion failure. Do not bypass socket restrictions.

Minimum candidate test assertions (report covered/missing individually):

1. Expired in-process continuation returns `409 temporary_history_expired`; every repeat remains 409; upstream call count unchanged.
2. Restart after expiry still rejects without upstream calls; private history rows have been purged.
3. Legacy migration marks expired rows before purge; reopening is idempotent; unrelated sessions stay usable.
4. Unexpired temporary history is supplied exactly once and successful completion refreshes its retention.
5. Explicit new thread succeeds with no old canary/history and distinct binding.
6. Successful temporary-to-persistent promotion clears marker/content only after validated completion; follow-up remains usable.
7. Failed/non-completed promotion retains expected history state; after expiry it cannot bypass the conflict.
8. Client/account/thread isolation, unchanged owner on unavailable account, and existing concurrency guard remain intact.
9. Streaming completion and interruption cover the same completion gate; distinguish covered cases from proposed additions.

### Re-run the same committed test against baseline and candidate

After the reviewed candidate is committed, run this from that clean checkout. `EVIDENCE_ROOT` is an executor-provided, new isolated directory; `bun` must be the verified version. This does not switch or modify the working tree.

```sh
set -eu
: "${EVIDENCE_ROOT:?Provide a new isolated evidence directory}"
case "$EVIDENCE_ROOT" in /*) ;; *) echo "EVIDENCE_ROOT must be absolute" >&2; exit 1;; esac
test ! -e "$EVIDENCE_ROOT"
mkdir -m 700 "$EVIDENCE_ROOT"
SOURCE=$(pwd)
CANDIDATE=$(git rev-parse HEAD)
BASE=26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1
test -z "$(git status --porcelain)"
printf '%s\n' "$BASE" "$CANDIDATE" > "$EVIDENCE_ROOT/commits.txt"
for version in baseline candidate; do
  mkdir "$EVIDENCE_ROOT/$version"
  ref=$BASE; test "$version" = baseline || ref=$CANDIDATE
  git archive "$ref" | tar -x -C "$EVIDENCE_ROOT/$version"
  ln -s "$SOURCE/node_modules" "$EVIDENCE_ROOT/$version/node_modules"
done
# Give the original source the identical committed acceptance test.
git show "$CANDIDATE:tests/qa-pool-history-expiry.test.ts" \
  > "$EVIDENCE_ROOT/baseline/tests/qa-pool-history-expiry.test.ts"
for version in baseline candidate; do
  set +e
  (cd "$EVIDENCE_ROOT/$version" && env -u CODEX_SQLITE_HOME \
    CODEX_HOME="$EVIDENCE_ROOT/$version-codex" \
    CODEX_CHATGPT_WEB_HOME="$EVIDENCE_ROOT/$version-app" \
    bun test tests/qa-pool-history-expiry.test.ts) \
    > "$EVIDENCE_ROOT/$version.stdout" 2> "$EVIDENCE_ROOT/$version.stderr"
  status=$?
  set -e
  printf '%s\n' "$status" > "$EVIDENCE_ROOT/$version.exit"
done
sha256sum "$EVIDENCE_ROOT"/*.stdout "$EVIDENCE_ROOT"/*.stderr \
  "$EVIDENCE_ROOT"/*/tests/qa-pool-history-expiry.test.ts \
  > "$EVIDENCE_ROOT/SHA256SUMS"
```

The baseline must fail on the missing expiry guarantee, and candidate must pass. Review the assertions and errors, not just exit codes. A candidate failure or an infrastructure error is not acceptance. Sharing read-only dependencies is valid only after matching the unchanged lockfile and verified runtime; otherwise provision isolated locked dependencies through the approved executor flow.

### Historical baseline results and blockers

Baseline runtime: Bun **1.4.0**, Node **24.19.0**, npm **11.9.0**, Python **3.12.14**, Git **2.52.0**. Package version **6.1.9**. Root/launcher dependencies were installed with `--frozen-lockfile --ignore-scripts`; Electron binary download was skipped.

- Passed root typecheck, launcher typecheck, version check (`VERSION_SYNC_OK 6.1.9 bun@1.4.0`) and launcher renderer build.
- Passed 55 tests / 218 expectations in the five session-core files listed above; seven selected launcher state tests passed.
- Retained-compaction-inclusive run: 88 pass / 14 fail. Unix socket listen denial (`EPERM`) and downstream failures prevent interpreting this as successful integration coverage.
- Multipart Chromium fixtures: 0 pass / 3 fail before execution; Chromium process singleton socket denied (`EPERM`). Browser binary presence is not browser availability.
- Context suite: 68 pass / 1 skip / 5 fail. Five pristine-baseline effort activation mocks lack `page.evaluate`; unrelated failures must remain visible, not be credited to or hidden by this patch.
- Launcher saved-recovery suite could not import Electron because its binary was intentionally not installed.
- Aggregate verify, audits, all-suite tests, installed Codex integration, platform packaging and real account-bound behavior were not run.

## Designated-executor real verification packet

### Preconditions and permission gate

The main task owner, not this document author, owns the live handoff. Fill these fields before execution:

| Required field | Value |
|---|---|
| Executor task and verified target | `<DESIGNATED_EXECUTOR_TASK / VERIFIED_TARGET>` |
| Candidate SHA / PR / patch hash | `<FIX_COMMIT_SHA / VERIFIED_PR_URL / PATCH_SHA256>` |
| Baseline checkout and candidate checkout | `<SEPARATE_APPROVED_PATHS>` |
| Runtime/provider/launcher/installed Codex versions | `<EXACT_VERSIONS_AND_BUILD_HASHES>` |
| QA and Full launch commands and routes | `<VERIFIED_EXISTING_COMMANDS; NO GUESSED FLAGS>` |
| Isolated DEV profile, pool DB and account permission | `<APPROVED_SYNTHETIC_ONLY_RESOURCES>` |
| Evidence destination/access | `<APPROVED_ARTIFACT_DIRECTORY>` |
| Budget approval and stop owner | `<APPROVAL_REFERENCE / OWNER>` |

Preserve the intentional [QA/main versus Full source split](./ywl-source-branches.md). Both may report 6.1.9 and still be different runtimes. Recorded Full source checkpoint is `640c77fe5fdeef37893c0b739c8e08bd82b3fc48`; this does not establish what is deployed. QA cannot execute local tools/MCP; Full tool claims require an actual installed-client/tool loop. DEV simulated tools still use real model calls but cannot prove that outer integration.

The source branch document records local Bun 1.3.14 / Node 22.20.0, whereas package metadata declares Bun 1.4.0. Record and explain any executor version deviation; do not silently equate environments. Confirm OS, browser/Electron, Codex, launcher, provider route, selected account/model/effort and exact source/build before comparing results.

### Proposed caps: NOT APPROVED

For a first live smoke tranche, propose **60 minutes total wall time, 24 physical ChatGPT submissions maximum, concurrency 1, GPU 0, and zero new monetary charges/purchases**. Existing account quota consumption still needs explicit approval. These are proposals, not permission. Stop before any unknown billable operation, rate limit, exhausted quota, authentication/setup change, unapproved account switch, service restart, new access, or cap. Return partial evidence and the precise blocker. Count every retry, manual Web turn, staging/checkpoint submission and compaction send. Do not equate logical turns with physical calls.

Context-capacity sweeps require a separate enumerated budget; Bigger Context can multiply physical sends. Do not spend the initial tranche trying every model/effort combination.

### Data isolation and restoration

Use already-authorized dedicated DEV/test profiles and inert canaries only. Unset inherited `CODEX_SQLITE_HOME`; isolate `CODEX_HOME`, `CODEX_CHATGPT_WEB_HOME`, pool SQLite, mapping stores, artifact directories, ports and thread IDs. Verify resolved paths before starting. Never copy production credentials/history or mutate production SQLite to force expiry.

For the expiry case, stop only the isolated fixture process, close its DB, back up its synthetic SQLite state (including a consistent WAL checkpoint or SQLite-supported backup), set the fixture's expiry in that isolated DB, restart only that fixture, and record the operation. Do not alter the machine clock or production services. The guarded fixture below provides exact schema inspection, SQLite-consistent backup and expiry commands; review their resolved paths before execution.

Record pre-run processes, ports and relevant configuration paths. Afterward stop only owned test processes, restore only changed test configuration, verify pre-existing services remain untouched, and retain approved synthetic evidence. Remove disposable test data only under approved cleanup scope. A code downgrade must not be assumed to undo the DB migration; use the preserved isolated baseline database when comparing old code.

### Live scenarios and acceptance

| ID | Scenario | Acceptance and mandatory evidence |
|---|---|---|
| LIVE-01 | Three-turn temporary session with unique synthetic marker | Actual submitted history and response provenance agree with one account/thread; marker checks are secondary evidence; record physical sends |
| LIVE-02 | Force expiry in isolated fixture, continue twice | Both reject with explicit expiry conflict; **zero** physical Send/upstream requests after expiry; prior prompt content purged |
| LIVE-03 | Restart isolated pool after expiry, then continue | First and repeated requests reject; durable marker survives; no account switch or fresh-chat substitution |
| LIVE-04 | New independent thread after LIVE-03 | Succeeds without old private content or old binding; no bleed from expired thread |
| LIVE-05 | Unexpired temporary session promoted to persistent | Inherited context supplied, successful terminal completion verified, marker/content cleared afterward; next persistent turn resumes intended chat |
| LIVE-06 | Controlled failed promotion without extra submission uncertainty | Expected marker retained; expiry/restart cannot bypass failure. If safe failure injection is unavailable, mark not run and retain mock-only evidence |
| LIVE-07 | Account/client and QA/Full control | Distinct owned test profiles/routes; no canary leakage; QA has no tool capabilities; actual Full integration remains separately reported |

Run identical applicable synthetic fixtures on baseline and candidate. Do not intentionally continue unsafe baseline cases outside the isolated test account. If the physical Send boundary cannot be observed, mark the zero-send claim **unproven**, even when the HTTP response is 409. A model answer alone is insufficient evidence of continuity, isolation, or canonical synchronization.

### Concrete isolated pool launch, request and expiry fixtures

The pool entry point is source-verified. The helper below passed Bun 1.4.0 offline preflight checks (including missing DB, outside paths, dangling symlinks, marker, account mode and origin rejection), but has not been live-executed. These commands are not permission to execute. The executor supplies `QA_POOL_TEST_CONFIG`, `QA_TEST_ROOT` (a newly created dedicated synthetic-only directory), `QA_TEST_MODEL` (an approved configured model), and `QA_TEST_THREAD` (unique run ID). The config must bind only loopback, use a new DB under that root, and reference an approved isolated backend/profile. Do not generate or import real credentials. Review the config and all backend destinations before launch. Existing production state is forbidden even when reachable through a loopback URL.

Once that review and live budget are approved, create a fresh root with the commands below, then provision only the approved synthetic `config.json` and `client.key` beneath it, with `databasePath` set to the absolute `$QA_TEST_ROOT/pool.sqlite` path. Never mark an existing directory. The helper requires absolute, non-symlink paths with private ownership; nonexistent DB targets are checked through their existing parents before any pool initialization or migration. Use a single approved account/client for this fixture. `QA_TEST_BACKEND_ORIGIN` must be the exact independently verified dedicated backend origin, and `QA_TEST_ACCOUNT` its configured ID; loopback alone does not prove isolation. All backend profile/storage paths and their ownership still require the executor's review. No other process may modify the root or config while this fixture runs; the preflight is not protection against a hostile concurrent filesystem writer.

```sh
umask 077
QA_TEST_ROOT=$(mktemp -d /tmp/mol184-live.XXXXXXXX)
export QA_TEST_ROOT
printf 'MOL184_SYNTHETIC_ONLY\n' > "$QA_TEST_ROOT/.mol184-synthetic-only"
# Now provision reviewed synthetic-only config/key and the helper below in this root.
# Export absolute QA_POOL_TEST_CONFIG, QA_TEST_MODEL, unique QA_TEST_THREAD,
# QA_TEST_ACCOUNT and the explicitly approved QA_TEST_BACKEND_ORIGIN.
```

Place this helper at `$QA_TEST_ROOT/fixture.ts`. Every operation revalidates isolation. `preflight` opens no database, makes no network call and creates no files. The launch wrapper must pass it before every initial start and restart. Error output is fixed text, identifiers are hashed, and response capture retains only allowlisted status/error codes and synthetic visible-marker checks. No raw response, reasoning, error message or private metadata is logged.

```ts
import { Database } from "bun:sqlite";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, parse, join } from "node:path";
import { createHash } from "node:crypto";
const hash = (v: unknown) => createHash("sha256").update(String(v)).digest("hex");
const obj = (v: any) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
function mainPath(p: unknown, missing = false): string {
  if (typeof p !== "string" || !isAbsolute(p) || resolve(p) !== p) throw Error();
  // Reject symlinks in every component, including dangling ones; never follow them.
  let part = parse(p).root, absent = false;
  for (const name of p.slice(part.length).split("/").filter(Boolean)) {
    part = join(part, name);
    if (absent) continue;
    try {
      const st = lstatSync(part);
      if (st.isSymbolicLink() || (!st.isDirectory() && part !== p)) throw Error();
    } catch (e: any) {
      if (missing && e.code === "ENOENT") absent = true;
      else throw Error();
    }
  }
  return p;
}
async function run() {
  const root = mainPath(process.env.QA_TEST_ROOT);
  if (!/^mol184-live\.[A-Za-z0-9]{8}$/.test(root.slice(root.lastIndexOf("/") + 1)) || dirname(root) !== "/tmp") throw Error();
  const st = lstatSync(root);
  if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077)) throw Error();
  if (realpathSync(root) !== root) throw Error();
  const inside = (p: unknown, missing = false) => {
    const target = mainPath(p, missing), rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw Error();
    // Existing objects must be private, owned, and not hard-linked elsewhere.
    let current = target;
    while (current !== root) {
      try {
        const s = lstatSync(current);
        if (s.uid !== process.getuid!() || (s.mode & 0o077) ||
            (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))) throw Error();
      } catch (e: any) { if (!(missing && e.code === "ENOENT")) throw Error(); }
      current = dirname(current);
    }
    return target;
  };
  const file = (p: unknown) => { const x = inside(p); if (!lstatSync(x).isFile()) throw Error(); return x; };
  if (readFileSync(file(join(root, ".mol184-synthetic-only")), "utf8") !== "MOL184_SYNTHETIC_ONLY\n") throw Error();
  const cfg = JSON.parse(readFileSync(file(process.env.QA_POOL_TEST_CONFIG), "utf8"));
  if (Object.keys(cfg).some(k => !["host","port","databasePath","clients","accounts"].includes(k))) throw Error();
  if (cfg.host !== "127.0.0.1" || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw Error();
  const dbPath = inside(cfg.databasePath, true);
  if (dbPath !== join(root, "pool.sqlite")) throw Error();
  try { if (!lstatSync(dbPath).isFile()) throw Error(); } catch (e: any) { if (e.code !== "ENOENT") throw Error(); }
  // SQLite may open sidecars before reading its main DB. Guard them as well.
  for (const suffix of ["-wal", "-shm", "-journal"]) inside(dbPath + suffix, true);
  inside(join(root, "codex"), true); inside(join(root, "app"), true);
  for (const name of ["pool.log","seed.json","before.json","backup.json","expired.json","restart-probe-1.json","restart-probe-2.json","after-purge.json","new-thread.json","before-expiry.sqlite"]) inside(join(root, name), true);
  if (!Array.isArray(cfg.clients) || cfg.clients.length !== 1 || !Array.isArray(cfg.accounts) || cfg.accounts.length !== 1) throw Error();
  const client = cfg.clients[0], account = cfg.accounts[0];
  if (Object.keys(client).some(k => !["id","keyFile"].includes(k)) || typeof client.id !== "string" || !client.id) throw Error();
  const keyPath = file(client.keyFile);
  if (keyPath !== join(root, "client.key") || process.env.QA_POOL_TEST_CONFIG !== join(root, "config.json")) throw Error();
  if (!readFileSync(keyPath, "utf8").trim()) throw Error();
  if (Object.keys(account).some(k => !["id","origin","models","enabled","sessionModes","conversationStoreDirectory","browserHostDescriptorPath"].includes(k))) throw Error();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(account.id) || account.id !== process.env.QA_TEST_ACCOUNT || account.enabled === false || account.sessionModes !== true) throw Error();
  const url = new URL(account.origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash || account.origin !== process.env.QA_TEST_BACKEND_ORIGIN || Number(url.port) === cfg.port) throw Error();
  if (!Array.isArray(account.models) || !account.models.length || account.models.some((m: any) => typeof m !== "string" || !m) || !account.models.includes(process.env.QA_TEST_MODEL)) throw Error();
  if (account.conversationStoreDirectory !== undefined) inside(account.conversationStoreDirectory, true);
  if (account.browserHostDescriptorPath !== undefined) file(account.browserHostDescriptorPath);
  const op = process.argv[2];
  if (op === "preflight") { console.log(JSON.stringify({preflight:"pass"})); return; }
  if (["inspect", "expire", "backup"].includes(op)) {
    file(dbPath); // Never create a DB from an inspection/expiry command.
    if ((op === "expire" || op === "backup") && process.env.QA_TEST_POOL_STOPPED !== "yes") throw Error();
    const db = new Database(dbPath, { readonly: op === "inspect", create: false });
    try {
      if (op === "backup") {
        const backup = inside(join(root, "before-expiry.sqlite"), true);
        // VACUUM INTO fails if the destination exists; check its path first.
        db.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
      }
      if (op === "expire") db.exec("UPDATE temporary_history SET expires_at=0");
      const cols = (db.query("PRAGMA table_info(sessions)").all() as any[]).map(x => x.name);
      const flag = cols.includes("temporary_history_expected") ? "temporary_history_expected" : "NULL AS temporary_history_expected";
      const sessions = (db.query(`SELECT session_hash,account_id,${flag} FROM sessions`).all() as any[]).map(x => ({session:hash(x.session_hash), account:hash(x.account_id), expected:x.temporary_history_expected}));
      const history = (db.query("SELECT session_hash,expires_at,length(input_json) AS content_bytes FROM temporary_history").all() as any[]).map(x => ({session:hash(x.session_hash), expires_at:x.expires_at, content_bytes:x.content_bytes}));
      console.log(JSON.stringify({sessions,history}));
    } finally { db.close(); }
    return;
  }
  if (!["seed", "probe", "new", "promote", "persistent-probe"].includes(op)) throw Error();
  const mode = ["promote", "persistent-probe"].includes(op) ? "persistent" : "temporary";
  const thread = process.env.QA_TEST_THREAD, model = process.env.QA_TEST_MODEL;
  if (!thread || !model) throw Error();
  const response = await fetch(`http://127.0.0.1:${cfg.port}/v1/responses`, {
    method:"POST", headers:{"content-type":"application/json",authorization:`Bearer ${readFileSync(keyPath, "utf8").trim()}`},
    body:JSON.stringify({model,stream:false,input:op === "seed" ? "Remember this synthetic marker: ORCHID-MOL184." : op === "new" ? "Reply READY to this independent question." : "What synthetic marker did I provide?",reasoning:{effort:`high-${mode}`},client_metadata:{"x-codex-turn-metadata":JSON.stringify({thread_id:op === "new" ? thread+"-independent" : thread})}})
  });
  const body = obj(await response.json());
  const visible = (Array.isArray(body.output) ? body.output : []).filter((x: any) => x?.type === "message" && x.role === "assistant")
    .flatMap((x: any) => Array.isArray(x.content) ? x.content : []).filter((x: any) => x?.type === "output_text" && typeof x.text === "string").map((x: any) => x.text).join("\n");
  const code = obj(body.error).code;
  console.log(JSON.stringify({op, http_status:response.status, response_status:["completed","failed","incomplete","cancelled","in_progress","queued"].includes(body.status) ? body.status : "other_or_absent",
    error_code:["temporary_history_expired"].includes(code) ? code : code ? "other_redacted" : "absent",
    thread:hash(op === "new" ? thread+"-independent" : thread), response_id:typeof body.id === "string" ? hash(body.id) : null,
    synthetic_visible_output:{marker_seen:visible.includes("ORCHID-MOL184"), ready_seen:/\bREADY\b/.test(visible)}}));
}
try { await run(); } catch { console.error("Fixture blocked or failed; review isolated inputs without logging secrets."); process.exitCode = 1; }
```

Commands below start only the dedicated pool. Backend launch commands are intentionally supplied by the executor because the correct QA/Full profile routing is environment-specific. Capture actual physical Send counts with approved backend instrumentation; this HTTP helper cannot establish that count by itself. Do not launch the entry point directly or skip preflight on restarts. Keep raw process logs private to this synthetic root and review/redact before export.

```sh
set -eu
# Run from the verified checkout. This function is the only launch path.
start_test_pool() {
  bun "$QA_TEST_ROOT/fixture.ts" preflight || return 1
  env -u CODEX_SQLITE_HOME CODEX_HOME="$QA_TEST_ROOT/codex" \
    CODEX_CHATGPT_WEB_HOME="$QA_TEST_ROOT/app" \
    bun src/qa-pool.ts "$QA_POOL_TEST_CONFIG" \
    > "$QA_TEST_ROOT/pool.log" 2>&1 &
  POOL_PID=$!
}
start_test_pool || exit 1
# Wait for this owned process's /healthz readiness before seed.
bun "$QA_TEST_ROOT/fixture.ts" seed > "$QA_TEST_ROOT/seed.json"
bun "$QA_TEST_ROOT/fixture.ts" inspect > "$QA_TEST_ROOT/before.json"
# Verify POOL_PID is this run's pool before stopping it. Never use broad pkill.
kill -TERM "$POOL_PID"
wait "$POOL_PID" || true
QA_TEST_POOL_STOPPED=yes bun "$QA_TEST_ROOT/fixture.ts" backup \
  > "$QA_TEST_ROOT/backup.json"
QA_TEST_POOL_STOPPED=yes bun "$QA_TEST_ROOT/fixture.ts" expire \
  > "$QA_TEST_ROOT/expired.json"
start_test_pool || exit 1
# Wait for this owned process's /healthz readiness again, then:
bun "$QA_TEST_ROOT/fixture.ts" probe > "$QA_TEST_ROOT/restart-probe-1.json"
bun "$QA_TEST_ROOT/fixture.ts" probe > "$QA_TEST_ROOT/restart-probe-2.json"
bun "$QA_TEST_ROOT/fixture.ts" inspect > "$QA_TEST_ROOT/after-purge.json"
bun "$QA_TEST_ROOT/fixture.ts" new > "$QA_TEST_ROOT/new-thread.json"
```

Wait for the owned pool's `/healthz` readiness before each request; connection failures are not scenario results. Above is the restart-expiry case. Run unexpired promotion on a fresh unique `QA_TEST_THREAD` using `seed`, `promote`, `inspect`, `persistent-probe`. For LIVE-02 in-process expiry, the isolated fixture owner may use the same guarded helper with the pool stopped for database mutation, but restarting changes it to LIVE-03. A true in-process timing case requires waiting through the retention boundary or a separately reviewed test-only clock/expiry injection; the offline socket-free tests already cover this boundary. Do not mislabel a restart case as in-process evidence. No global clock adjustment is authorized.

### Required returned artifacts

- Manifest with timestamp, source/build SHA, patch hash, runtime/client/browser versions, selected variant/route, approved budget, actual elapsed time, physical-send total and GPU use (expected zero).
- Exact shell/launcher commands and safe configuration diffs, including environment variable names and non-secret paths; do not expose credential values.
- Per-scenario JSONL: scenario ID, evidence type, hashed account/client/thread/conversation/head identifiers, expected/observed transition, logical turn, physical submissions, status/error, elapsed time and artifact hashes.
- Baseline red evidence and candidate green evidence, with stdout/stderr/exit status and SHA-256 hashes; record missing/skipped/blocked tests explicitly.
- Synthetic SQLite before/after inspection proving content purge and marker persistence, with no real chat content.
- Redacted visible UI screenshots/recordings where needed, response-boundary observations and safe request-shape captures. Do not collect hidden reasoning.
- Restoration checklist and remaining gap list. Report **pass / fail / blocked / not run / inconclusive**, never silently omit a case.

## Remaining MOL-184 gaps and next verification stages

1. **Rewind and Web branch identity.** The offline actual-adapter reproduction already shows same-key selection and U3-only resume for U1/A1/U2/A2 → U1/A1/U3 (six tests / 38 assertions). Re-run with `/workspace/shared/mol184-tools/node_modules/.bin/bun test /tmp/mol184-repros/rewind/rewind.test.ts`; it mocks the browser boundary and model strings. Next observe the actual Web submission. Accept only correct historical branch/reset or an explicit pre-Send conflict. Same URL and old response IDs are insufficient. Compare Web edit/regenerate and selected alternate branch, including changes between validation and Send. A generic non-prefix rejection is unsafe: intentional incremental requests, queued requests without answers and compaction can legitimately differ. A safe future guard requires authoritative full-history/incremental mode or base revision, an accepted-history watermark and epoch/answer anchors, persisted across restored URL handoff when that guarantee is required. Validate at queue selection, not only admission. Keep this as a separate design stage.
2. **Multi-end synchronization.** Add Web-only message while Codex canonical history is stale; require explicit ordered import or conflict. Verify canonical state, not just model recall. Test head change mid-read, queued requests and two-client races.
3. **Pagination/recovery.** Existing paper-history handling rejects incomplete histories. Preserve that safe boundary while separately testing overlapping pages, duplicate/missing IDs, cursor loops, ordering, cancellation and changing heads; no state mutation on incomplete evidence.
4. **Context capacity.** Measure beginning/middle/end inert canaries, constraints, tool facts and unfinished work below/near/above observed limits. Record actual submitted size, tokenizer estimate, physical calls and compaction. Separate input acceptance, advertised limit and retained recall. No universal window claim from one model/effort or configuration constant.
5. **Steer/cancel/settlement with MOL-185.** QA queues continuation; Full lineage may supersede active instructions. Test before Send, generation, tool wait, logical completion versus physical settlement, late tool results and stale retries. Review account namespace in targeted cancellation. Do not change transport ownership in this bounded expiry patch.
6. **Fork/tools/files.** Verify parent/child canary separation across restart, missing inheritance fail-closed, actual Full call/result ownership, late/duplicate results, attachment continuity and downloaded-byte/account isolation. A simulated tool response is not installed Codex end-to-end coverage.

Existing test families to extend rather than replace: `qa-sessions`, `qa-portable-sessions`, `qa-conversation-persistence`, `qa-response-aliases`, `qa-saved-chat-recovery`, `qa-pool`, `paper-history`, `paper-recovery`, `chatgpt-web-harness`, `retained-compaction`, and download/file response suites. Their mock/DOM status must travel with their results.

## Method provenance

Pinned method text and applicable LICENSE files were read through the GitHub connector:

- [Be Ambitious](https://github.com/DannyMac180/skills/blob/7dc63b7a748b8bd14bf213c15ecddd4536409407/be-ambitious/SKILL.md), DannyMac180/skills commit `7dc63b7a748b8bd14bf213c15ecddd4536409407`; [MIT LICENSE](https://github.com/DannyMac180/skills/blob/7dc63b7a748b8bd14bf213c15ecddd4536409407/LICENSE), copyright 2026 Dan McAteer.
- Official cursor/plugins commit `f713f14203cd6420cec13cd7c55c32d598dbab68`: [Poteto Mode](https://github.com/cursor/plugins/blob/f713f14203cd6420cec13cd7c55c32d598dbab68/pstack/skills/poteto-mode/SKILL.md), [Bug fix playbook](https://github.com/cursor/plugins/blob/f713f14203cd6420cec13cd7c55c32d598dbab68/pstack/skills/poteto-mode/playbooks/bug-fix.md), and [Show me your work](https://github.com/cursor/plugins/blob/f713f14203cd6420cec13cd7c55c32d598dbab68/pstack/skills/show-me-your-work/SKILL.md); [pstack MIT LICENSE](https://github.com/cursor/plugins/blob/f713f14203cd6420cec13cd7c55c32d598dbab68/pstack/LICENSE), copyright 2026 Lauren Tan. The repository root has no LICENSE at this pin; the applicable inspected license is under pstack.

The adopted method is to deepen verification within the same scope: start from code and captured requests, reproduce before fixing, compare red and green behavior, and keep an evidence-linked decision trail. Distinguish durable conversation identity from native turn, exact request round, physical Send and logical completion. Prefer explicit unsupported/conflict outcomes over silent context substitution. Named methods are not proof of correctness.

Six text/license files were archived outside the repository under `/workspace/shared/mol184-methods`; `provenance.json` records verified source URLs, Git blob IDs and local SHA-256 hashes. No method package, unknown script, orchestration rule, pipeline or workflow was installed or executed. External method text does not override this task's permission or execution boundaries.


## Stage 2 addendum: request receipt and history commit boundary

**Offline candidate evidence only; integrated CPR recovery and real acceptance remain incomplete.** Stage 1 evidence above belongs to its original candidate, not to this subsequent patch. This stage addresses user retries after a missing terminal response and continuation after a failed history write. It does not establish general end-to-end exactly-once execution.

### Reused red evidence and acceptance paths

The coordinator supplied a six-scenario offline reproduction using PR7 `196f0c412fe6fc0f9d0a9143ff6e033268e3de1e`, with only `src/qa-pool.ts` overlaid from PR6 `fe8cd68b47ed0c258499f87391a0b8fccae190b1`. This is a named source composite, not a merge commit or the candidate. The supplied manifest reports all 103 materialized production files byte-verified. The original run and repeat each report two passing controls and four failing safety assertions. Its existing MCP SDK is 1.30.0 versus the target declaration ^1.31.0; no MCP invocation was made, and this is not dependency-conformant aggregate acceptance.

The coordinator's production CPR/pool normalization, HTTP loopback, SQLite, response handler, bridge, adapter and execution registry ran. Only the browser worker boundary was mocked. Its `browserWorkerStarts` counts simulated runtime starts, not real ChatGPT Sends. This evidence was inspected and reused, not independently rerun by the document author.

| User path | Original observation | Acceptance for this stage |
| --- | --- | --- |
| Retry without message ID, direct pool | Two mocked starts and changed execution key | With stable native request/turn identity, preserve generated message identity and avoid a second forward |
| Same retry through CPR then pool | Two mocked starts | Both layers must agree on stable identity; pool-only tests do not prove CPR integration |
| Existing stable message ID | One mocked start | Preserve caller IDs and reconnect behavior |
| Intentionally identical question, new native turn | Two mocked starts | Preserve two distinct intended requests |
| R2 committed, terminal delivery lost, retry original T2 with previous=R1 | 409 before adapter replay; unrelated stale-head turn also 409 | Replay the matching retained temporary receipt before head-conflict checks; unrelated stale-head turn still rejects |
| History INSERT fails after upstream completion, then pool reopen and next turn | Marker rolled back; next forward contains no old context | Durable pre-forward uncertainty barrier survives failed completion transaction/reopen; block a new forward unless safely reconciled |

### Implemented bounded contract and compatibility

- Ownership: pob changes the QA pool and its local receipt store/tests. CPR/adapter integration remains the coordinated MOL-185 boundary. Do not overwrite that work or treat it as already verified here.
- Stable identity is available from a caller-supplied native request ID or turn ID, scoped to the authenticated client/session/account/project. Generated missing user-message IDs are deterministic only when that identity and the same thread are available. Caller-supplied IDs remain intact. Requests without stable identity do not acquire an exactly-once guarantee.
- The turn fallback includes user-message IDs and tool-output call IDs to distinguish rounds; an explicit request ID is the stronger compatibility route. Distinct new turns preserve intentionally repeated text. Reusing one request identity with changed payload rejects; changing `stream` is a payload conflict, not a response-format conversion.
- A pending marker is committed before forwarding. For a stable receipt, the same-process active execution is owned independently of a downstream observer: one upstream fetch drains in the background; the first observer still receives incremental chunks, and its abort/cancel detaches only that observer. An exact reconnect joins the existing result promise and replays its completed wire without a second forward. A completed temporary response, retained history and receipt commit atomically. Process restart without the active execution, upstream failure or the ten-minute upstream-observation limit leaves an unknown outcome and the durable pending barrier. The observation limit does not prove the real model stopped. Only an explicitly proven pre-Send rejection can release an uncertain request. A pending marker does not assert that a real Send occurred; it means that a safe non-submission result is unavailable. Frozen-source tests below exercise active recovery at the pool boundary.
- Temporary completed receipts replay captured SSE wire through the terminal frame, or the saved JSON response. Replay does not extend retention. A newly committed temporary response and its latest receipt share a 48-hour expiry from completion, preserving rolling temporary-history retention. The next admitted request replaces the previous receipt; this is latest-request recovery, not indefinite replay of every historical turn.
- Successful temporary-to-persistent promotion preserves the existing content-clearing promise: clear receipt response/digest content for that session, retain the latest opaque known-completed/no-replay identity, and do not cache the persistent answer. A repeat cannot transparently recover that answer from this store and must not cause another Send.
- Pure persistent, paper and compact paths do not gain a new durable response cache or general retry guarantee. This stage does not implement Web branch reconciliation, historical rewind, live compaction measurements, installed-client reconnection or global exactly-once delivery.

### Storage, privacy and operational limits

The new SQLite metadata includes hashed session/request identity, payload digest, state/expiry, bounded temporary response content and a pending-history marker. These are additional persisted data, not zero-storage deduplication. Temporary wire/content can contain synthetic or real output depending on deployment; do not copy production rows into evidence.

The store holds **one latest receipt per session**, replacing it when the next request is admitted. The discarded experimental design's 256 lifetime turns and permanent accumulating tombstones are not implemented. More than 256 legitimate turns are explicitly tested. There is no global fixed session/storage cap in this patch; growth still follows session cardinality. This is bounded per-session receipt storage, not an absolute bound on the database.

Replay storage is limited to 1 MiB for combined encoded JSON response and base64 wire. Larger ordinary responses still deliver and commit their history, but retain only a known-completed/no-replay state; they do not fail merely for exceeding the replay budget. The SSE parser separately guards an incomplete event buffer at 64 MiB. SQLite overhead, history content, ordinary response buffering and session count are not included in the 1 MiB cache limit.

Expiry removes the latest receipt's digest/response content and retains its opaque identity/state until replacement. Promotion clears content as above. An unknown post-Send outcome remains blocked across pool restart; this patch supplies no automatic reconciliation tool. In contrast, the trusted adapter code `concurrency_limit_exceeded` proves pre-worker admission rejection on temporary-history paths, and `prompt_attachments_not_submitted` proves the existing pre-Send attachment rejection. These release the pending state for a safe retry. A generic HTTP 503/429 alone is not sufficient evidence of non-submission. The real local admission path is tested through the production response handler; it recovers and allows a subsequent question.

A transaction rechecks the current history response head before reserving a turn, preventing a second pool from forwarding an earlier snapshot after another pool has committed. Historical receipts overwritten by a newer request are not available for arbitrary old-turn replay. Logical content clearing does not promise physical erasure from SQLite/WAL or backups.

### Verification ledger and handoff

- Coordinator red package: inspected source composite and captured observations; original mock-browser loopback run is red as described above. Not a live browser result.
- Frozen candidate regression: **45 pass / 0 fail / 595 assertions** across `qa-pool`, updated history-expiry and request-receipts suites; root typecheck passes. Reproduction: `bun test tests/qa-pool.test.ts tests/qa-pool-history-expiry.test.ts tests/qa-pool-request-receipts.test.ts`, and `bun run typecheck` with Bun 1.4.0. Exact source/test hashes and complete logs are in `docs/evidence/mol-184/receipt-manifest.json`. The local tests invoke actual `createQaPool().fetch(Request)` and real temporary SQLite, replacing only backend `fetch`. Forward counts are boundary observations, not physical browser Sends. Closing/reopening a pool is not a complete installed-runtime restart.
- Intermediate cross-layer composite: **5 pass / 1 fail / 35 assertions**, aggregate source/test SHA-256 `56be3b090004e1c739502416e33057612d322d71c64f8737c75d772478f3c171`; see `docs/evidence/mol-184/receipt-intermediate-candidate-composite.json` and matching logs/observations. This uses in-memory Request dispatch in place of actual loopback HTTP, real CPR/pool/SQLite/response handler/adapter/registry, and a mocked browser worker. Bun 1.4.0 and existing MCP SDK 1.32.1 were used. Pool reconnect preserves one upstream fetch and complete replay; R2 replay preserves its ID/full answer/one terminal, and an unrelated stale-head request remains 409. The outstanding CPR retry returns 409 because the old PR7 normalizer still generates random message IDs; no second worker starts, but result recovery fails. This is an intermediate snapshot, not final candidate acceptance. Its adapted baseline is 1 pass / 5 fail: the additional failure is a stricter single-upstream-fetch control assertion, not a fifth original product defect. Actual HTTP and real browser behavior remain untested here.
- Independent final review: record the reviewer decision on the PR at its exact head; this document is not a review approval. Exact-head stage 2 CI: not run at this document freeze. Stage 1 CI failures and its passing focused suite are not stage 2 results.
- Related local regressions: `qa-portable-sessions`, `qa-sessions`, `paper-history`, `paper-registry`, `paper-recovery` and `paper-recovery-reader`: **52 pass / 2 existing skips / 0 fail / 473 assertions**. These are CPU regression results, not real browser validation.
- Cross-pool race regression: a real second pool in a subprocess commits to the same synthetic SQLite database between the first pool’s read and reservation. The stale request returns `temporary_history_changed` without forwarding; a request using the new head continues. Focused run: 1 pass / 12 assertions. A separate candidate mutation removing the head compare-and-swap produces the expected red result (200 instead of 409). That mutation is a sensitivity control, not the historical product baseline.
- Real Codex/browser execution: not run. The existing isolated-environment, redaction, restoration and authorization gates above still apply. This addendum neither increases the proposed live budget nor releases real execution.

The receipt manifest records frozen source/test hashes, commands, results and evidence-file hashes. Bind the published commit/tree and subsequent CI to that frozen content in the PR delivery record; this document cannot embed its own future commit hash. Required focused assertions include original-request replay after lost terminal delivery; unrelated stale-head rejection; changed-payload conflict; explicit-ID/tool-round separation; client isolation; pending/INSERT fault restart safety; original SSE event preservation; terminal framing; first-observer incremental delivery and abort detachment; same-process accepted reconnect with exactly one backend forward; restart/observation-timeout uncertainty; promotion clearing; trusted pre-admission 503/429 retry and following-turn non-regression; reviewed bounded retention/reclamation without duplicate Send. A passing count alone cannot substitute for those user-path outcomes.

Efficiency: reuse the coordinator's existing six-scenario source/evidence package and extend the narrow pool/SQLite regressions. Do not repeatedly run known socket/environment-blocked aggregate suites without a relevant environment change. Preserve failure evidence and spend the next real validation on the integrated retry/history paths, not on duplicate reports or repeated mock counts.
