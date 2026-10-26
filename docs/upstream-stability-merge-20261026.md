# Upstream stability merge — 2026-10-26

## Scope and acceptance boundary

This review starts from `dfcc3b3256262a5c412df63efd90642356ce0ce6` on
`wip/upstream-stability-merge-20261026` and integrates upstream v6.1.14,
`cfeaf04bc7f54cea29e1ff2adbcad63bd038b119`. The starting merge candidate already
contained upstream v6.1.13 and the fork's MOL185 recovery work. Those changes were
compared before implementation to avoid applying the same fixes twice.

The implementation keeps recovery, scheduling and upstream error handling in the
server. A client can observe recovery and account-selection notices without those
notices becoming conversation input or answer text. Recovery must preserve the
original accepted browser turn and tool invocation. Uncertain execution is retained
for reconciliation; it is not permission to send a second prompt or repeat a tool.

Three subagents worked concurrently, the maximum available alongside the root
agent. The sequence was static lifecycle/file review, parallel implementation,
independent cross-review, correction and regression, then a final architecture and
upstream-contract pass. Reviewers exchanged areas after implementation. The
coverage ledger below distinguishes complete modules, affected function paths and
diff review; it does not claim that every unchanged line in the repository was
manually re-audited.

This is source and isolated-fixture validation. It does not certify a deployed
service, an authenticated ChatGPT session, an installed Codex toolchain, or native
macOS/Windows packaging. No production service or user account was exercised.

## Problems and implemented behavior

