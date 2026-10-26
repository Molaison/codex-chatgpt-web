# Durable runtime recovery

When a Responses connection drops, reconnect the **same logical request**. The observer can change;
the browser owner, operation and response-item identities do not. Replay replaces the complete
response snapshot; it is not a new Send or an append-only `Last-Event-ID` interface. A genuinely new
user turn remains new even when its text matches an earlier turn.

## Runtime restart

The runtime checkpoints the intent before Send, submission/acceptance boundaries, published events,
tool receipts and final output in its private runtime directory. Restart has three distinct cases:

- A completed operation replays its durable final with the original response/item IDs.
- A non-final, accepted operation can reconnect a read-only observer only when it has a trusted new
  `observation` checkpoint, the original round exists, the exact reconnect round is unfinished and
  has no unresolved tool-call/error event, and the original execution has not physically settled.
  The checkpoint must still match the operation, native thread/turn, trace, model, account,
  profile/partition, host PID/instance, surface/target, saved-chat claim/URL, submission marker and
  accepted user/assistant identities. The complete Markdown must reproduce the durable prefix.
- Old, missing, mismatched or unknown recovery evidence stays retained. A browser error, missing
  result or similar-looking chat does not authorize another Send, account switch or tool action.

Full recovery also requires `observationRound` for the exact reconnect request. Delivered result
hashes must match every original tool receipt and the native results in that request. The original
local broker must no longer own a live channel. New durable activity evidence must prove no open
MCP claims, and the original binding link must match. Every native call needs an integrity-checked,
completed terminal receipt; `observerLost` without prior reconciliation remains unknown. Supported
proofs are structured native command/poll receipts and the strictly anchored, observed completed
Native text envelope. Running text, unsupported asynchronous/freeform tool lifetimes, missing
old-format activity evidence and open native handles remain retained.

The observer reads growing DOM output and the final answer from the original target. It never
selects a model, navigates, prepares a prompt, sends, approves tools, submits tool results, recreates
a raw capability/binding, calls `owner_complete`, or changes receipt delivery state. Failure to
prove these conditions returns `chatgpt_execution_retained` or `chatgpt_observation_unavailable`
(HTTP 409); non-final status alone no longer implies an unconditional 409. This is not an external
exactly-once execution promise. The precise checkpoint fields, Full proof, Launcher lifecycle and
new isolated systemd contract are in the [read-only recovery handoff](03_read_only_observation_handoff.md).

Keep the original request, thread, runtime directory and native handle. Do not retry with a new
thread, switch account, delete the checkpoint or roll back to a runtime that ignores it. A browser
error after submission is not evidence that Send did not occur. Corrupt, truncated, unwritable or
full storage blocks dispatch rather than treating a missing result as permission to repeat work.

Compaction continuation is a separate, checked lifecycle transition. Its provenance does not grant
permission, clear an ordinary unknown operation or authorize replaying an old user intent.

The private Launcher control adds `observe-ready` and `observe` for checkpoint-backed usage only.
They register/validate the exact original observation lease and renew its existing TTL without
rotating or activating a writer. A helper stdin EOF preserves an accepted tab only after the parent
has durably acknowledged its checkpoint and the host has registered that exact lease. Explicit
shutdown/cancel and legacy callers retain their previous cleanup behavior. An observer never
calls `/turn/end` or releases a different owner. Normal completed writers still release or retain
their target according to the existing policy; no target is retained solely for a test oracle. Steer,
compaction and rewind retain their existing contracts; rewind does not erase ChatGPT history.

## A tool RPC times out

A cancelled or expired MCP RPC is not cancellation of the native turn. The broker retains its
binding and unknown-result fence, including when a native result arrives later. Query the original
invocation receipt; a new request identity must not repeat its side effect merely because the
original RPC did not receive the result. Receipt queries are not remote delivery acknowledgements. The private broker method
`owner_invocation_receipt` requires the original `bindingId`, `invocationId` and exact tool signature.
It returns only the existing receipt and never invokes, reconciles, clears `observerLost`, creates
an invocation, or changes delivery from `unknown`. A different signature fails. A missing invocation
returns `not_found` with `execution_state: unknown`, not proof of non-dispatch. The six public MCP
tool names and schemas are unchanged.

