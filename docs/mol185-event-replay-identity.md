# MOL-185: retained event replay identity repair

## Reproduced recovery failure

At baseline `51a3bd8`, an otherwise identical Responses request whose user-message JSON
properties were serialized in a different order reused the original browser execution but
selected a different native-round journal. After a client had consumed a prefix and disconnected,
the prefix was already drained into the old journal. The reconnect emitted only the suffix and
still returned `response.completed`.

The offline proof exercises `responseRequest`, request parsing, the real adapter/session registry,
and Responses SSE. Only the browser worker is mocked. It covers a browser still running during
reconnect and a browser that completes while the client is offline. No real model, browser,
credentials, remote service, deployment, or tool side effect is involved.

| Request variant | Baseline recovered text | Candidate recovered text | Mocked browser starts / Sends |
| --- | --- | --- | --- |
| Identical, in flight | Full prefix + suffix | Full prefix + suffix | 1 / 1 |
| Identical, completed offline | Full prefix + suffix | Full prefix + suffix | 1 / 1 |
| Reordered message properties, in flight | Suffix only | Full prefix + suffix | 1 / 1 |
| Reordered message properties, completed offline | Suffix only | Full prefix + suffix | 1 / 1 |

The complete six-test fixture changed from **3 pass / 3 fail** to **6 pass / 0 fail**.
It verifies one completed response, no failed/incomplete terminal, full streamed text and final
response text, plus identity controls. Raw captures: before (`archive:docs/mol185-evidence/event-replay-identity-before.txt`)
and after (`archive:docs/mol185-evidence/event-replay-identity-after.txt`).

A later, single candidate-only timing pass measured reconnect entry through receipt of the complete
replacement SSE body containing its authoritative terminal: identical/in-flight 125.35 ms,
identical/completed-offline 2.83 ms, reordered/in-flight 6.19 ms, and reordered/completed-offline
2.47 ms. All four recovered the full answer with zero extra mocked submissions. Baseline recovery
latency was not measured. These samples are not a latency benchmark or a measured human-intervention
rate. See the timing capture (`archive:docs/mol185-evidence/event-replay-identity-recovery-metrics.txt`).

## Narrow implementation

`chatGptTurnRoundKey` now canonicalizes object property ordering recursively within its input
fingerprint. It does not mutate the request. Array positions, string contents, numeric values,
field names, and native identity remain significant. In particular, JSON-looking strings in
tool output are kept byte-for-byte; they are not parsed or reserialized.

The execution key and instruction-lineage hashing are unchanged. This keeps physical browser
ownership, steering, and supersession outside this patch. The repair selects the already retained
round and replays its prefix before consuming pending deltas. It neither creates a new recovery
endpoint nor submits another prompt.

## Verification

```sh
bun test tests/mol185-event-replay-identity.test.ts
bun test tests/chatgpt-web-harness.test.ts tests/turn-broker-lifecycle.test.ts tests/qa-sessions.test.ts \
  --test-name-pattern 'client disconnect detaches|observer failure in the middle|closed response writer|reconnect preserves offline|overlapping exact reconnect|reconnect aborted during|Responses SSE reconnect|ambiguous submission outcome|terminal .*failure remains replayable|settled replay sessions expire|session cache expiry|targeted tab cancellation|native interruption retires|steering retires|uses stable native turn metadata|exact request retry replays'
bun run typecheck
```

The focused existing-regression capture is here (`archive:docs/mol185-evidence/event-replay-identity-regression.txt`):
18 passed, zero failed, 98 assertions. The root TypeScript check also passed. These are offline
CPU/mock checks, not full-suite or real-system acceptance.

## Explicit boundaries

- The repaired case changes message object property order while preserving the execution identity.
  Reordering properties inside the current instruction's raw content blocks can also change the
  existing execution key. That separate physical-ownership identity limitation is not fixed here.
- Actual new input, changed tool results, reordered history arrays, changed string content,
  model/effort changes, and new native identity are not silently treated as the same round.
- Reconnect is complete-response replay through the existing request path. It is not cursor-based
  delta resumption: the client must treat the replacement response as a replacement, rather than
  append its replayed prefix to the old response. Response IDs and SSE sequence numbers are not
  durable event offsets.
- The registry remains process-local, with nominal 30-minute inactive retention and a 256-entry
  cap. Active browser sessions are not TTL-evicted. A session retains at most 512 round journals;
  an evicted historical round has no durable replay source. This patch does not extend retention
  or guarantee replay after restart, expiration, eviction, or cancellation.
- Provider SSE framing and clean-FIN validation, persistent journals, and cancellation/Steer
  cross-process races remain separate work. No provider retry or new Send policy is introduced.
