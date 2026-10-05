# Browser-only question-answer sessions

The browser-only bridge sends human questions to a logged-in ChatGPT browser. It does not
import the Codex system/developer prompt or attach the local Codex tool harness. The Responses
API remains the transport used by the caller. These rules describe automatic Sol question-answer
mode with a launcher browser host and `experimentalFreshConversationPerTurn: false`.

## Accounts and session identity

Each account needs its own launcher browser profile, persistent Electron user-data directory,
descriptor, runtime configuration, and credentials. A distinct `accountId` separates the worker
and execution namespaces; an ID by itself does not create a separate browser cookie jar.

A QA conversation key uses the fixed qa-account/v1 schema, stable accountId and
its own native thread_id. Model/effort, concurrency limits, generated-download
addresses, browser/helper paths, runtime releases and the remaining provider
settings are excluded. The same thread on two accounts intentionally has two
different keys. Keep accountId unchanged when upgrading or relocating the account.
The transient execution/replay namespace is separate and can still change with
runtime settings; QA ownership queues use the stable account scope.

Keep a session permanently pinned to its ChatGPT account. Per-account mappings
cannot distinguish an unseen session from an old session misrouted to another
account. The portable pool gateway owns durable thread-to-account binding and
must fail explicitly on unavailable owners rather than silently select another
account. A router's expiring affinity cache is insufficient for this guarantee.

Model choice, reasoning effort, model family, and context-compaction items do not
change the QA key. The worker reconciles the selected model before each physical
submission. This does not override account availability or ChatGPT context limits.

Use stable native identity metadata and a distinct user-message ID for each new question:

```json
{
  "model": "chatgpt-web/gpt-5.6-sol-instant",
  "stream": true,
  "input": [{
    "type": "message",
    "role": "user",
    "id": "question-2",
    "content": [{ "type": "input_text", "text": "What was the marker?" }]
  }],
  "client_metadata": {
    "x-codex-turn-metadata": "{\"thread_id\":\"chat-1\",\"turn_id\":\"turn-2\"}"
  }
}
```

Keep `thread_id` unchanged for a conversation. Use a new `turn_id` and message ID for a new
question; preserve the original request identity for an exact retry. Missing thread identity
cannot create a shared anonymous retained chat. A caller or upstream adapter must supply the
required identity; the conversation-key function does not guess one from prompt text.

## Incremental questions and full history

When the launcher reuses a retained chat, the bridge submits only the new question. Both these
input forms are supported:

- Incremental input containing just the new user message, with no prior assistant messages.
- Complete canonical history; the continuation starts after its last actual assistant answer.
  Assistant commentary and tool-only messages are not answer boundaries in QA mode.

If a second full-history request arrives while the first answer is still running, it may not yet
contain that answer. The adapter can compare it with the prior submitted request and remove a
proven identical canonical prefix. Different message IDs prevent an intentional repeated question
from being dropped merely because its text matches. This prefix proof is held in runtime memory.

For a new thread, the complete supplied history seeds its first chat. With saved
chats enabled, a recorded URL is reopened after its old tab is gone; only the new
question is submitted. A missing, inaccessible or invalid recorded chat produces
an explicit error rather than silently replacing the conversation with a new one.
The mapping stores a saved-chat URL, not a copy of all ChatGPT answers. With
Temporary Chat explicitly enabled, losing the retained surface loses incremental
context; a caller must supply full history to initialize a replacement chat.

### Durable previous-response continuation

Automatic saved QA records a small durable alias for each completed response ID.
When previous_response_id is supplied, the server verifies the same stable account,
the explicitly supplied native thread_id, its conversation key and its current
saved-chat URL. It then passes only the supplied new input to the adapter. This
continues after the separate one-hour Responses history cache expires or a runtime
restarts, without replaying that cached history. Missing or changed saved mappings
and failed browser restoration are explicit errors; a fresh chat cannot replace a
verified continuation.

Aliases live in response-aliases.sqlite in conversationStoreDirectory. They contain
hashed IDs, the opaque conversation key, a saved-URL hash and a timestamp, without
prompts, answers, cookies or full history. There is no default expiry, count ceiling,
count scan or eviction. Storage grows by small metadata records per completion.
The constructor accepts an optional finite limit for deliberate administrative or
test use; at that opt-in limit, new aliases fail explicitly and existing ones are
preserved. Back up this database with the account's mapping directory.

Unknown IDs, aliases from another account/thread, missing native thread identity
and older IDs issued before alias support fail closed with HTTP 409, including
when an unverified transient history cache entry exists. A caller cannot create a
trusted continuation by supplying the private internal flag. Alias writes happen
before successful completion is returned; a storage failure produces an error
instead of response.completed, though the browser may already have generated its
answer. This is not an exactly-once request journal.

An earlier previous_response_id resumes the current saved chat; it does not select
a historical point or branch the web conversation. A native Codex fork must use a
separate child thread_id and supply its inherited QA history once. Anonymous
previous-ID recovery is not supported. Temporary, native/tool, manual, fresh-chat,
Luna and compaction paths retain their existing bounded-cache behavior.

