# ywl source branches

Source checkpoint: 2026-10-17. Both maintained variants include upstream
[`8645a89e6a5fbe011e1bfbb0821a386ca7477ad5`](https://github.com/miuuyy/codex-chatgpt-web/commit/8645a89e6a5fbe011e1bfbb0821a386ca7477ad5)
(version 6.1.10).

- [`main`](https://github.com/Molaison/codex-chatgpt-web/tree/main) and
  [`ywl/qa-gpt6`](https://github.com/Molaison/codex-chatgpt-web/tree/ywl/qa-gpt6):
  QA, persistent account pools, Papers/PDF recovery, structured charts, composer
  availability classification, and HTTP-observer recovery. Includes the existing
  extended-chart candidate; source availability is not evidence of production rollout.
- [`ywl/full-gpt6`](https://github.com/Molaison/codex-chatgpt-web/tree/ywl/full-gpt6):
  Full tools, native permission/Memory envelopes, authenticated history continuation,
  pre-Send history refresh, physical Send receipts, and HTTP-observer recovery.
  Upstream broker-token verification is retained alongside the local receipt path.

These variants are intentionally separate; do not replace one runtime with the other
merely because both report 6.1.10. The source checkpoint does not deploy services,
change model catalogs or credentials, or publish new binary releases. Upstream
installers do not contain these customizations. Production changes require their own
approved, draining release and recovery owner.

Local verification uses Bun 1.3.14 and Node 22.20.0. The package's upstream-declared
Bun version remains unchanged. For isolated environment fixtures, unset an inherited
`CODEX_SQLITE_HOME` so they use their own temporary databases, not the operator's
real Codex state. Browser fixture tests use `CHATGPT_DOM_TEST_BROWSER` and require
no login or model requests.
