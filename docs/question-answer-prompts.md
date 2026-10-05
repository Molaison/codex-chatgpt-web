# Ordinary question and answer prompts

The automatic browser-only bridge passes importCodexPrompt=false to
compileChatGptWebPrompt. Direct callers that omit this option retain the legacy
Codex transport, including its existing tool and multipart behavior.

QA compilation keeps user text, image attachments and completed assistant text.
It excludes system/developer instructions, codex_skill messages, assistant
commentary/thinking/tool calls, tool results and inter-agent messages. It does not
strip paths, download links, code, or user-authored mentions of Codex. An isolated
environment envelope containing recognized runtime fields is removed; XML in
prose, code fences or an unknown XML shape is kept. Environment text parts can
be removed without deleting the question or images in the same user message.
Recognized fields include DEV's codex_dev_mode and subagents metadata (plain
lists, nested XML, or an empty self-closing subagents element).
To discuss an exact runtime envelope as data, use a code fence or introduce it
with explanatory text.

The newest ten user images are attached; older images receive an explicit
omission note. Data URLs stay out of prompt text. Genuine one-pixel user images
are preserved in this mode; legacy Codex sentinel handling is unchanged.

Explicit verbosity and JSON output schemas remain in the prompt. Strict schema
validation withholds user-facing text until the complete answer passes the
validator. The schema name is internal metadata, not a required prompt phrase.

QA compaction uses the same filtering, preserves the latest cumulative summary
and final compaction instruction, and trims only older conversation items when
necessary to fit the existing 110,000-byte JSON budget. It rejects a checkpoint
that cannot fit rather than dropping it. Replayed summaries keep their content
with a neutral preamble. Luna's required private checkpoint tail remains
available without a local-tools contract.

The QA compiler ignores legacy Bigger Context staging and skill-file imports,
even when those options are supplied. Ordinary questions remain single-message
inputs under normal browser limits. This prevents staged Codex contracts from
being reintroduced; it does not enlarge the QA input window. Legacy callers
retain Bigger Context unchanged.

Integration requirement: automatic index.ts compileOptionsFor must use
importCodexPrompt: mode.localTools. Forcing this flag on for _compactionRequest
bypasses the QA compaction filter. Explicit Full-harness and manual callers
keep their existing compilation path.

Verification (September 28, 2026):

    bun test tests/qa-prompts.test.ts tests/responses-text-controls.test.ts tests/prompt-contract.test.ts tests/prompt-history-metadata.test.ts tests/question-answer-bridge.test.ts

These execute the compiler and strict-output adapter with simulated browser
generation. Coverage includes XML/code preservation, metadata removal,
image-only questions, attachment overflow, empty requests, output schemas,
summary replay, bounded compaction, Luna and legacy compatibility. These tests
do not claim fresh live-browser inference; live acceptance belongs to the
deployment owner after installing the rebuilt runtime.
