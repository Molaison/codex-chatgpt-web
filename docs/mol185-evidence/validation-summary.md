# Integrated offline validation

Historical raw output is supplied in the [companion evidence archive](../evidence/mol184185-archive.md). This document retains its original tested-version scope. See [current CPR identity behavior](../mol189-cpr-identity.md).

Environment: Bun 1.4.0; Node 24.19.0; isolated HOME/CODEX_HOME; live browser opt-ins unset; dependency lifecycle scripts disabled. No live model calls or GPU work. Application sources were the three-fix candidate before publication; the final PR head binds the exact delivery commit.

| Check | Result |
| --- | --- |
| Root typecheck | Passed |
| Launcher typecheck and build | Passed |
| Runtime bundle build | Passed |
| Root dependency audit | 108 packages, no vulnerabilities reported |
| Launcher dependency audit | 308 packages, no vulnerabilities reported |
| Full test run | 1,096 pass; 97 skip; 102 fail; 1 unhandled error; 1,295 tests across 106 files |
| Aggregate verify | Failed at test stage with the same counts; version checks, audits and root typecheck passed first; later aggregate stages were not reached |

Full-suite failure classification, not a waiver:

[Complete failed-test name index and error contexts](full-suite-failure-index.txt) is included so the next executor does not need an ephemeral workspace to identify the failed coverage.

- 89 Unix-socket environment failures.
- 3 missing Electron binary failures, with installation scripts intentionally disabled.
- 10 reproduced on pristine baseline: 5 effort-menu mock failures (`page.evaluate` absent), 3 prediction assertions, and 2 external HTTP harness trusted-network fixture failures.
- One unhandled broker `ECONNREFUSED` after socket setup failure.

Pristine-subset evidence: 8 failures across effort/prediction (`archive:docs/mol185-evidence/pristine-existing-failures.txt`) and 2 trusted-environment fixture failures (`archive:docs/mol185-evidence/pristine-http-harness.txt`). These do not prove every full-suite failure is unrelated to the patch; supported-environment reruns remain required. The full suite is **not green**.

Build evidence: final-build.txt (`archive:docs/mol185-evidence/final-build.txt`). Its application hashes remain applicable. Provider test assertions were strengthened later and rerun 2/2 successfully; final test SHA-256 is `b4f6780ec6a08a95577e6ae4cf4f6f093c2af02925f1f37044d716594703f3f2`, superseding that test's older hash in the build log. Final provider evidence (`archive:docs/mol185-evidence/provider-reset-after.txt`) additionally checks QA byte preservation and selective Full alias rewriting.

Full raw logs were retained by the execution worker instead of duplicating roughly 740 KB in this evidence directory. Their hashes and filenames are recorded below so retrieval can be verified; the accompanying handoff should preserve their artifact location:

- `final-full-tests.log`: SHA-256 `6e44c4435a633df3e6f38ee5cc75aabe19878a80c1f196cfac0bacd38a25b0af`.
- `final-verify.log`: SHA-256 `5461078009e76ddebf5fed23072e02121a2dc40e5ee10294468cbef34b2f41b6`.

The [focused paired matrix](comparison.md) and [real-execution package](../mol185-network-validation.md) separate synthetic regression success from live acceptance. The included live-client script was syntax-checked, its missing-authorization fail-closed path tested, and six mock-only loopback parser/client cases (`archive:docs/mol185-evidence/live-canary-mock.txt`) passed. It has made **zero live requests**.

## Stage-one CI follow-up (2026-10-16)

Candidate [`51a3bd8`](https://github.com/Molaison/codex-chatgpt-web/actions/runs/38928747390) reached a failed terminal state: Ubuntu 1,188 pass / 97 skip / 10 fail; macOS 1,189 / 96 / 10; Windows 1,178 / 106 / 11. The submission and JSON-terminal regressions passed on all three platforms. Provider disconnect cases passed on Linux/macOS through the default Unix entry point; Windows explicitly skips those cases. Packaging/smoke stages were not reached after verify failed.

Later inspection of the pristine [`26bd5a9` baseline run](https://github.com/Molaison/codex-chatgpt-web/actions/runs/38925334283) established that its Windows job 117055299266 and candidate job 117066965836 have the same 11 failing test names. In particular, `paper-recovery.test.ts`'s “unverified native evidence leaves the actual SQLite row and event log unchanged” timed out in both (baseline 8,220.95 ms; candidate 11,965.83 ms; limit 5,000 ms). This corrects the earlier lack of a Windows baseline reproduction; it does **not** establish the timeout's underlying cause or make CI green. No rerun, timeout increase, or skipped check was used to obtain this classification. CI remains distinct from real deployed-system acceptance.

## Stage-two integrated candidate

The [safe-recovery report](../mol185-safe-recovery.md) defines the actual paired recovery cohort and remaining boundaries. An independent single Bun invocation ran all three new stage-two files together with the stage-one submission/JSON-terminal files: **38 pass, 0 fail, 176 assertions** (raw result (`archive:docs/mol185-evidence/stage2-combined-independent.txt`)). Focused existing controls also passed: replay/session 18, browser observer 6, browser/compaction adjacent 19 with 2 real-browser skips, and feasible broker lifecycle 7. These subsets are not a new full-suite result. Root TypeScript passed after the production changes ([log](stage2-typecheck.txt)); source review found no remaining blocker after correcting a negative-ACK/withheld-FIN classification issue.

The first runtime build failed while packaging a generated dependency-cache directory symlink (failure (`archive:docs/mol185-evidence/stage2-runtime-build.txt`)). Repeating with the existing writable external Bun cache and an isolated output succeeded (command/result (`archive:docs/mol185-evidence/stage2-runtime-build-isolated.txt`)); no source/build-script changes or disabled checks were used. Launcher source was unchanged; its earlier build is historical evidence, not a fresh stage-two run.

The known socket/Electron-blocked full suite was not repeated locally. Final-commit CI status must be read from the accompanying PR/Linear update; the older CI above is not the new commit's result. No live browser, model, deployed endpoint, remote host or GPU validation has occurred. Neither stage is accepted as Done.