| Area | Defect / incomplete behavior | Implemented result |
| --- | --- | --- |
| Native browser recovery | Recovered text could finish logically without completing the original Host execution and durable physical-release handshake. | Read-only recovery validates the original checkpoint, continuous Host watch, completed submission and result-ready proof, then completes only that original execution and records its release. |
| Helper loss | A first Full request could lose its retained observation lease when its helper exited; the reaper could also discard a registered observation. | Acknowledged observation checkpoints survive helper loss. The parent and Host keep the original owner until proved completion or explicit cancellation. |
| Same-response recovery | Accepted helper failure could become a cached terminal error requiring client recovery. | Reconnect to the original observation inside the same response, publish only the missing suffix, and use the existing durable recovery budget. |
| Before-Send retry | A retryable preparation failure escaped to the client despite no dispatch. | Bounded retries occur only before Send and after the prior physical lifecycle settles. Accepted execution, explicit cancellation, permissions and rate limits do not acquire automatic resend authority. |
| Persistent conversations | Cancelling a failed recovery preparation could delete the previous saved mapping and history. | Restore the complete previous mapping, history and project state atomically when cancellation is proved before Send. Ambiguous or accepted sends cannot roll back. |
| QA receipt identity | A single session-keyed row overwrote turn A after turn B, allowing a delayed A retry to become fresh work. | Transactional migration to `(session_hash, identity_hash)` preserves multiple identities. A/B/A replays A without dispatch. Previously overwritten historical rows cannot be reconstructed. |
| Account scheduling | An unowned new session failed if its first candidate lost final admission, even with another healthy account. | Recheck health, fences and ownership for each eligible candidate until ownership commits. Existing or submitted conversations remain pinned. A successful fallback emits an account-selection notice. |
| Drain / terminal state | `response.incomplete` and `response.cancelled` could leave a completed dispatch fenced forever. | Recognize their terminal response identities for drain while retaining incomplete history as uncertain. They are not converted to successful history. |
| Journal lifetime capacity | Successful historical operations and broker channels occupied active capacity indefinitely. | Archive only provably terminal, physically settled records, retaining identity and exact replay. Upgrade scanning archives eligible old records at capacity. Unknown or unproved records remain active. |
| MCP capacity | The 256-request limit counted lifetime completions. | Apply the limit to unresolved requests; retain completed identity/digest tombstones and a bounded recent-response cache. An evicted exact response is explicitly non-redispatchable. |
| SDK validation | SDK rejection before entering the claim handler could leave a non-dispatched request uncertain and block drain. | Connection-local evidence of non-dispatch can complete that admission, including a local JSON-RPC schema error. Remote errors, transport failures and ambiguous/duplicate identities do not provide this proof. |
| Retained command polling | The public MCP contract allowed a 60-second empty poll but retained-execution recovery still rejected anything above 30 seconds. | Align known-handle read-only polling with the 60-second transport budget. Longer polls and input-bearing calls remain subject to the existing refusal and dispatch gates. |
| Observer cancellation | Loss of the MCP observer later threw from the original owner's batch wait and cancelled its browser turn. | Keep waiting for the original invocation/result. Existing dispatch gates still prevent new side effects until reconciliation. |
| IPC ordering | Helper error frames could overtake pending checkpoint/result persistence. | Both completion and failure paths honor the existing persistence barriers before deciding whether recovery is available. Failed widget persistence cannot be followed by an apparently valid result-ready event. |
| Files and images | Observation recovery omitted media; regenerating a random URL after partial output broke prefix verification. | Share final artifact collection. A private durable recovery index reuses the original random capability URL only for the same scoped content, metadata and unexpired file. An existing index with a missing, corrupt or expired target is rejected. Original output-prefix equality remains mandatory. |
| Charts | Cold recovery, durable-final replay and the helper's widget parser did not preserve all supported chart types. | Preserve typed widget projection data through observation and final replay, validate the complete widget union, and deduplicate identical widget IDs while rejecting conflicting content. |
| Responses protocol | JSON and SSE disagreed on truncation, compaction, chart output, replay IDs and late callbacks. | First terminal wins. Truncation/filtering remains incomplete; partial compaction cannot replace history. JSON and SSE retain the same chart and stable output identity. |
| Synchronous replay | Large synchronous generations filled the event queue; even reporting overflow could throw again. | Non-streaming generation collects directly. Streaming coalesces adjacent compatible deltas in bounded chunks and has a separate terminal-failure slot, retaining the structural-event backlog limit. |
| HTTP status | A late capacity error could change an already-completed JSON response to HTTP 429. | Derive status from the first terminal event and ignore later producer callbacks. |
| Provider switching | Stable local output IDs could be sent to the native provider as foreign backend references. | Strip recognized local replay identities while preserving output content and genuine native encrypted reasoning. |
| Catalog defaults | A Full account without xhigh could fail model discovery before choosing an available default. | Catalog and request routing share an available-default resolver; explicit unsupported efforts still fail. |
| Tool capability | Tools selectors were advertised even when the configured automatic provider disabled tools, causing silent Chat execution. | Catalog, routing and provider configuration share the same capability rule. Unavailable Tools selectors are omitted and explicitly rejected; configured external-http Full retains its tool selectors. |
| Saved aliases | Full external-http used the provider's global tool capability to reject an explicitly selected Chat turn's durable aliases. | Honor the server-resolved per-request capability first; Tools and temporary requests still cannot acquire Chat-only saved aliases. |
| User-visible maintenance | Account health maintenance appeared as a fatal global error and exposed internal account identifiers. | Localized maintenance status remains visible with theme-consistent styling and post-render acknowledgement. Actual non-maintenance failures keep their existing error handling. |

## Upstream integration and architecture decisions

The merge includes upstream's cwd-less current-native-turn environment resolution,
rich multipart history rendering, observed Chinese effort labels, MCP transport
polling budget, longer delayed-final grace, context-token reporting and separation
of MCP setup from model-catalog verification. Version metadata is v6.1.14.

Ordinary saved conversations are the default, matching upstream. The retired
global `useSavedChats` preference and old personalization flow are removed. The
fork's explicit per-request temporary mode remains supported. Full mode resolves
that choice from its public selector/effort; QA uses the pool's validated metadata.
A temporary request cannot silently reuse a saved page or saved response alias.

The existing request → adapter → helper → Launcher Host architecture remains in
place. The only new production module, `native-observation-completion.ts`, holds
the shared terminal-only validation and release handshake used by both normal
observation recovery and a durable result whose release acknowledgement was lost.
It creates no new Send, Stop, navigation or replacement-writer authority.

Storage changes use the existing journal and SQLite transaction layers. Active
capacity is distinct from historical replay retention. The broker remains the
authority for tool dispatch, activity and completion fences. No parallel scheduler,
second journal, blanket retry wrapper or new dependency was introduced.

