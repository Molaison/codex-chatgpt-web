# MOL-185: network reliability validation handoff

Status: three focused fixes reproduced and tested offline; real validation and final integrated results remain separate gates. No live calls or remote execution were performed while preparing this document. Do not interpret proposed limits as approval.

## Scope and source

- Original work: [MOL-185](https://linear.app/molaison/issue/MOL-185), coordinated with [MOL-184](https://linear.app/molaison/issue/MOL-184).
- [Collaboration contract](https://linear.app/molaison/document/研究任务入口-c46d13ad5e16): workers implement and run available isolated offline regressions; dot owns authorized real validation and consolidated return. No shared-service restart, authentication change or new budget is implied.
- Repository: `Molaison/codex-chatgpt-web`.
- Baseline main, read 2026-10-16: `26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1`.
- Candidate SHA / PR: use the exact head commit identified in the accompanying PR/Linear handoff. At execution, record `git rev-parse HEAD` and require equality with that supplied SHA; do not follow a floating branch or infer the deployment version. The document need not contain its own circular commit hash.
- First patch: provider upstream response-stream reset handling in `deploy/cpr-provider.mjs`, preserving QA byte forwarding and Full model alias rewriting. The reproduced baseline defect is an open downstream response after upstream reset, not a provider-process crash. Process survival is a retained invariant.
- Typed accepted/retry classification and nonstream response-builder adapter EOF handling are independently reproduced and have focused passing fixes. Independent review reported no blockers for the three scoped fixes; real validation remains outstanding.

## Required manifest and entry points

Record actual remote, clean/dirty status, source SHA, bundle digest, Bun/Node/Codex/launcher/browser/helper/OS versions, route and model, configuration digest, pseudonymous account identity, UTC timestamps and run ID. Directory names do not identify the repository. Source requires Bun 1.4.0; provider runtime requires the supported Node version documented in `public-tools-deployment.md`.

Candidate regression commands:

```sh
# Synthetic local TCP adapter; NOT a deployed AF_UNIX verification.
CPR_PROVIDER_TEST_TCP=1 node --test tests/cpr-provider-transport.test.mjs
bun test tests/mol185-submission-retry.test.ts
bun test tests/mol185-json-terminal.test.ts
# Real executor: default provider listener, no TCP opt-in, synthetic upstream.
node --test tests/cpr-provider-transport.test.mjs
```

For baseline reproduction, use the same test files against the pinned baseline implementation in an isolated worktree. Do not reset a shared working tree or overwrite concurrent work. Candidate source snapshot was uncommitted during these evidence captures; the accompanying PR/Linear handoff binds the final SHA, and regression must be rerun after integration.

Provider evidence: [before](mol185-evidence/provider-reset-before.txt), [after](mol185-evidence/provider-reset-after.txt), Node 24.19.0. Baseline 0/2 pass; candidate 2/2 pass. Both QA and Full baseline responses remained open until the 2-second harness deadline; candidate responses aborted, with one upstream request per fault/sibling/subsequent request, healthy sibling and subsequent completion, and provider survival. The final candidate run additionally verifies exact QA created-frame forwarding and selective Full model alias rewriting while nested metadata/literal text remain unchanged. The small single-run timestamps are diagnostic observations, not a latency benchmark.

Typed submission evidence: [before](mol185-evidence/submission-retry-before.txt), [after](mol185-evidence/submission-retry-after.txt). In the matched three-stage subset, baseline 1/3 pass and candidate 3/3 pass (the candidate log also contains two new controls). Exact retries after Send activation or acceptance changed from two browser starts to one; prepared/pre-submit retry remains allowed with zero Send activations. See [count-only comparison](mol185-evidence/comparison.md).

Expanded retry preservation controls: [5/5 pass, 24 assertions](mol185-evidence/submission-retry-expanded-after.txt), including explicit cancellation/authentication errors. Existing bounded-pre-send and error-preservation regressions: [5/5 pass, 28 assertions](mol185-evidence/submission-retry-legacy-after.txt). These are additional controls, not the paired three-case denominator.

Nonstream builder EOF: [baseline 5/9 pass, 4 fail](mol185-evidence/json-terminal-before.txt) versus [candidate 9/9 pass, 18 assertions](mol185-evidence/json-terminal-after.txt), covering empty, heartbeat-only, partial text and compaction adapter EOF plus authoritative done, SSE EOF, explicit failure/incomplete, and max-token controls. Matching baseline used an isolated archive of the pinned baseline plus the final nine-case test; shared files were not reverted. This is missing terminal adapter-event handling, **not malformed JSON byte parsing**.

Integrated application build checks passed: root typecheck, launcher typecheck/build and runtime bundle build; [build log and source hashes](mol185-evidence/final-build.txt). Provider test assertions were subsequently strengthened without changing application code, so that log's provider-test hash predates the final alias assertions. [Final broad-check summary](mol185-evidence/validation-summary.md): 1,096 pass / 97 skip / 102 fail / 1 unhandled error. Failures include 89 socket-environment cases, 3 missing Electron binary cases and 10 reproduced pristine-baseline failures. Aggregate verification stopped at tests; later stages were not reached. The full suite is not green.

Current preparation evidence: official Bun 1.4.0 and frozen root dependencies were installed with lifecycle scripts disabled; root typecheck passed (parent report). Default AF_UNIX provider listener could not run in this sandbox (`EPERM`); the attempted elevated infrastructure failed with a read-only `bwrap` path. No permission changes were made. The passing provider regression uses an explicitly labeled test-only loopback TCP listener adapter while preserving provider lifecycle code; default AF_UNIX mode remains required for the real executor. **AF_UNIX behavior is unverified here.** Do not describe the TCP-adapted harness as exact deployed-socket execution. Broader historical suites encountered socket failures and are not represented as fully green by these focused results.

Existing CPU/mock checks, run with pinned dependencies:

```sh
bun test ./tests/qa-sessions.test.ts ./tests/qa-portable-sessions.test.ts \
  ./tests/qa-response-aliases.test.ts ./tests/qa-pool.test.ts \
  ./tests/server-lifecycle.test.ts ./tests/turn-broker-lifecycle.test.ts
bun run typecheck
```

Do not substitute the full suite for a reproducible provider-reset case. The final package must include an executable local fault harness and the exact regression command before handoff is considered ready.

## Focused validation matrix

| Case | Injection / observation | Required outcome |
| --- | --- | --- |
| P1 QA reset | Local upstream sends headers and a partial body, then destroys its response socket | Caller observes failed/truncated transport, never fabricated completion; provider child stays alive |
| P2 Full reset | Same fault through Full alias rewrite path | Same survival and failure behavior; partial data cannot create a successful terminal event |
| P3 partial-line reset | Cut within an SSE data line or multibyte text through alias transform | No uncaught error or process exit; no invented final text |
| P4 sibling survival | One healthy sibling request overlaps the failed request | Healthy request completes correctly and is not canceled; identity and output remain isolated |
| P5 follow-up health | Send a new healthy request to the same provider child after reset | Same PID serves it; no operator restart needed |
| P6 no replay | Count upstream POSTs per logical request and inspect request identities | Exactly the expected one submission; provider recovery does not replay an ambiguous accepted generation |
| P7 normal QA / Full | Successful SSE and JSON responses; Full model identity fields and nested metadata | QA bytes remain intact; only intended Full model fields rewritten; successful terminal output retained |
| P8 client disconnect | Client closes while upstream streams; inspect test-owned stream cleanup | Provider remains alive; no sibling cancellation; cleanup bounded; do not equate HTTP disconnect with generation cancellation |
| P9 pre-header failure | Upstream connection refused/reset before headers | Clear failure status/body rather than process exit or success |
| C1 typed retry | Reproduce accepted typed error and pre-submission error separately | Retry only when submission is proven safe; no blind replay after acceptance |
| C2 adapter EOF / JSON response builder | End adapter events without an authoritative done event | `incomplete` with `adapter_eof`; no fabricated completed response or replacement compaction history |

The local reset harness is synthetic upstream evidence. A real provider process talking to a mock server is not a live ChatGPT network validation. The real-system canary should exercise the exact candidate binary in an isolated authorized route, observe a genuine healthy generation and client-side transport interruption, and check actual process/sibling survival. Injecting a browser/runtime-to-provider reset requires an isolated test runtime or approved test-only proxy; never reset a shared production runtime to force this case.

### Real executor inputs and ordering

Executable single-request client: [live-canary.mjs](mol185-evidence/live-canary.mjs). This is an opt-in handoff helper, not a replacement production client. It has been syntax-checked, tested to fail closed without authorization, and passed [six mock-only loopback cases](mol185-evidence/live-canary-mock.txt); no live request has been run. Reproduce those checks with `node --test docs/mol185-evidence/live-canary.mock.test.mjs`. They cover complete JSON/SSE, unterminated SSE, conflicting terminal status/output and deliberate disconnect. Before live use, dot must verify the existing isolated endpoint, account/model availability, approved remaining call allowance, Node 24+, exact checkout and independently inspected deployed SHA. The helper's deployment environment variable records that inspection; it does not remotely attest the server version.

Load `MOL185_BASE_URL`, `MOL185_EXISTING_TOKEN` and `MOL185_MODEL` from the existing approved private environment without printing them or putting credentials in command-line arguments. Set `MOL185_EXPECTED_SHA` to the supplied exact PR commit and `MOL185_VERIFIED_DEPLOYED_SHA` to the independently verified deployed commit. Set `MOL185_ROUTE_KIND=qa` (or `full` only for an already approved matching public `-tools` route). After checking authorization, set `MOL185_LIVE_AUTHORIZED=yes` for these invocations. Each command makes exactly one new model submission; there is no retry or setup:

```sh
node docs/mol185-evidence/live-canary.mjs json
node docs/mol185-evidence/live-canary.mjs sse
# Optional separately budgeted observation: deliberately disconnect this test client.
node docs/mol185-evidence/live-canary.mjs sse-disconnect
```

The first two commands require an authoritative completed result and exact inert marker `MOL185 READY`. The third deliberately exits nonzero and reports unknown upstream state; it does not cancel generation or claim recovery. Output contains status/count/timing metadata only, without credentials or response content. Timeout is 120 seconds, body limit 8 MiB, no redirects, no tool requests. Missing prerequisites block before a request. If Full requires a trusted native-client environment, use the already approved native client with the same inert prompt; do not fabricate environment metadata or relax its sandbox to make this helper pass. This canary proves neither real tool side effects nor any of the three injected fault conditions by itself.

1. Check out the supplied exact PR SHA in an isolated worktree; record `git rev-parse HEAD`, `bun --version` and `node --version`. Run the three focused commands above, with the provider command **without** `CPR_PROVIDER_TEST_TCP`. This closes the AF_UNIX environment gap but is still synthetic-upstream testing.
2. Use the existing approved isolated client/route and a model actually listed by that account. Send an inert QA prompt `Reply with exactly: MOL185 QA READY`, with a new test thread/turn/user-message ID. Repeat using nonstream and streaming requests. For Full, use its already authorized `-tools` model and a distinct test thread; no tool invocation is needed to verify transport identity.
3. Input form for the existing Responses client: `model` is the verified route model; `stream` is `true` or `false`; `input` is one user message with a distinct `id` and `input_text`; `client_metadata["x-codex-turn-metadata"]` is a JSON string containing `thread_id` and `turn_id`. Preserve these identities and the entire request for an exact reconnect. A new question must get new turn/message IDs. Do not use real conversation identifiers.
4. For client-stream interruption, close only that test client's read stream after a meaningful event, then reconnect using the exact request identity within the documented replay window. Record whether upstream submission count remains one and whether the result is recovered. This checks client disconnect semantics, not the distinct upstream-reset defect.
5. Exercise the provider-reset fault only through the isolated fault harness or an already authorized test-only upstream proxy. Run one healthy sibling only if separate approved capacity permits it. For typed retry, inject the three `prepared`, `send_activated`, `accepted` failure phases through the committed test harness; a live timeout alone does not prove which phase occurred. For adapter EOF, use the committed empty/heartbeat/partial-text/compaction event fixtures plus terminal controls; do not mislabel raw JSON truncation as that test.

Authenticated client launch and endpoint selection must come from the executor's existing verified configuration; this package intentionally does not invent a production endpoint, key, deployment command or new account setup. If no isolated authenticated route exists, stop after synthetic tests and return that concrete blocker. Do not claim live acceptance from an HTTP or harness result alone.

## Identity and recovery boundaries

Preserve thread, turn and user-message IDs for an exact retry; use new IDs for new questions. Record acceptance state independently of HTTP 200. Current source documents in-memory execution retention of 30 minutes inactivity / 256 entries, process-local same-thread serialization, and explicit uncertainty after an interrupted Send. Durable chat mappings and previous-response aliases are not a durable exactly-once request journal. Do not broaden this patch's claim to cross-restart replay, pagination, dual-client consistency, Steer/Rewind semantics or universal tool-effect idempotency.

## Isolation, budgets and restoration

- GPU: **0 devices; 0 GPU-hours**. No GPU allocation needed.
- Live calls made by this worker/package preparation: **0**.
- Paid budget: **not established here**. New paid spending is not authorized by this document. dot must map any real calls to existing explicit authorization or obtain the missing bounded authorization.
- Proposed focused canary cap for coordination, not approval: at most 8 newly submitted turns across baseline and candidate, concurrency 1 except the two-request sibling case, 30 minutes. Count retries inside the cap. Existing Full routes allow one active turn per account: sibling testing requires separate authorized isolated capacity, not an increased production account limit.
- Local mock tests use generated inert payloads, a test-only key unrelated to any account, private temporary directories and loopback/Unix sockets. They must not load production credentials or modify normal Codex configuration.
- dot uses only already authorized accounts/profiles and verifies that candidate execution is isolated. Do not copy live cookies, create grants/connectors, rebind accounts or start a second runtime against an active production profile.
- Faults stay inside test-owned sockets/processes. No firewall/VPN/security changes, shared production restart, or service repointing. Identify owned PIDs and endpoints before cleanup.
- Stop on missing authority, isolation failure, uncertain candidate identity, exhausted approved budget, unexpected data disclosure, or a proposed production/configuration change. Report the exact blocker.
- Restore by removing test-only faults, settling owned turns, stopping only owned test processes, checking closed sockets and absence of leaked resources, and comparing pre/post production route/configuration digests. Keep sanitized evidence. Never kill processes by broad name matching.

## Evidence and comparison

For each version and case record: run/case IDs, SHA, execution class, versions, config digest, route/model, fault boundary, upstream request count, provider PID and exit status, sibling result, terminal state, first-event/first-output/completion/recovery durations, leaked resources, and evidence references. Use monotonic durations and UTC metadata. Capture sanitized stdout/stderr and protocol traces, not private prompts, cookies, keys, authorization headers, tunnel IDs, chat URLs or hidden reasoning.

Publish a paired baseline/candidate outcome grid plus raw counts (process deaths, failed responses, duplicate submissions, lost sibling results). Plot observed latency samples only when collected; do not fabricate improvements or infer p95 from a tiny canary. Keep raw machine-readable rows, exact scripts and configuration hashes traceable. A small sequence diagram should distinguish upstream acceptance, transport reset, downstream failure and provider survival.

Acceptance requires baseline reproduction, candidate regression pass, normal-path non-regression, independent review, and the agreed real-system results. A PR, HTTP 200, unit pass or synthetic process survival alone does not complete MOL-185. Report each case as static, mock, real, blocked or untested and leave remaining work explicit.

## Important next-stage gaps (not implemented here)

This is stage 1 of MOL-185, not completion of its broader reliability goal. Preserve durable cross-restart event replay, broker completion-ACK-loss idempotency, SSE parsing and clean-FIN semantics, dual-client conflict/state propagation, and real cancel/completion/Steer races as important next-stage investigations. Coordinate semantic conflict and Steer/Rewind ownership with MOL-184; do not invent claims or implement competing contracts. The present bounded in-memory retry fence does not solve durable exactly-once side effects.

## Existing harness caveats

`smoke:cancel` and `smoke:interrupt` use real Codex with synthetic adapters/browser state; they do not prove live browser cancellation. Their current source disables normal approval/sandbox protections, so they are not approved executable substitutes for this handoff. DEV chat uses a real browser but returns explicitly simulated tool receipts. Successful Full tool-side-effect validation requires an independently authorized real client tool and actual isolated receipt.

## Method provenance

Be Ambitious was read as text at `DannyMac180/skills` commit `7dc63b7a748b8bd14bf213c15ecddd4536409407`: [SKILL.md](https://github.com/DannyMac180/skills/blob/7dc63b7a748b8bd14bf213c15ecddd4536409407/be-ambitious/SKILL.md) blob `5241e96d6184c9c89b5336ace06a7535e1bfe4cb`; [MIT LICENSE](https://github.com/DannyMac180/skills/blob/7dc63b7a748b8bd14bf213c15ecddd4536409407/LICENSE) blob `dd2f6a514845e3e79381279478907c154bb623bb`, copyright 2026 Dan McAteer, adapted from Felix Rieseberg. No installer or executable was run; no full-repository audit claimed. Applied method: raw traces and code, reproduce before repair, controlled faults, independent evidence and explicit pass/fail, without expanding scope.

Available skill metadata was checked: no pstack-named skill was listed. A protein/scientific GPU performance skill is unrelated. No pstack execution is claimed.
