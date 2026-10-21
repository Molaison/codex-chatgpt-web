# Independent smoke guard replay

## Revision and conclusion

Reviewed `codex-chatgpt-web` commit `93ba34b61e5163f398aeaa010788621cb4a559d5`, based on `c2fbdb062472ed88682e9366ba7ad8d1fc67fbc4`. The final review found no remaining blocking defect in the pinned non-Pro smoke request guard or the revised lifecycle acceptance checks. Product files were not modified by the reviewer.

The independent replay uses the actual `createWebSubagentSmokeGuard` and the actual production `responseRequest`, including its parser and model route. Only the final adapter is synthetic. It disables real `fetch` before importing production modules and only dispatches its synthetic endpoint in process; it opens no sockets and never calls the original network implementation.

## Reproduce

Install the selected repository checkout's normal dependencies, then run with Bun:

```bash
SMOKE_AUDIT_UPSTREAM_ROOT=/absolute/path/to/codex-chatgpt-web \
  bun smoke-guard-replay.ts > smoke-guard-replay-result.json
```

The environment variable is required. The replay records the actual Git HEAD, SHA-256 of six relevant production source files, and runtime/platform. It creates and removes a temporary runtime state directory. The saved result was produced with Bun 1.4.0 on Linux x64 at the reviewed commit.

## Independent behavior evidence

| Check | Result |
| --- | --- |
| Allowed request variations | 20 passed: Medium and High across ten bodies containing baseline input or conflicting internal flags, family, modelId, options, reasoning_effort, nested raw-body fields, service tier, and metadata. All also carried conflicting HTTP turn metadata. |
| Production adapter observation | All 20 resolved to backend `gpt-5.6-sol`, family `5.6`, no Pro flag, and the explicitly requested Medium or High effort. |
| Denied requests | 10 denied before production handler dispatch: Pro, legacy/native/family aliases, trailing model whitespace, missing effort, Max, Ultra, and body composer-prediction metadata. |
| Continuation boundary | An unknown `previous_response_id` reached the actual handler and returned HTTP 409 without an adapter invocation. |
| Total actual handler dispatches | 21, with 20 synthetic adapter invocations. |
| Real network / model / browser Send / PDF upload | Zero. |

The reviewer also independently ran `bun test tests/live-web-smoke-guard.test.ts` at the fixed commit: **23 passed, 0 failed, 160 assertions**. This exercised the actual smoke CLI with a fake Codex executable, loopback-only cancellation and redirect tests, startup failure, timeout, policy rejection followed by forged success rollouts, and lifecycle rejection cases. `git diff --check` passed and the worktree was clean.

## Review findings incorporated in the fixed commit

1. Missing child completion could previously satisfy the smoke's weak success checks. The script now requires completed parent and child records with their own acceptance markers and repository version, and verifies the child's parent thread.
2. A terminal-looking output from an unrelated call could previously satisfy the wait check. The script now binds the exact child ID, `wait_agent` targets, matching call ID, and that child's completed result, with `timed_out=false`.
3. A sticky policy failure previously prevented a final success verdict while still allowing later model dispatch. The guard now rejects later dispatch, including a previously started request whose body read completes after the violation. Temporary HTTP 503 responses retain the same-model retry behavior and do not change the pinned model.

## V1 protocol source verification

The protocol fields were independently checked against official OpenAI Codex source pinned to `d571eaf1f61d0d93a797506335a99a9950ffe37b`; they were not inferred from the fake CLI fixture:

- [V1 wait implementation](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/core/src/tools/handlers/multi_agents/wait.rs): request uses `targets`; the result uses `status` and `timed_out`. The result key is the agent path if present, otherwise its thread ID.
- [V1 spawn implementation](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs): V1 supplies no task name and returns its thread ID as `agent_id`.
- [Protocol serialization](https://github.com/openai/codex/blob/d571eaf1f61d0d93a797506335a99a9950ffe37b/codex-rs/protocol/src/protocol.rs): `AgentStatus` serializes its variants in snake case; completed status carries the optional final assistant message.

## Evidence limits

No installed real Codex executable was found in the review environment. The CLI evidence therefore verifies the real smoke script with controlled fake Codex processes, not a real Codex/browser task. The 12 executable-fixture tests are explicitly skipped on Windows; the other 11 guard behavior tests remain available there. This review did not execute a Windows or macOS runtime. Actual browser and native-Codex live acceptance remains separate from these code and protocol checks.