The fork's configured tool boundary is preserved rather than widened by a selector.
Automatic Full with `external-http` supports tools; the existing manual mode keeps
its separate control channel. The default official automatic provider remains
Chat-only in this fork, and now advertises that truthfully. Enabling its tool
channel would be a separate integration change requiring its own acceptance.

Two unreferenced source snapshots under `.retained-forward-review/` were removed.
Their historical versions remain in Git. Tests use isolated temporary state,
valid synthetic Launcher descriptors and current Native identities rather than
developer-specific directories. Capability and lifecycle assertions were retained
when updating old fixtures to the merged contracts.

## Review coverage

| Scope | Files / function paths | Review depth |
| --- | --- | --- |
| Request lifecycle | `index.ts`, `turn-execution.ts`, `operation-journal.ts`, `adapter-error.ts`, `retry-policy.ts`, `observation-recovery.ts`, `release-evidence.ts`, `native-execution.ts`, `native-metadata-ack.ts`, `native-terminal-receipt.ts`, `concurrency.ts`, `output-validation.ts` | Complete modules or all lifecycle functions; fork/upstream diffs and targeted tests. |
| Tools and completion | `turn-broker.ts`, `mcp-admission.ts`, `mcp-http.ts`, `mcp-observation.ts`, `mcp-server.ts`, `submission-identity.ts`, `turn-progress.ts` | Register, claim, invoke, cancellation, receipt, reconciliation, retirement, archive and remote acknowledgement paths; independent cross-review. |
| Compaction / retained work | `compaction-handoff.ts`, `native-compaction-control.ts`, `compaction-transaction.ts`, `compaction-continuation.ts`, `rolling-checkpoint.ts`, `retained-forward-lane.ts`, `retained-forward-surface.ts` | Relevant authority, source identity, commit, delivery and recovery paths. |
| Browser | `browser-worker.ts`, `browser-helper-main.ts`, `launcher-helper-client.ts`, `native-observation-completion.ts`, `41_native_model_identity.ts`, browser interaction/response/user-message helpers | Preparation, physical Send, owner binding, observation/rebind, extraction, recovery and cancellation; all changed blocks. Large unchanged DOM extraction sections were checked through affected call sites, upstream diffs and existing DOM fixtures. |
| Launcher Host | `browser-host.cjs`, `control-server.cjs`, `launcher-browser-host.ts`, native submission observer, retained-turn-release and suspension modules | Authentication, original watch/capability, terminal completion, reaper, physical release and cancellation; independent review and Host tests. Unchanged window/navigation bootstrap was not re-read line by line. |
| Launcher runtime/UI | `main.cjs`, `runtime.cjs`, `runtime-supervisor.cjs`, `state.cjs`, `runtime-install.cjs`, `package-smoke.cjs`, `preload.cjs`, health/auth modules, `App.tsx`, `i18n.ts`, `styles.css`, `types.ts` | Fork/upstream diffs and affected control/status paths; complete small health modules. Unchanged installer/update/UI sections were not fully re-audited. |
| QA / scheduling | `qa-pool.ts`, `qa-pool-receipts.ts`, `qa-health.ts`, `qa-health-build.ts`, `release-admission.ts`, `paper-registry.ts`, `paper-recovery.ts`, `paper-history.ts` | Complete modules or contiguous lifecycle blocks; admission, pinning, transactions, replay, ambiguity and drain. |
| Conversation / authority | conversation key/persistence modules, `environment.ts`, `thread-environment.ts`, `codex-rollout-environment.ts`, Responses parser/schema/state/delegation/native-context/compaction/alias modules | Current/historical authority, identity, provenance, restored history and per-request modes. Mixed unowned environment history retains the fork's proof requirement. |
| Media / prompts | `generated-files.ts`, `download-gateway.ts`, `native-api-auth.ts`, `response-images.ts`, `downloads.ts`, `rich-widget.ts`, prompt/markdown/skill-attachment/token modules | File capability, provenance, expiry, content hash, concurrent publication, prefix continuity and context transport. |
| Public protocol | `server.ts`, `bridge.ts`, `event-queue.ts`, `native-passthrough.ts`, `chatgpt-session.ts`, `chatgpt-web-models.ts`, `model-catalog.ts`, `config.ts`, `types.ts` | Request validation, capability and session selection, JSON/SSE terminal parity, bounded replay, provider switching and upstream API/style consistency. |
| Tests / build | Changed regression files, upstream merge tests, version/build/notice/smoke scripts | Contract-focused review and executable checks. A test or typecheck is not represented as a manual review of every implementation line. |

