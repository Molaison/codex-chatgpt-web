# Question-answer concurrency limits

Each account runtime accepts these top-level configuration fields:

    {
      "standardConcurrencyLimit": 5,
      "proConcurrencyLimit": 2
    }

Both must be integers from 1 through 5. They are passed to provider.chatgptWeb
and validated again when the browser worker is resolved. Restart that account's
runtime after changing its configuration.

Ordinary models share the account's ordinary pool; Pro models share its Pro
pool. These are two classes, not a separate allowance for every reasoning
effort or alias. After public route resolution, automatic Pro turns have
reasoning=max. The dedicated Zero Risk Pro backend also counts as Pro when its
reasoning option is absent or low. Instant, Medium, High, Extra High and Luna
count as ordinary turns.

MAX_CHATGPT_BROWSER_TABS=5 remains the total simultaneous-turn ceiling per
worker. Two Pro turns leave room for only three ordinary turns; setting both
individual limits to five does not allow ten browser turns. Rejected work is
not queued. Its typed error has status metadata 429, errorType=rate_limit_error,
code=concurrency_limit_exceeded and retryable=true. The caller can retry after
another turn finishes. The actual HTTP envelope or SSE event also depends on
the Responses endpoint's streaming mode.

Admission happens synchronously in ChatGptBrowserWorker.run before generation
or launcher-helper dispatch. Completion, rejection and cancellation release
the reservation when the underlying run settles. Cancelling a still-running
browser operation does not permit its slot to be reused prematurely. Duplicate
active trace identities are rejected separately without replacing or releasing
the original reservation. The identity can be reused after it finishes, and
identical traces in different accounts remain independent.

Counters are process-local and shared by calls resolving to the same worker
configuration. Different account IDs isolate workers. These are not distributed
quotas across separate runtimes or different configurations pointing to the same
authenticated account. Run one configured runtime per account. CPR's own
account concurrency limit is an additional outer limit.

Verification (September 28, 2026):

    bun test tests/qa-concurrency.test.ts tests/question-answer-bridge.test.ts

The new suite sends 40 simultaneous calls through the real worker entry for
several configured limits, including Pro. Only generation is simulated, so it
does not consume live Pro quota. It covers defaults, config propagation and
invalid values, class/account isolation, the aggregate cap, duplicate traces,
completion/cancellation/asynchronous and synchronous failure cleanup, Pro
recognition, and admission on both sides of launcher-helper dispatch.

