# CPR identity across retries

CPR preserves a missing user-item `id` when the request already supplies `x-codex-turn-metadata`, in either client metadata or headers. It does not substitute an HTTP transport request number for the caller's instruction identity. The QA pool remains responsible for normalizing and reconciling that request.

A supported logical retry retains its native thread/session identity, turn identity (or native request ID when used as the turn), original request ID, input and caller item IDs. Changing only an HTTP `x-request-id` must not cause another submission or a receipt conflict. Completed receipts and in-flight observer recovery take precedence over the ambiguity guard.

A new request ID in the same turn does not prove that identical user text is a new instruction. If the caller omits the user-item ID and sends an ambiguous one-message delta against retained temporary history, the pool returns `409 instruction_identity_required` before a new reservation or backend forward. For an intentional new instruction, supply a distinct user-item ID and preserve it on retries. Carried history, tool rounds and steering must retain existing IDs. No text hash is used to guess new-instruction intent.

Requests without native turn metadata remain independent one-offs, even if they share a session header. Partial native metadata without a stable thread/session identity also cannot establish safe replay; it retains the existing independent-request behavior. Do not treat a matching text, request number or partial metadata alone as a retry guarantee. Callers needing recovery must supply and retain the complete logical identity and reconcile uncertain accepted work before starting a new instruction.

## Reproduce

Run `bun test tests/qa-pool-admission-observer.test.ts tests/qa-pool-request-receipts.test.ts`. These are offline tests of actual CPR normalization, pool routing, SQLite and Responses handling with browser work replaced; they do not prove live model behavior. The admission suite includes missing-ID disconnects before/after headers, supplied-ID controls, draining recovery, accepted-error refusal, ambiguity rejection through both CPR and direct pool ingress, tool rounds and steering identity.

The original eleven-case diagnostic remains unchanged at `docs/evidence/mol-184/admission/dot-cpr-admission.test.ts.txt`, SHA-256 `e5d3070a8a367e93a00d06a6157af64933ce132e61ed35a72f17b1951f0b61f9`. Copy it unchanged to `tests/` only in an isolated checkout to rerun it, then remove that temporary copy. Use a short, durable, task-owned `TMPDIR`: long paths can exceed Unix socket limits, while ephemeral runtime paths are intentionally rejected. Historical failures and original log hashes are preserved in the [companion archive](evidence/mol184185-archive.md).

The final commit, installed-client real-browser result, model submission ledger and CI result must be bound externally after review. This document does not assert that those later checks passed.