### Changed production-file checklist

The following is a per-file index of the production changes in this merge. The
review depth remains as stated above; small upstream-only changes were checked as
diffs and through their affected contracts.

| File | Checked responsibility / merge decision |
| --- | --- |
| `src/adapters/chatgpt-web/index.ts` | Same-response recovery, accepted-owner retention, before-Send retries, chart persistence/replay and terminal emission. |
| `src/adapters/chatgpt-web/browser-worker.ts` | Ordinary/temporary preparation, multipart proof, original-turn observation, artifact extraction and physical terminal handshake. |
| `src/adapters/chatgpt-web/browser-helper-main.ts` | Helper request surface and upstream removal of the retired global preference. |
| `src/adapters/chatgpt-web/launcher-helper-client.ts` | IPC validation, persistence barriers, observation retention, failure causality and chart callbacks. |
| `src/adapters/chatgpt-web/native-observation-completion.ts` | Shared exact-scope result-ready and Host release validation; no dispatch authority. |
| `src/adapters/chatgpt-web/operation-journal.ts` | Native transitions, active/archive separation, upgrade migration, replay identity, notices and chart projection. |
| `src/adapters/chatgpt-web/turn-broker.ts` | Terminal archival, replay, observer-loss waits, dispatch fence and known-handle polling budget. |
| `src/adapters/chatgpt-web/mcp-admission.ts` | Unresolved capacity, completed tombstones/body cache and distinct local rejection evidence. |
| `src/adapters/chatgpt-web/mcp-server.ts` | Actual SDK rejection correlation and upstream poll budget. |
| `src/adapters/chatgpt-web/turn-progress.ts` | Preserve the original retirement cause during cleanup. |
| `src/adapters/chatgpt-web/conversation-persistence.ts` | Before-Send restoration of the previous mapping and recovery lineage. |
| `src/adapters/chatgpt-web/environment.ts` | Current native authority, optional cwd and mixed historical provenance. |
| `src/adapters/chatgpt-web/thread-environment.ts` | Upstream cwd-less update resolution plus fork history/cache proof. |
| `src/adapters/chatgpt-web/prompt.ts` | Upstream multipart/context-token representation and native agent-message contract. |
| `src/adapters/chatgpt-web/response-images.ts` | Scoped artifact preservation without changing the download source authority. |
| `src/adapters/chatgpt-web/rich-widget.ts` | Inert bounded Cartesian, pie and heatmap IPC validation. |
| `src/server.ts` | Public session/tool choices, alias admission, direct JSON collection and first-terminal HTTP/SSE handling. |
| `src/bridge.ts` | Truncation/filtering, compaction, chart output and stable replay identities across JSON/SSE. |
| `src/event-queue.ts` | Bounded compatible coalescing and a terminal slot independent of backlog capacity. |
| `src/native-passthrough.ts` | Local replay-ID scrubbing while preserving native payloads. |
| `src/qa-pool.ts` | Pre-ownership candidate fallback, sticky ownership, transaction/fence ordering and terminal drain. |
| `src/qa-pool-receipts.ts` | Composite identity migration and non-overwriting replay records. |
| `src/responses/saved-chat-aliases.ts` | Resolved per-request tool/session capability with original identity checks. |
| `src/generated-files.ts` | Random capability retention, durable private index, scoped content validation and concurrent publication. |
| `src/chatgpt-session.ts` | Ordinary default, explicit temporary/project options and observed Chinese effort labels. |
| `src/chatgpt-web-models.ts` | Shared runtime tool capability, available-effort defaults and explicit-route rejection. |
| `src/model-catalog.ts` | Actual supported defaults/context limits and native template contracts. |
| `src/config.ts` | Retired-field migration and one shared tool-capability policy. |
| `src/types.ts` | Resolved request modes, removed legacy option and type-only import placement. |
| `src/launcher-browser-host.ts` | Typed terminal-only observer control and Host receipt transport. |
| `src/browser-login.ts` | Upstream ordinary login surface and authentication checks. |
| `src/cli.ts` | Removal of obsolete global saved/temporary setup flags. |
| `src/setup.ts` | Corresponding option and change-detection cleanup. |
| `src/doctor.ts` | Separate runtime reachability from observed model-catalog success/failure. |
| `src/composer-predictions.ts` | Upstream removal of the global temporary preference. |
| `src/dev-chat/cli.ts` | Matching DEV setup option cleanup. |
| `src/dev-chat/driver.ts` | Matching provider configuration cleanup. |
| `src/version.ts` | v6.1.14 version synchronization. |
| `launcher/electron/browser-host.cjs` | Exact original observation capability, completion/release idempotence and reaper retention. |
| `launcher/electron/control-server.cjs` | Authenticated terminal-only observer action routing. |
| `launcher/electron/main.cjs` | Matching IPC/setup cleanup and Host integration. |
| `launcher/electron/browser-helper-verifier.cjs` | Verification payload without the retired preference. |
| `launcher/electron/preload.cjs` | Removal of the obsolete preference IPC API. |
| `launcher/electron/runtime.cjs` | Removal of the obsolete setup mutation. |
| `launcher/electron/state.cjs` | Drop the old field when reading existing state. |
| `launcher/src/App.tsx` | Localized maintenance status, post-render acknowledgement and ordinary-chat UI cleanup. |
| `launcher/src/i18n.ts` | Five-language status copy and removed obsolete preference labels. |
| `launcher/src/styles.css` | Theme-consistent maintenance status styles. |
| `launcher/src/types.ts` | Renderer API aligned with the removed preference. |
| `scripts/install.sh` | Installer default version synchronized to upstream release. |
| `scripts/smoke-codex-environment.ts` | Upstream same-turn steering fixture waits for actual child output before steering. |

