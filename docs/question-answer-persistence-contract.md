# QA saved-conversation contract

Coordination contract for the account/IPC owner and the browser/store owner.
No production configuration or live browser is changed by this implementation.

## Configuration and IPC

- Existing accountId is the stable account identity. It must stay unchanged
  across upgrades, relocation, public-address changes and model selection.
  Different authenticated accounts must have different accountId values.
- Existing useSavedChats defaults to true for automatic QA when unspecified.
  Explicit false is the privacy opt-out: use Temporary Chat and do not persist
  conversation mappings. Manual/Full-harness callers retain explicit settings.
- New conversationStoreDirectory is an optional string in AppConfig and
  provider.chatgptWeb. The default is runtime/conversations under the
  account's CODEX_CHATGPT_WEB_HOME. Relative paths resolve against that home.
- The browser/store owner adds conversationStoreDirectory to ResolvedBrowserConfig
  and resolves the same default for direct worker callers. The IPC owner passes
  the resolved path and the resolved useSavedChats boolean unchanged through
  LauncherBrowserHelperClient's run config into browser-helper-main.
- The helper must not derive saved/temporary behavior from its own process home.
  The parent account's resolved configuration is authoritative.

## Stable keys and ownership

- BrowserTurn.conversationKey remains the opaque 64-character SHA-256 key.
  Saved QA keys use a versioned, fixed key schema with accountId and the native
  thread_id. Application release versions and arbitrary provider config are not
  key inputs. Full/manual runtime execution identity remains a separate concern.
- A child's own thread_id identifies its chat. parent_thread_id is lineage,
  never a substitute for the child's identity and never a shared-chat key.
- Model, reasoning effort, concurrency, downloads/public ingress, executable
  paths, CDP descriptor paths, runtime version and compaction do not change a QA
  chat key. Relocation requires copying the mapping directory and keeping accountId.
- Saved restoration applies to retained automatic QA turns with useSavedChats
  enabled. Native tool turns and compaction must not accidentally acquire a saved
  QA mapping solely because a config default changed.
- The browser/store owner persists at least account identity, conversation key,
  a validated ChatGPT saved-chat URL and creation time. It owns URL validation,
  atomic private writes, restoration, retirement and fail-closed behavior when a
  saved mapping cannot be restored. Do not log or persist cookies/control tokens.
- Existing prepare/prepareResume callbacks and conversationKey cross IPC as
  before. Only a proven restored/reused conversation may use prepareResume.
  An unknown child/fork must never resume its parent's mapped browser chat.

Native Codex forks create a distinct ChatGPT chat. Their first turn uses prepare
with the supplied pre-fork QA history plus the new question, filtered by the QA
compiler. Only a proven retained or restored child chat uses prepareResume on
subsequent turns. The parent's mapping and browser chat remain unchanged.

Local Codex source confirms forked_from_thread_id and
forked_from_ordinal_exclusive in the canonical x-codex-turn-metadata blob;
parent_thread_id is separately used for subagent ancestry. None of these lineage
fields replaces the child's own thread_id or changes its stable key. A request
claiming its own thread_id as its parent/fork source is rejected.

An account-specific mapping cannot detect that an unseen thread was routed to
the wrong account. The pool gateway must permanently and atomically bind its
caller/session identity to accountId before forwarding; failures do not rebind.
CPR should treat this gateway as a single pool account. Account selection must not
fall back to another ChatGPT login when its Redis affinity expires. The pool's
ownership database and each account's mapping directory are a joint backup unit.
A child independently binds its own thread and receives the caller's baseline
history even if the pool selects another available ChatGPT account.

## Contract synchronization

The directory field above matches the store implementation. The name
conversationStorePath from the first proposal is superseded, not an alias.
The default account identity is the literal default, never a filesystem path;
otherwise relocation would invalidate the account hash inside stored records.
Direct workers must use runtime/conversations under getConfigDir() as the default
and resolve relative overrides against getConfigDir(), just as providerConfig does.
Only explicit non-QA tool/manual callers default to Temporary Chat; automatic QA
defaults to saved chats unless useSavedChats is explicitly false.

Cold fork context validation: prepare rejects a newly created fork whose supplied
human history reduces to only the latest question, with HTTP 400 semantics and
code fork_history_missing (nonretryable). Validation uses the same QA compiler
that removes runtime/tool wrappers. It runs before submission, not for a proven
restored child's prepareResume path. No background parent-chat fetch is attempted.

## Durable response aliases

The server owns response-aliases.sqlite beside the account's conversation mappings.
Completed automatic saved-QA responses record hashed response/account/thread IDs,
the stable QA key and the current saved-URL hash. No full history is added, and the
default registry has no TTL, size-count ceiling, count scan or eviction. A finite
constructor limit is an explicit opt-in only. Alias ownership is immutable.

For previous_response_id, the server verifies that alias against the caller's own
native thread identity and current account mapping even on transient-cache hits.
It then reparses only the caller's original input, setting the private
_chatgptSavedConversationContinuation marker. The adapter rejects prepare for such
a request; only the existing proven prepareResume path may submit it. This needs
no new worker/store fields and preserves saved-URL restoration after a restart.
Unknown/foreign IDs or missing/replaced mappings fail closed; cached text cannot
authorize ownership. Earlier IDs continue the current saved chat, not historical
branches. Forks still require separate child identity plus baseline history.
