# Admission and observer evidence

These are offline PR6 runs, distinct from the coordinator's historical PR7+PR6 composite. See `manifest.json` for exact versions, commands, exit codes and SHA-256 hashes. Source/test hashes identify the tested content; the publication record must bind the eventual commit/tree and CI separately.

## Reproduce without altering a working branch

Use two isolated **durable-path** checkouts outside temporary directories; the existing runtime configuration rejects ephemeral process paths. Materialize baseline commit `c841db47716d87ad6776bf2afcd074e267f50e7c` with `git archive`. Materialize the reviewed candidate into a separate checkout and verify the manifest source hashes. The recorded candidate production differs from baseline only in `src/qa-pool.ts` and `src/server.ts`; CPR and the receipt helper stay unchanged. Reuse verified compatible dependencies read-only or provision dependencies under the executor's normal authorized workflow. Recorded runtime is Bun 1.4.0; no new dependencies were installed.

Copy each archived `dot-*.ts.txt` file to `tests/` in the isolated checkouts, removing only the final `.txt` suffix. Preserve the original eleven-case test bytes; SHA-256 must be `e5d3070a8a367e93a00d06a6157af64933ce132e61ed35a72f17b1951f0b61f9`. The two risk/capacity scripts contain a baseline import pointing to `/workspace/shared/mol184-admission-baseline/src/qa-pool`. If using a different durable baseline location, change only that import and record the adapted source hash. Their `baseline` and `old-binary` labels refer to pre-delta PR6, not an earlier pre-receipt implementation.

Before running either risk/capacity script, run `mkdir -p evidence` from the root of each isolated checkout. Those scripts write fixed `evidence/*.json` paths relative to their source location and do not use `DOT_EVIDENCE_PATH`; a clean archive does not contain that output directory. Do not modify their archived source bytes.

Run the manifest commands from the specified baseline, after/candidate or repository checkout using the recorded Bun version. Set `DOT_EVIDENCE_PATH` to a new writable absolute JSON output path for diagnostic tests if separate structured observations are desired; the archived logs already contain those observations. Capture output and exit status. Full original eleven is expected to exit 1 with three missing-ID failures, not to be green. The anchored eight-case selector is deliberately narrower. Do not change expectations or hide full diagnostic failures in ordinary-suite claims.

The two normal regression files are checked into `tests/`, so their source is not duplicated here. Diagnostic `.txt` files are intentionally excluded from automatic discovery. The risk and capacity outputs confirm their assertions, but do not establish real browser behavior or storage guarantees beyond the stated boundaries.

## Failed attempts and coverage limits

- `baseline-ephemeral-path-failure.log`: rejected by the existing durable-runtime-path check before behavior assertions. The fixture was moved to a durable workspace; no configuration check was disabled.
- `repo-focused.log`: 103 pass, 2 fail and 1 error; broker Unix-socket listen failures. It is not a green full suite. No restriction bypass was used. The passing focused pool suite and single model-catalog drain target do not erase these failures.
- Full eleven: three unchanged missing-ID failures. Supplied-ID observer recovery and exact pre-admission proof are the bounded changes.
- Real browser/model, installed-client wire traffic, full successful suite, new published-head CI and deployment are not established. Historical review acceptance of the coordinator composite is not approval of this PR6 snapshot.

The tests use synthetic data and deterministic browser workers. Worker starts are not measured real ChatGPT Sends. The configured runtime's exact rejection contract is trusted, not cryptographic; generic 503 and ambiguous accepted failures remain blocked.