## Verification

Validation ran on Linux with Bun 1.4.0, Node 24.22.1 and Google Chrome
156.0.8078.47. DOM tests used the full Chrome executable through
`CHATGPT_DOM_TEST_BROWSER`; process tests used the real local `apply_patch`
executable through `BROKER_APPLY_PATCH`. Each root-test shard had its own
`CODEX_CHATGPT_WEB_HOME`. The fixtures use isolated state and local synthetic
services, not authenticated user accounts.

The root suite was divided into three explicit, disjoint file lists passed to
`bun test`. Their union was independently checked against all current Bun test
files under `tests/`: 161 files, with no omissions, duplicate assignments or stale
paths. Production sources were frozen for the final gate. Subsequent changes were
limited to the test fixtures described below and this report.

| Gate | Final result | Scope / elapsed time |
| --- | --- | --- |
| Root tests, shard 1 | 765 passed, 1 skipped, 0 failed; exit 0 | 766 tests, 53 files, 5,098 assertions; 292.17 s. |
| Root tests, shard 2 | 592 passed, 10 skipped, 0 failed; exit 0 | 602 tests, 54 files, 5,621 assertions; 284.89 s. |
| Root tests, shard 3 | 473 passed, 3 skipped, 0 failed; exit 0 | 476 tests, 54 files, 5,092 assertions; 201.05 s. |
| Root suite total | 1,830 passed, 14 skipped, 0 failed | 1,844 tests across all 161 files; 15,811 assertions. |
| Launcher tests | 479 passed, 1 skipped, 0 failed; exit 0 | 480 tests through `node --test`; 11.35 s. |
| Root TypeScript | Passed; exit 0 | `bun run typecheck`, repeated after the final fixture changes. |
| Launcher TypeScript and renderer build | Passed; exit 0 | `bun run launcher:build`; Vite built 442 modules. |
| Version consistency | Passed | `VERSION_SYNC_OK 6.1.14 bun@1.4.0`. |
| Root dependency audit | 0 reported vulnerabilities | 105 packages checked on 2026-10-26. |
| Launcher dependency audit | 0 reported vulnerabilities | 308 packages checked on 2026-10-26. |
| Runtime bundle and notices | Built successfully | `scripts/build-runtime-bundle.ts`, including Launcher third-party notices. |
| Relocated runtime smoke | Passed; exit 0 | `RELOCATABLE_RUNTIME_SMOKE_OK`; manifest, relocation, local daemon health, unauthenticated refusal and graceful drain/shutdown. |
| Git patch checks | Passed | No whitespace errors or unresolved merge entries. |

