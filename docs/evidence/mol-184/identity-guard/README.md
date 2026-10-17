# Bounded missing-instruction-ID guard evidence

Historical raw output is supplied in the [companion evidence archive](../../mol184185-archive.md). This document retains its original tested-version scope. See [current CPR identity behavior](../../../mol189-cpr-identity.md).

## Scope and reproduction

Base PR6: `4548a557ba9b4cb71fb513806fb96bfbbc05d566`, tree `24868e79eb4348e87e97ccb7a323d20a3270f3bc`. This packet is offline deterministic evidence, with actual pool/SQLite and mocked execution boundaries. It authorizes no deployment or live browser/model use.

Minimal distinguishing request sequence through direct pool ingress:

1. Submit one user message with text `SAME`, no item `id`, temporary mode, fixed native thread and turn, and native `request_id: request-one`. Save its completed response ID.
2. Submit the same one-message input with the same thread and turn, `request_id: request-two`, and `previous_response_id` set to step 1's response ID.
3. Pre-guard observation: HTTP 200, two adapter invocations but only one mocked worker start; both adapter calls have the same execution key. Guard expectation: explicit 409 before the second forward, leaving saved history/receipt untouched.
4. Controls: exact retry of step 1 remains replayable, including restart/old-head replay; caller IDs `instruction-one` then `instruction-two` yield two executions. Changed text or a new turn must pass. Tool rounds must preserve the original instruction ID rather than replace it with a request ID.

The regression test shipped with the guard is the executable minimal reproducer; avoid copying production source or large historical diagnostic logs into this packet. Apply the identical new regression bytes to an isolated checkout of the base for red/green comparison. Never switch or overlay a shared working tree while another task uses it.

## Historical boundary observations

The original eight-case cross-layer identity probe on the base reports **6 pass / 2 fail**: missing caller IDs through CPR fail exact old-head replay; an identical new direct-pool delta silently reuses the prior execution. Its separate tool-round probe reports **3 pass / 1 fail**, exposing CPR-generated instruction-ID churn. Neither result is a new-guard acceptance result.

Independent pre-guard validation covered exact PR6 and a six-file PR7 composite, both using PR6 as base. PR7 overlay commit: `f1fde6f726112fff41a256ef4688712e7858293e`; files: `deploy/cpr-provider.mjs`, `src/adapters/chatgpt-web/browser-worker.ts`, `src/adapters/chatgpt-web/index.ts`, `src/adapters/chatgpt-web/turn-broker.ts`, `src/adapters/chatgpt-web/turn-execution.ts`, `src/bridge.ts`. Both passed the eight applicable admission cases, six negative-proof controls, 65 focused tests, typecheck and storage/compaction/rollback probes. Their unchanged original eleven-case diagnostic retained three missing-ID failures. Typecheck excludes only archived diagnostic copies added for the probe, not canonical repository code. These composite results are not a merge, full-suite acceptance or evidence for a later patch.

## Final guard verification

Author verification on the frozen source/test hashes in `manifest.json`: **89 pass / 0 fail / 907 assertions** across five pool suites; root typecheck exit 0. The identical four new reject/replay tests against the base pool produce **0 pass / 4 fail / 8 assertions**, each expecting 409 and receiving 200. The initial red attempt had two ephemeral-runtime-path configuration errors; the final red used a durable isolated workspace, without changing the guard assertions.

Coverage includes JSON/SSE, string/array input, retained receipt replay after restart, no new reservation or history mutation, stable-ID recovery, same/changed attachments, changed content/new turn, compaction, full-history/tool/multiple-input exclusions, and promotion without bypass. Browser-only/full Responses handlers use a mocked adapter; the two direct-pool JSON/SSE cases use the real adapter with mocked browser-worker execution.

An additional broader lifecycle invocation reported **128 pass / 2 fail / 1 error** due to Unix broker/socket restrictions. It is not a passing aggregate run. Independent frozen-guard review passes within this bounded offline scope. Both exact PR6 + guard and the six-file PR7 composite + guard independently pass **89 tests / 907 assertions** and typecheck. Both retain **8 pass / 3 known missing-ID failures / 77 assertions** in the unchanged original eleven-case diagnostic; six negative-proof controls, two delta-Steer controls, three terminal/history/new-turn controls and storage/compaction/rollback probes pass. Canonical repository sources/tests/scripts are typechecked; only copied nontracked diagnostic/probe files are excluded. A fresh independent base archive plus the frozen tests reproduces **4 failures / 8 assertions**, each expecting 409 and receiving 200. Source comparison finds no unexpected changes in either isolated candidate. New-head CI has not been published or verified by this record.

Reproduce from a verified checkout with Bun 1.4.0:

```sh
bun test tests/qa-pool-request-receipts.test.ts tests/qa-pool-admission-observer.test.ts tests/qa-pool-history-expiry.test.ts tests/qa-pool-observer-cleanup.test.ts tests/qa-pool.test.ts
bun node_modules/typescript/bin/tsc --noEmit
```

For the isolated red comparison use the same two changed test files and the base pool source, then run:

```sh
bun test tests/qa-pool-request-receipts.test.ts tests/qa-pool-admission-observer.test.ts -t 'ambiguous generated instruction|direct pool rejects ambiguous'
```

`manifest.json` binds the source/tests, compact observations, commands and log hashes. The manifest remains in Git; the corresponding raw output is preserved in the companion archive: independent red comparison (`archive:docs/evidence/mol-184/identity-guard/guard-red.log`), independent exact-PR6 focused run (`archive:docs/evidence/mol-184/identity-guard/guard-pr6-focused.log`), independent typecheck output (`archive:docs/evidence/mol-184/identity-guard/guard-pr6-typecheck.log`) (empty output, exit 0 recorded in provenance), and [frozen independent provenance](./guard-independent-summary.json). Other runs remain separately hashed provenance; no full-log bundle is duplicated. Full author logs are local artifacts under `/tmp/mol184-guard-evidence`; independent guard and pre-guard artifacts are under `/tmp/mol184-oct17-independent` (guard runs have the `guard-` prefix). These paths are provenance, not public download links. The committed regression source and commands are the portable reproducer. The published commit/tree must be bound externally after commit; this packet cannot embed its own future commit hash.
