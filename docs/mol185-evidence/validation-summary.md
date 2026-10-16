# Integrated offline validation

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

Pristine-subset evidence: [8 failures across effort/prediction](pristine-existing-failures.txt) and [2 trusted-environment fixture failures](pristine-http-harness.txt). These do not prove every full-suite failure is unrelated to the patch; supported-environment reruns remain required. The full suite is **not green**.

Build evidence: [final-build.txt](final-build.txt). Its application hashes remain applicable. Provider test assertions were strengthened later and rerun 2/2 successfully; final test SHA-256 is `b4f6780ec6a08a95577e6ae4cf4f6f093c2af02925f1f37044d716594703f3f2`, superseding that test's older hash in the build log. [Final provider evidence](provider-reset-after.txt) additionally checks QA byte preservation and selective Full alias rewriting.

Full raw logs were retained by the execution worker instead of duplicating roughly 740 KB in this evidence directory. Their hashes and filenames are recorded below so retrieval can be verified; the accompanying handoff should preserve their artifact location:

- `final-full-tests.log`: SHA-256 `6e44c4435a633df3e6f38ee5cc75aabe19878a80c1f196cfac0bacd38a25b0af`.
- `final-verify.log`: SHA-256 `5461078009e76ddebf5fed23072e02121a2dc40e5ee10294468cbef34b2f41b6`.

The [focused paired matrix](comparison.md) and [real-execution package](../mol185-network-validation.md) separate synthetic regression success from live acceptance. The included live-client script was syntax-checked, its missing-authorization fail-closed path tested, and [six mock-only loopback parser/client cases](live-canary-mock.txt) passed. It has made **zero live requests**.