These are separately executed verification components. This report does not claim
that a single invocation of `bun run verify` or the earlier intermediate aggregate
run completed successfully. Focused regressions are additional diagnostic evidence
and are not added to the final suite totals. The two non-overlapping suites total
2,309 passing cases, 15 environment-gated skips and no failures.

### Skipped-test boundaries

The root suite has 14 environment-gated cases: nine require an explicitly configured
Electron executable, two require a different operating system, and three share the
`CORE_SLOT35_FIXTURE` gate. Ordinary Chrome was available throughout the final DOM
runs. None of the corrected failures is counted as a skip in the final results.
The `apply_patch`-dependent broker case now has an executable-availability gate;
the final run provided the actual executable and ran that case successfully.

| File | Cases | Actual gate / coverage omitted |
| --- | ---: | --- |
| `tests/context-markdown-regexp.test.ts` | 1 | `LAUNCHER_TEST_ELECTRON` unset: actual Chromium link-regex stall and encoding responsiveness. |
| `tests/launcher-navigation-viewport.test.ts` | 1 | `LAUNCHER_TEST_ELECTRON` unset: Electron task-page navigation before delayed resources finish. |
| `tests/attachment-upload-electron.test.ts` | 3 | `LAUNCHER_TEST_ELECTRON` unset: already-finished `file.processing.completed`, `file.processing.error` and `file.processing.file_ready` upload responses. |
| `tests/chatgpt-markdown-parser.test.ts` | 1 | `LAUNCHER_TEST_ELECTRON` unset: encoded context avoids the Chromium Markdown parser stall. |
| `tests/launcher-viewport-browser.test.ts` | 1 | `LAUNCHER_TEST_ELECTRON` unset: another tab finishing preserves the model picker and viewport. |
| `tests/browser-generation.test.ts` | 2 | `LAUNCHER_TEST_ELECTRON` unset: captured Stop and Think controls. Their HTML fixtures are present in the repository. |
| `tests/environment.test.ts` | 1 | Windows only: resumed tasks accept both path namespaces for the same indexed rollout. |
| `tests/setup-lifecycle.test.ts` | 1 | macOS only: external-service validation cleanup on both success and failure. |
| `tests/46_slot35_remount.test.ts` | 3 | `CORE_SLOT35_FIXTURE` unset: exact repeated-block identities, rejection of edited replacements and continuity during growth. Only the first case reads external captured JSON; the two synthetic-DOM cases inherit the same shared gate. |

The Launcher suite separately skipped
`Windows installer resolves only the official public release redirect` because a
PowerShell executable was unavailable. Launcher contract tests that describe
Windows/macOS packaging are not a substitute for building and launching those
native packages.

### Integrated-run corrections

Earlier aggregate runs were used to identify regressions and obsolete fixtures;
their partial totals are not final acceptance results. The original MCP
cancellation-negative test exposed a production classification error and was
retained while the implementation was corrected, as described in the independent
review section below.

The final fixture corrections preserved the relevant safety assertions:

- `42_fork_notice.test.ts` now supplies the actual Native `send_activated` →
  `watch_ready` → `post_observed` → `accepted` identity and a v2 observation
  checkpoint in its QA acceptance-failure case. It does not fabricate completion
  or physical release. Ambiguous/unknown/retained state, zero forks and one Send
  remain required; the accepted slot is also checked separately from the
  operation's still-incomplete submission state.
- `42_operation_journal.test.ts` no longer expects observer loss to reject the
  original owner's `nextToolBatch` wait. It proves that the wait remains pending,
  no duplicate call is added, and the same wait later receives an authorized
  read-only poll or a new intent after receipt reconciliation. Fresh side effects,
  nonempty stdin and unknown handles remain fenced. An abort-and-consume cleanup
  prevents abandoned fixture promises.
- `browser-turn-binding.test.ts` allows at most three observations only when the
  production probe explicitly reports a timeout and all observed content is empty.
  A normal or partially populated return still fails immediately, and the final
  assertion still requires the original incomplete-code extraction error. The
  production two-second observation budget is unchanged.

