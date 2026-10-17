# MOL-185: safe recovery, stage 2

## Scope and status

This stage repairs three reproduced recovery failures under [MOL-185](https://linear.app/molaison/issue/MOL-185), retaining PR #7’s post-Send replay fence and authoritative completion checks. Shared identity, history, branch and Steer contracts remain with [MOL-184](https://linear.app/molaison/issue/MOL-184).

Baseline: `51a3bd8ccee32c82f7a964c60351d10958478ce8`. Branch: `bop/MOL-185-network-recovery`; [draft PR #7](https://github.com/Molaison/codex-chatgpt-web/pull/7). The exact integrated commit is supplied by the accompanying Linear/PR delivery; execution must require `git rev-parse HEAD` to equal that SHA. Focused offline results below are not real acceptance, full-suite success or permission to deploy. Real browser/model/remote executions and GPU usage: **0**.

Existing automatic QA/Full reconnect already retains the browser owner, journals events before client writes and replays an exact request. Stage 2 repairs specific paths into those mechanisms; it adds neither a general result-retrieval endpoint nor a server query/backoff scheduler.

## Selected fixes and evidence

### 1. Preserve the original round journal

Reordering user-message JSON properties could retain the same execution but select another round journal. After disconnect, the consumed prefix was lost while the reconnect still emitted completed. Canonical object-key ordering in the round fingerprint restores prefix-plus-suffix replay. Arrays, strings and values remain significant; input is not mutated.

Execution-key and instruction-lineage hashing are unchanged. Reordering raw instruction-content properties can still change execution identity; this coordinated semantic issue is not fixed. Replay remains whole-response replacement, not cursor-based appending.

[Fixture](../tests/mol185-event-replay-identity.test.ts), [before](mol185-evidence/event-replay-identity-before.txt), [after](mol185-evidence/event-replay-identity-after.txt), [scope and command](mol185-event-replay-identity.md).

### 2. Recover an unreadable accepted response

A response-snapshot timeout was swallowed as absence. When the bound locator still existed, normal reconciliation never triggered transport recovery. The patch distinguishes timeout from genuine absence, verifies unique binding, invokes existing bounded same-page rebind, preserves emitted text and invalidates stale completion-fence evidence.

A fake leased transport exercises the real accepted-response observation, Markdown and completion loop. Cancellation and ambiguous identity stop; missing nodes use existing reconciliation. There are at most two rebinds. This does not recover an unrelated page or guarantee arbitrary CDP/network recovery.

[Fixture](../tests/mol185-response-observation-recovery.test.ts), [before](mol185-evidence/stage2-observation-before.txt), [after](mol185-evidence/stage2-observation-after.txt), [adjacent controls](mol185-evidence/stage2-observation-controls.txt).

### 3. Recover an accepted tool-result ACK

The broker could accept a tool result, lose its ACK, then reject the same completion as no longer pending. The remote owner also accepted malformed `{completed:false}` responses. The candidate retains bounded content-free result digests on the active channel, accepts an exact matching completion, rejects conflicting results, validates positive ACKs and permits one bounded replay only after transport ambiguity and advertised peer support.

This replays a completion receipt, not the tool invocation. Revocation, committed completion, receipt eviction and process loss still win. Retirement between original acceptance and ACK retry remains unresolved. Receipts are capped at 1,024 per active channel; transport waits are bounded by 5 seconds each for initial ACK, capability check and replay.

[Fixture](../tests/mol185-tool-ack-recovery.test.ts), [before](mol185-evidence/stage2-tool-ack-before.txt), [after](mol185-evidence/stage2-tool-ack-after.txt), [lifecycle controls](mol185-evidence/stage2-broker-lifecycle-focused.txt).

## Measured cohort, not a broad recovery percentage

The fixed **paired browser cohort** is four SSE reconnect scenes plus one accepted-response read scene: **2/5 → 5/5 recovered**. Controls and the 22 inventory rows below are not denominator entries. The dropped-ACK result is reported separately because its candidate fixture added snapshot-mutation assertions. Do not combine differently sized test suites into a recovery rate.

| Paired scene | Baseline → candidate outcome | Candidate recovery segment, ms | Mock physical-work counts, both versions |
| --- | --- | --- | --- |
| Identical request, in flight | Full → full | 125.35 | Browser starts/Sends 1/1 |
| Identical, completed offline | Full → full | 2.83 | Starts/Sends 1/1 |
| Reordered properties, in flight | Suffix only → full | 6.19 | Starts/Sends 1/1 |
| Reordered, completed offline | Suffix only → full | 2.47 | Starts/Sends 1/1 |
| Accepted response unreadable | Fixture stop → full retained answer | 2025 | Send/accepted 1/1; rebinds 0 → 1 |

SSE timing runs from reconnect start through authoritative terminal-body receipt ([capture](mol185-evidence/event-replay-identity-recovery-metrics.txt)); observation timing runs from injected read fault to final answer, with rebind at 3 ms. Baseline successful-recovery segment timing was not captured. These are single CPU/mock observations with different start boundaries, not a combined latency distribution or speedup claim. All five candidate scenes need zero extra mocked Sends and complete without fixture human remediation. Real intervention frequency remains unmeasured.

The observation baseline ends at a deterministic four-read sentinel: 1933 ms whole test, 758 ms from fault to sentinel. Candidate whole test is 3188 ms. Its permanent-stall control now stops after two rebinds/three failed reads, not a recovery success. Cancel, ambiguous-binding and missing-node controls pass both versions. A candidate-only unresolved-evaluate watchdog case completes in 4017 ms after fault, rebinding at 2003 ms; it is excluded from the paired denominator.

Dropped-ACK recovery changed from owner failure after accepted result to success. The candidate records **983.84 ms** from completion call to resolved ACK, **one simulated invocation, one accepted-result resolution, two ACK attempts and one serialization**. No browser/Send or real tool-effect metric exists in this broker fixture. Baseline segment timing is unknown. Malformed negative ACK now rejects rather than silently succeeding.

Test totals are separate evidence: round fixture 3/6 → 6/6; matched observation cases 3/5 → 5/5, plus one candidate-only watchdog pass; broker original 2/6, final expanded fixture 12/12. The latter is not a paired twelve-case improvement claim.

For final real reporting, record each scene’s recovered, recovered-after-user, known-running, safe-stop, unsafe or blocked outcome. Report required human actions and reasons, original Send/accepted counts, tool effects, query/rebind counts, disruption-to-valid-output and disruption-to-terminal times. Censor unfinished runs explicitly; never treat them as zero latency. A safe stop is not recovered. Missing real measurements remain unknown, not zero. Any duplicate effect, false completion, context loss or wrong-owner action fails safety regardless of success rate.

## Recovery boundary inventory

This inventory covers materially different phase/evidence classes. It is **not** a measured denominator. “Existing” means a narrower source/test mechanism exists; “gap” names unimplemented behavior. The recovery column states the safe rule, not a claim every action is implemented. User intervention is justified only after the server exhausts trustworthy sources. No timeout, HTTP 200, heartbeat, matching text or empty history page proves submission/completion.

**Error clarity remains unfinished:** `submittedTurnFailure` still tells the user to “Check the ChatGPT tab before continuing.” This stage does not make exhausted-recovery errors sufficiently explain retained state and the minimum next step, and cannot guarantee retained history after owner loss. The three successful recovery paths reduce avoidable failures; they do not complete the broader UX requirement.

| Fault / phase | Trusted evidence | Recovery and present limit | Stop | User intervention reason | Regression / acceptance |
| --- | --- | --- | --- | --- | --- |
| R01 Pre-Send failure | Owned preparation, no activation | Retry safely; existing cross-request cap, no scheduler | Budget/auth/cancel | Only login/missing input | Submission-retry prepared control |
| R02 Capacity/rate limit | Local capacity vs upstream limit; phase | Bounded wait only when safe; classifications exist | Reset/budget; uncertain Send | Account restriction if unavoidable | Capacity and phase-specific 429 |
| R03 Send ACK unknown | Exact leased page/baseline | Existing rebind, then verified lookup gap; no Send | Proven result or exhausted evidence | Identify original chat only if unavailable | Submission observation, one Send |
| R04 Pending first-chat mapping | Durable owned claim | Preserve uncertainty; receipt-based adoption gap | Unique binding or budget | Lost binding requires supplied chat/explicit fork | Restart after activation |
| R05 Accepted stream disconnect | Live owner, round journal | Existing detach/replay; round fix above | Original terminal/owner loss | None while retained | Four paired SSE scenes |
| R06 Terminal frame lost | Committed result/journal | Existing same-process replay; durable lookup gap | Original terminal delivered | Only lost trustworthy result | Offline-final reconnect |
| R07 Overlapping reconnects | Exact execution/round owner | Existing single-owner takeover | Valid observer or abort | None | Overlap/aborted lookup |
| R08 Accepted DOM unreadable | Unique bound leased response | Timeout fix reaches existing two-rebind path | Recovery/two rebinds/auth/cancel | Only exhausted owned observation | Five observation scenes |
| R09 Known saved tab lost | Immutable account-owned URL/history | Existing restore; original-result retrieval partial | Verified chat/deletion/budget | Deleted/inaccessible history | Saved-chat restoration |
| R10 Process restart/expiry | Mapping/cache, possible receipt | Persistent mapping exists; durable execution journal gap | Verified original or no evidence | Truly lost state only | Crash at acceptance/result commit |
| R11 RST/FIN/truncated SSE | Wire framing and terminal proof | Existing RST cleanup/adapter EOF; byte-framing gaps | Original terminal or incomplete | Only no retrievable result | Provider reset plus clean-FIN bytes |
| R12 Duplicate/gapped/paged events | Execution/branch/order | Round fix; no durable cursor/general pagination | Complete boundary or bounded gap | Genuine branch ambiguity | Replay, order and page boundaries |
| R13 Tool completion ACK loss | Active token/call/result receipt | Candidate exact ACK replay; no durable guarantee | One replay/conflict/retirement | Only unresolvable effect state | Commit-before-ACK fault |
| R14 Quiet long operation | Real tool/progress evidence | Existing semantic liveness; heartbeat alone insufficient | Semantic timeout/cancel | Actual approval/input only | Quiet tool vs dead producer |
| R15 Cancel/completion/Steer race | Exact turn/trace, fence/revision | Existing targeted retirement; cross-process gap | One terminal, physical release | Cancel is intentional, not remediation | Late replay plus healthy sibling |
| R16 Account unavailable | Persistent owner affinity | Keep owner; automatic health-query wait gap | Owner returns/auth/budget | Explicit login/rebind if necessary | Pool outage, no migration |
| R17 Auth expired/denied | Explicit account-session failure | Preserve original state; no blind retry | Login/permission boundary | Sign-in requires user authorization | Typed auth after acceptance |
| R18 Missing/stale context | Proven history/branch/revision | Existing cache/aliases; full reconstruction gap | Verified history/conflict/budget | Lost input or genuine branch choice | MOL-184 two-client/history cases |
| R19 Interrupted paper response | Verified file/dispatch/native history | Existing narrow read-only reconciliation | Terminal/stale state/abort | Truly missing file/binding | Paper recovery commit-once |
| R20 Interrupted file download | Account-owned original file identity | Existing isolation; bounded refetch/range gap | Exact bytes/missing/budget | Original artifact genuinely gone | Byte equality, no regeneration |
| R21 Manual stream disconnect | Launcher Sent/start/owner | Existing retirement differs from automatic mode | Explicit terminal/approved policy | Manual action; extra retry counts | Manual lifecycle contract review |
| R22 Recovery exhaustion | Actual phase, retained evidence | Bound work; unified recovery budget/result schema gap | Attempts/time/resources/cancel | Minimum actionable step only | No leaks, no extra Send |

Source anchors: [adapter](../src/adapters/chatgpt-web/index.ts), [round/session registry](../src/adapters/chatgpt-web/turn-execution.ts), [browser worker](../src/adapters/chatgpt-web/browser-worker.ts), [broker](../src/adapters/chatgpt-web/turn-broker.ts), [persistent mapping](../src/adapters/chatgpt-web/conversation-persistence.ts), [continuation cache](../src/responses/state.ts), [pool](../src/qa-pool.ts). The registry is process-local; settled retention is nominally 30 minutes, 256 sessions and 512 round journals. Durable saved URLs and best-effort continuation snapshots are not exactly-once execution journals.

## Verification and real-handoff delta

Final integrated independent execution passed **38 tests, 0 failures, 176 assertions across five files** ([raw capture](mol185-evidence/stage2-combined-independent.txt)): the three stage-2 fixtures plus retained stage-1 submission and JSON-terminal regressions. Reproduce with Bun 1.4.0:

```sh
bun test tests/mol185-event-replay-identity.test.ts \
  tests/mol185-response-observation-recovery.test.ts \
  tests/mol185-tool-ack-recovery.test.ts \
  tests/mol185-submission-retry.test.ts tests/mol185-json-terminal.test.ts
```

Final production-source [typecheck passed](mol185-evidence/stage2-typecheck.txt). The default runtime build failed on a generated dependency-cache directory symlink ([failure](mol185-evidence/stage2-runtime-build.txt)); the unchanged build passed with an explicit writable external Bun cache ([successful build](mol185-evidence/stage2-runtime-build-isolated.txt)). No build-script change or check bypass was used.

These checks are focused, not full-suite or real acceptance. [Validation summary](mol185-evidence/validation-summary.md) retains existing CI failures; new candidate CI is forthcoming. No unchanged environment-blocked full suite was rerun. A blocked fixture is neither a product failure nor a pass.

Use the [original validation package](mol185-network-validation.md) for isolation, authority, version capture, call limits and restoration. Before real execution obtain the exact commit from the accompanying delivery and independently verify the deployed SHA matches it. Add only:

1. Exact-request reconnect with reordered message keys, in-flight and after offline completion; count genuine Sends and verify the entire original result.
2. Accepted response-read interruption on a test-owned leased transport; preserve the prefix, recover the same surface and prove bounded exhaustion/cancellation.
3. Completion ACK loss after an isolated authorized tool receipt commits; verify one effect and original result. Also test retirement during recovery as explicitly unresolved, never as successful replay.

Use existing approved capacity and an isolated route. No shared restart, credential change, deployment or new spending is authorized here. Record browser/client/helper/server versions, baseline/candidate evidence and real interventions separately. Unexecuted inventory rows remain unknown. Final stage acceptance still requires independent review and agreed real results.

## Retro

Most effort went into tracing existing ownership/recovery before selecting three reproducible gaps. Avoid duplicate helper tests and repeated blocked full-suite runs. Next iteration: use one evidence index, reproduce at the user-path seam, then integrate and hand off once. Report actual elapsed work and substantive handoffs in the stage summary; test counts alone are not impact.