## Concurrent requests, cancellation and retries

One runtime serializes different QA turns belonging to the same account/thread. A following
question waits for the previous browser operation and its cleanup to settle; it does not supersede
or abort the preceding question. Different threads can run independently subject to the account's
configured model concurrency limits. Queue ownership is process-local: do not rely on multiple
independent runtime processes to coordinate the same account/thread.

An exact in-flight or completed request shares/replays its recorded execution instead of sending
the question a second time. The in-memory execution registry expires inactive entries after
30 minutes and has a 256-entry cap. This is bounded replay protection, not durable exactly-once
delivery across a restart or arbitrary request mutations.

- Cancelling a request while it waits for another turn prevents its browser submission.
- Disconnecting an accepted automatic Responses stream leaves the browser operation available
  for an exact reconnect; disconnecting is not the same as cancelling the ChatGPT generation.
- Closing/cancelling a browser turn explicitly or encountering a terminal browser failure can
  release its surface.
- Retryable pre-submission failures may retry. A failure after Send activation is treated as
  potentially submitted and must not be blindly resubmitted; a deterministic failure remains
  replayable while the execution entry exists.

## Saved chats, relocation and forks

Automatic QA now defaults to useSavedChats: true when the setting is absent.
An explicit useSavedChats: false remains an opt-out: use Temporary Chat and write
no durable mapping. Existing configs that already store false must be deliberately
changed to true to enable persistence. Manual/Full callers retain explicit choices;
manual config with no choice continues to default to Temporary Chat.

conversationStoreDirectory defaults to runtime/conversations under that account's
CODEX_CHATGPT_WEB_HOME. Relative overrides resolve against that home, not the
process working directory. The resolved absolute path, accountId and saved-chat
boolean cross the helper IPC boundary unchanged. The helper's process home does
not redefine the account's store. Copy the directory and keep accountId when moving
machines. Restore the same authenticated ChatGPT account independently; mapping
files do not contain login cookies or give access to the account.

The launcher retains recent tabs in memory, while the durable mapping has no time
expiry or in-memory LRU eviction. Completed saved chats can be reopened by URL
after runtime/helper/launcher restarts. Corrupt records, unresolved first sends,
redirects or unavailable saved chats fail explicitly; they are not overwritten by
a fresh conversation. An active generation interrupted by a restart remains an
uncertain operation, not a durable exactly-once guarantee.

A native Codex fork has a new thread_id. Its forked_from_thread_id and
forked_from_ordinal_exclusive metadata describe lineage, not identity. The first
child request seeds a new saved chat once with the pre-fork user/assistant history
supplied by Codex plus the new user question. Codex system/developer instructions,
tools and assistant commentary remain filtered out. Later child requests append
only the new question to the child's independent saved URL; parent turns continue
at the parent's original URL. The adapter does not click ChatGPT's branch button
or fetch undisclosed history from the parent. A new fork supplying no baseline is rejected before submission with the
nonretryable 400 fork_history_missing error. The QA compiler decides whether
human history exists; runtime/tool wrappers cannot substitute for that history.
A proven restored child may still send only the new question, including when
fork metadata is repeated. Missing parent metadata on later child turns
does not change the child's key.

The source check used Codex core/src/responses_metadata.rs (canonical fork metadata),
core/src/thread_manager.rs (copied history and fork snapshot truncation), and
app-server/src/request_processors/thread_processor.rs (thread/fork initial history).
Self-parent/self-fork identities are rejected instead of mutating a parent's chat.

| Event | Expected behavior |
| --- | --- |
| Runtime, helper, or launcher restart after a completed saved turn | Reopen the same validated saved URL and append the next question. |
| Host relocation or runtime/model/limit/download-address change | Restore the mapping directory and preserve accountId; stable QA keys still match. |
| Native fork | Seed supplied baseline once in a new child chat; never modify the parent mapping. |
| Expired CPR Redis affinity | A durable pool binding must still select the original underlying account. |
| Invalid, unresolved or inaccessible saved mapping | Explicit error; no automatic new chat or account failover. |
| Explicit useSavedChats: false | Temporary Chat; no mapping writes and no restart persistence guarantee. |

The same-chat guarantee still excludes explicit fresh-conversation mode, managed
Chrome, Luna's rolling-checkpoint path and
native tool/manual compaction workflows. Responses history and execution replay
remain separate bounded caches; durable saved-chat restoration does not turn them
into durable request journals.

## Verification

Offline session coverage is in tests/qa-sessions.test.ts,
tests/qa-portable-sessions.test.ts, tests/qa-persistence-ipc.test.ts, and
tests/qa-conversation-persistence.test.ts. It covers independent accounts,
three-turn incremental conversation, model/effort changes, concurrent same-thread requests,
disconnect/reconnect, queued cancellation, retry behavior, and the explicit fresh-chat option.

```bash
bun test ./tests/qa-sessions.test.ts ./tests/question-answer-bridge.test.ts ./tests/zero-risk-adapter.test.ts
bun x --no-install --bun tsc --noEmit
```