The saved-chat fixtures exposed two insufficient whole-test budgets. The five-turn
temporary-to-persistent promotion case exceeded 60 seconds during concurrent DOM
validation; the unchanged case passed alone in 53.39 seconds, including 22.02 seconds
of real diagnostic collection. Isolating the shard alone was not sufficient: its
two-turn fork case later exceeded 20 seconds during `context.close`, after both
Sends reached their expected fixture sentinel. Eleven DOM/interaction/structure
captures accounted for 10.51 seconds, with no capture errors. The adjacent two-turn
save/resume case took 20.01 seconds and passed under its existing 30-second budget.
No retained Chrome process, out-of-memory event or sustained CPU throttling was
found to explain these failures. A timeout killed the shared browser and caused
the subsequent `Target closed` failures.

`qa-saved-chat-recovery.test.ts` therefore gives the fork case the same 30-second
whole-test budget as its two-turn sibling, and gives the five-turn promotion case
90 seconds. These are functional lifecycle tests, not latency benchmarks. An
independent reviewer confirmed that `ChatGptBrowserDiagnostics.capture` is
unchanged from the starting branch and that these paths added no duplicate Send
or diagnostic wait. The real diagnostic collection, all assertions, production
stage deadlines and recovery rules are unchanged. No test retry or new skip was
added. The final shard-1 run remains isolated from the other Chrome shards. Its
fork case passed in 19.02 seconds and its five-turn promotion/reload case passed
in 68.15 seconds, with all subsequent saved-chat cases also passing. The latter
measurement exceeded the previous 60-second test budget even in isolation.

The relocated smoke initially rejected a bundle whose parent was the generic
`/tmp` directory because its existing build-path guard consequently matched too
broadly. Rebuilding under a dedicated parent with a `runtime` child passed the
unchanged guard and smoke script. No production guard or test assertion was
relaxed to obtain that result.

### Independent review and correction

The request reviewer traced browser/Host terminal authority and found the helper
error-frame persistence race and missing chart projection on cold/final recovery.
The browser reviewer traced scheduling, routing and Responses output and found the
stream-backlog secondary failure, late HTTP 429, per-request alias mismatch and
advertised-but-unavailable Tools selectors. The scheduler reviewer independently
checked media publication, operation/broker archival and actual SDK rejection
paths, reproducing the non-dispatched admission that prevented drain. The final
upstream pass also found the retained-poll budget mismatch.

The subsequent aggregate test exposed an overly broad interpretation of the MCP
non-dispatch proof. The original cancellation-negative assertion was retained.
Broker claim proof and local SDK/handler proof are now separate, and a local RPC
rejection additionally requires a recognized local validation code. Five new
negative cases cover cancellation, timeout, connection loss, unknown codes and
broker-only evidence. The corrected MCP group passed 37 tests and was independently
reviewed again before the final aggregate run.

Each finding was corrected in its owning module and checked by another reviewer.
Targeted regressions reproduced the identified failures before repair where a
direct executable fixture was applicable. The final review found no outstanding
blocking defect in these reviewed changes. This statement does not extend the
scope beyond the coverage ledger or replace release acceptance.

## Operational limits retained deliberately

- An accepted or ambiguous send is never treated as safely unsent. Unknown owner,
  submission or tool-process state stays retained and may still require a proved
  reconciliation path. No success or release is fabricated to hide an upstream error.
- Existing saved conversations remain pinned to their original account. Pre-admission
  candidate fallback does not migrate a conversation that has already been bound or sent.
- Old journals lacking sufficient retirement evidence remain active. Migration cannot
  reconstruct receipts overwritten by a previous release.
- Completed MCP identity tombstones prevent redispatch after the bounded full-response
  cache evicts a body. Durable broker receipts remain a separate recovery source.
- Expired or corrupted media capabilities are not silently renewed. Original content
  and scope must validate before an indexed URL is recovered. A previously absent
  index allows first publication. If an index is lost after its URL was already
  exposed, a newly created URL cannot bypass the original output-prefix check.
- Real-account timing, installed Native integration, Windows/macOS filesystem behavior
  and packaging require their existing release acceptance on those environments.
