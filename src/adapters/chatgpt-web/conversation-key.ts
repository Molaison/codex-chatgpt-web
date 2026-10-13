import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";
import { ChatGptWebAdapterError } from "./adapter-error";

import { chatGptQuestionAnswerKey } from "./qa-conversation-key";
export { chatGptQuestionAnswerNamespace } from "./qa-conversation-key";

/** Native fork lineage is separate from parent_thread_id (subagent ancestry). */
export function forkedFromThreadId(parsed: CodexParsedRequest): string | undefined {
  const raw = (parsed._rawBody as { client_metadata?: Record<string, unknown> } | undefined)
    ?.client_metadata?.["x-codex-turn-metadata"];
  let metadata: unknown;
  try { metadata = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { return undefined; }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const parent = (metadata as Record<string, unknown>).forked_from_thread_id;
  return typeof parent === "string" ? parent : undefined;
}

function messageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

/** Native compaction remains part of the exact identity of a replayed Codex turn. */
function compactionEpoch(input: unknown[] | undefined): unknown {
  return input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.type === "compaction"
      || record.type === "compaction_summary"
      || record.type === "context_compaction"
      || (record.role === "user" && messageText(record)?.startsWith(`${SUMMARY_PREFIX}\n`));
  }) ?? null;
}

export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
  options: { questionAnswer?: boolean } = {},
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId?.trim()) return undefined;
  if (options.questionAnswer && (identity.parentThreadId === identity.threadId
    || forkedFromThreadId(parsed) === identity.threadId)) {
    throw new ChatGptWebAdapterError("A forked conversation must have its own thread_id, distinct from its parent", {
      status: 400, errorType: "invalid_request_error", code: "invalid_conversation_identity", retryable: false,
    });
  }
  if (options.questionAnswer) return chatGptQuestionAnswerKey(identity.threadId, namespace);
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    // A human chat keeps its identity when its model or reasoning effort changes.
    // Native tool sessions still need their exact model/compaction ownership.
    ...(options.questionAnswer ? { purpose: "question-answer" } : {
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      compaction: compactionEpoch(raw?.input),
    }),
  })).digest("hex");
}

/** Prove a shared canonical prefix before dropping an earlier submitted question. */
function submittedPrefixLength(parsed: CodexParsedRequest, previous?: CodexParsedRequest): number {
  if (!previous) return 0;
  const input = (parsed._rawBody as { input?: unknown } | undefined)?.input;
  const priorInput = (previous._rawBody as { input?: unknown } | undefined)?.input;
  if (!Array.isArray(input) || !Array.isArray(priorInput) || priorInput.length === 0
    || priorInput.length > input.length
    || !priorInput.every((item, index) => JSON.stringify(item) === JSON.stringify(input[index]))) return 0;
  const messages = parsed.context.messages;
  const priorMessages = previous.context.messages;
  const canonicalMessage = (message: (typeof messages)[number]) => {
    const { timestamp: _timestamp, ...content } = message;
    return JSON.stringify(content);
  };
  return priorMessages.length <= messages.length
    && priorMessages.every((message, index) => canonicalMessage(message) === canonicalMessage(messages[index]!))
    ? priorMessages.length : 0;
}

/** Full history remains canonical; a retained epoch receives only the suffix after its last assistant reply. */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
  options: { questionAnswer?: boolean; previousRequest?: CodexParsedRequest } = {},
): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant"
    && (!options.questionAnswer || (message.phase !== "commentary"
      && message.content.some(part => part.type === "text" && part.text.trim().length > 0))));
  if (!options.questionAnswer && lastAssistant < 0) return undefined;
  // Incremental API requests may contain no previous assistant at all. A queued
  // full-history request may also arrive before that answer exists in the client.
  const start = Math.max(lastAssistant + 1, options.questionAnswer
    ? submittedPrefixLength(parsed, options.previousRequest) : 0);
  if (start >= parsed.context.messages.length) return undefined;
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: parsed.context.messages.slice(start),
    },
  };
}