If a native command returned a session handle, an empty `write_stdin` poll of that known handle can
retrieve its progress/result. Explicit MCP waits must be at most 30,000 ms; omitted waits retain
the native default. Unknown handles and nonempty stdin are not reconciliation queries. A long
native task may outlive one RPC: do not start it again. Explicit native cancellation and manual
binding release still retire the turn.

The broker separates logical `invocationId` from socket request IDs and rejects a changed signature
under the same invocation identity. Different user intents are not deduplicated by matching text
or arguments. Existing callers that omit `invocationId` keep their request-ID identity contract.

## Storage and compatibility

- Response checkpoints live in `operations/` beside the role's state file; absent that file, the
  broker socket directory or private runtime directory supplies the location. Broker checkpoints
  use `tool-operations/` beside its socket/private runtime. These files contain private conversation
  and tool data: do not publish them as diagnostics or copy them into another account's runtime.
- One existing role runtime owns the store. Do not run old and new writers against it or copy an
  old snapshot over newly accepted data. Cross-host fencing remains the deployment owner's duty.
- Checkpoints are bounded to 16 MiB each and 4,096 files per store. Capacity exhaustion blocks new
  dispatch. Unresolved records are not silently evicted by the in-memory TTL. Preserve them and
  have the owner reconcile before arranging capacity maintenance.
- Events are durable before observer publication, with batched updates after the first delta.
  Process-crash/restart fixtures cover this boundary; they do not establish host-power-loss safety
  or external exactly-once execution.
- A new durable parent requires a helper advertising `send-activation-ack` before prompting or
  sending. An old helper without it fails before Send. An old parent can still use the new helper,
  but that compatibility does not make the old parent a safe recovery target for a new store.

## Diagnostics are evidence, not authority

`/healthz` includes six readiness levels, L0–L5: process, route, provider, browser session, authenticated
turn and tools. A responding process proves only L0. Missing observations remain `unknown`; local
MCP initialize/catalog/reply observations do not prove hosted discovery, polling or delivery ACK.
Real-turn acceptance must be dated and bound to the actual candidate.

The CPR provider accepts an optional `releaseManifestPath` in its trusted local configuration. Its
release record can supply `release_id`, `route_name`, `cpr_version`, `build_sha`, `provider_name`,
`account_pool` and `runtime_path`. Missing/unreadable evidence stays unknown; it is not a new
prerequisite for existing use. Request headers are correlation claims, never permission or proof
of a backend build. Public diagnostics use bounded references instead of raw private identifiers.

Keep original error codes and submission evidence. HTTP 503 alone does not prove that no provider
exists or that nothing was dispatched; EOF/520 after forwarding is likewise ambiguous. This
candidate adds no automatic route/account fallback or resend in response to those failures.

## Provider notices are not model content

`response.provider_notice` is an independent SSE event with payload `{type, notice}`. Notice IDs are
stable, opaque ASCII identifiers; `execution_id` is a digest, and `seq` increases within the execution.
The private operation stores at most 32 notices outside `rounds`. Notices are excluded from assistant
text, thinking, response output and accepted model history. Reconnect can replay the same notice IDs.

Only observed account pinning, restored conversations, observer detachment, reconnect/resume,
actual tool waiting and unresolved-state fences emit notices in this candidate. Account changes and
forks are not inferred. Messages are fixed, single-line Chinese templates below 512 UTF-8 bytes;
no raw errors, URLs, account secrets or tool output are interpolated. A notice never authorizes
switching accounts, forking, retrying or dispatching. Older clients can ignore the event.

## Verification boundary

`tests/42_observation_recovery.test.ts` exercises the production observer/control/Markdown path
against synthetic ChatGPT DOM in real local Chromium, plus helper EOF protocol subprocesses.
`tests/42_full_observation.test.ts` exercises actual local broker receipts and a seeded Full adapter
checkpoint, with synthetic browser output. These are risk contracts, not authenticated ChatGPT,
Codex CLI or desktop end-to-end acceptance. The deployment owner must bind a fresh real scenario
to this candidate and compare the original target DOM, single user/assistant identities, complete
answer and native receipts across the actual failure. No new remote intent was sent by this owner.
