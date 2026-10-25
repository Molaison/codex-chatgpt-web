# MOL-185 offline regression comparison

These are deterministic test case counts, not success-rate estimates for production traffic, latency benchmarks, or live ChatGPT validation. Each row is a different suite; do not pool denominators or compare them as workload sizes. Candidate captures were made before integration; the handoff document must identify the final SHA and rerun results.

| Suite / execution class | Baseline pass | Baseline fail | Candidate pass | Candidate fail | Sample |
| --- | ---: | ---: | ---: | ---: | --- |
| Provider partial SSE reset / real provider process, synthetic upstream, test-only TCP listener | 0 | 2 | 2 | 0 | QA and Full, one case each |
| Typed submission retry / injected browser failure | 1 | 2 | 3 | 0 | Matched prepared, send_activated, accepted subset; candidate log has two additional controls |
| Adapter EOF / nonstream response builder | 5 | 4 | 9 | 0 | Same nine cases on both versions |

Sources: provider before (`archive:docs/mol185-evidence/provider-reset-before.txt`), provider after (`archive:docs/mol185-evidence/provider-reset-after.txt`), retry before (`archive:docs/mol185-evidence/submission-retry-before.txt`), retry after (`archive:docs/mol185-evidence/submission-retry-after.txt`).

EOF sources: matched baseline (`archive:docs/mol185-evidence/json-terminal-before.txt`), candidate (`archive:docs/mol185-evidence/json-terminal-after.txt`). Baseline was rerun from an isolated archive of `26bd5a9d94ddf82da8c5a3993b5b07aeda4bc4b1` with the final nine-case test file and shared frozen dependencies; the shared working tree was not reverted.

Additional candidate-only controls, outside paired denominators: expanded typed retry (`archive:docs/mol185-evidence/submission-retry-expanded-after.txt`) 5/5 pass, 24 assertions; legacy pre-send/error preservation (`archive:docs/mol185-evidence/submission-retry-legacy-after.txt`) 5/5 pass, 28 assertions. Do not depict unequal test sets as a paired improvement.

## Observed behavioral changes

| Measurement | Baseline | Candidate |
| --- | --- | --- |
| Provider failed stream, QA / Full | Downstream open at 2-second harness deadline | Downstream aborted |
| Provider sibling and subsequent request | Complete | Complete |
| Provider process after fault | Alive | Alive |
| Provider upstream submissions per request | 1 | 1 |
| Typed failure, send_activated: browser starts / Send activations | 2 / 2 | 1 / 1 |
| Typed failure, accepted: browser starts / accepted submissions | 2 / 2 | 1 / 1 |
| Typed failure, prepared: browser starts / Send activations | 2 / 0 | 2 / 0 |

The provider baseline defect is stalled downstream termination; process survival and no replay are invariants, not newly measured improvements. Default AF_UNIX transport was blocked by sandbox EPERM and remains unverified. Live calls: 0. GPU: 0.

## Transport boundary sketch

```mermaid
sequenceDiagram
    participant C as Test client
    participant P as Provider child
    participant U as Synthetic upstream
    C->>P: POST with stable request identity
    P->>U: One forwarded submission
    U-->>P: Headers and partial SSE
    P-->>C: Partial output (not completion)
    U--xP: Upstream response reset
    P--xC: Candidate closes failed response
    Note over P: Child remains alive; no automatic replay
    C->>P: Independent sibling / subsequent request
    P->>U: Independent submission
    U-->>P: Explicit completion
    P-->>C: Healthy response completes
```

The sequence illustrates synthetic evidence, not a production trace. Shared identity and Steer/Rewind policy remain coordinated with MOL-184.
