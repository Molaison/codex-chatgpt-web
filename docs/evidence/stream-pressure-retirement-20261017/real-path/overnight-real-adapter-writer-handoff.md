# Real adapter writer failure preservation

Base HEAD ee43d5568725a78be0f8d9af8ae053dc07dbd6f0, existing PR13. No commit/push by this author. Scope: src/server.ts plus new tests/server-real-adapter-pressure.test.ts. No edits to index, bridge, queue, retirement, launcher or credentials. No candidate four-scenario probes or real model calls.

Actual-path diagnosis: createChatGptWebAdapter uses a write wrapper that treats emitter exceptions as observer disconnects; withAbort may normalize the error to AbortError. Classification only in the server's outer producer catch therefore loses the original EventQueueOverflowError. The new tests replace only ChatGptBrowserWorker.run, call prepare and lifecycle Send/Submitted markers, then emit10001 text deltas. First output legitimately completes with exactly10001 x characters. An exact same-request cached replay synchronously overflows the queue without a new worker/Send. On the original HEAD replay becomes upstream_server_error / ChatGPT web turn aborted, retryable absent, and JSON HTTP200. Each mode has worker starts1 / simulated Send1 / actual model submissions0. Valid red evidence is overnight-real-adapter-replay-red.log. The earlier pressure-red log incorrectly expected the initial feed to overflow; preserved as diagnostic history, not claimed as a valid replay assertion.

Fix: server.fail is idempotent. The emitter catches its own observer/queue failure and calls fail before rethrowing. The adapter still receives its observer-detachment exception and preserves its browser owner; the outer catch cannot replace the first cause or notify a second error. Closed-queue push retains its existing non-throwing disconnect behavior.

Green: both real adapter modes now first complete normally, then exact replay returns error.code=adapter_event_backlog_exceeded and retryable=false. JSON HTTP502; SSE HTTP200, one response.failed and one DONE. Exactly one error notification per replay. Worker/Send remain1 across both requests and the owner abort signal remains false. Added tests plus existing queue/pressure:13 pass,52 assertions. Evidence overnight-real-adapter-pressure-green.log.

Existing actual-adapter detach regressions pass4/22: a drained text batch failure preserves reconnect data; closed writer keeps accepted browser work; overlap observer takeover; Responses SSE reconnect delivers offline output with no second browser submit. Evidence overnight-real-adapter-detach-regression.log. Typecheck exits0 and diff --check passes. The working tree's separate chatgpt-web-harness.test.ts diff belongs to the root/other author and was not altered here.

Commands:
BUN=<user-home>/.local/lib/codex-chatgpt-web/cpr-native-retry-20261017-qa-1/runtime/runtime/bun
$BUN test tests/server-real-adapter-pressure.test.ts tests/server-event-pressure.test.ts tests/event-queue.test.ts
$BUN test tests/chatgpt-web-harness.test.ts -t 'observer failure in the middle|closed response writer|overlapping exact reconnect|Responses SSE reconnect'
$BUN ./node_modules/typescript/bin/tsc --noEmit

Independent review and Windows/full CI remain root-owned. No guarantee about unrelated native runtime/Windows byte-probe deadline is made.
