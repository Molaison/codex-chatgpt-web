import { z } from "zod";
import { PaperError } from "./paper-registry";
import { paperRecoveryIdentity, readLauncherPaperRecovery, type PaperRecoveryRead, type PaperRecoveryReader } from "./paper-recovery";

export interface PaperHistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  created_at: number | null;
}
export type PaperHistoryRead = PaperRecoveryRead;
export type PaperHistoryReader = PaperRecoveryReader;
export const readLauncherPaperHistory: PaperHistoryReader = readLauncherPaperRecovery;

function invalidHistory(): never {
  throw new PaperError("history_format_invalid", "Conversation history is not a verified complete active branch", 502);
}
const messageSchema = z.object({
  id: z.string().min(1),
  author: z.object({ role: z.string() }),
  content: z.unknown(),
  create_time: z.number().finite().nonnegative().nullish(),
  channel: z.string().nullish(),
  recipient: z.string().nullish(),
  hidden: z.boolean().optional(),
  metadata: z.object({
    is_visually_hidden_from_conversation: z.boolean().optional(),
    is_hidden: z.boolean().optional(),
    hidden: z.boolean().optional(),
    is_user_system_message: z.boolean().optional(),
    is_redacted: z.boolean().optional(),
  }).optional(),
});
const envelopeSchema = z.object({
  conversation_id: z.string().min(1),
  gizmo_id: z.string().min(1),
  title: z.string(),
  is_temporary_chat: z.literal(false),
  current_node: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  page_info: z.object({
    start_cursor: z.string().min(1),
    end_cursor: z.string().min(1),
    has_previous_page: z.literal(false),
    has_next_page: z.literal(false),
  }),
  context_truncation_continuation: z.null(),
});
const reasoningContentSchema = z.object({ content_type: z.enum(["thoughts", "reasoning_recap"]) });
const contentSchema = z.discriminatedUnion("content_type", [
  z.object({ content_type: z.literal("text"), parts: z.array(z.string()) }),
  z.object({ content_type: z.literal("multimodal_text"), parts: z.array(z.union([
    z.string(), z.object({ content_type: z.literal("image_asset_pointer") }),
  ])) }),
]);

/** The native GET returns the active branch in message order. Only visible text is exported;
 * page boundaries and the current head must establish a complete, persistent conversation.
 */
export function parsePaperHistory(value: unknown, conversationUrl: string): { title: string; messages: PaperHistoryMessage[] } {
  const identity = paperRecoveryIdentity(conversationUrl), parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return invalidHistory();
  const history = parsed.data;
  if (history.conversation_id !== identity.conversationId || history.gizmo_id !== identity.projectId
    || history.page_info.start_cursor !== history.messages[0]!.id
    || history.page_info.end_cursor !== history.current_node
    || history.messages.at(-1)!.id !== history.current_node) return invalidHistory();
  const ids = new Set<string>(), messages: PaperHistoryMessage[] = [];
  for (const message of history.messages) {
    if (ids.has(message.id)) return invalidHistory();
    ids.add(message.id);
    const role = message.author.role, metadata = message.metadata;
    if (role !== "user" && role !== "assistant"
      || message.hidden || metadata?.hidden || metadata?.is_hidden || metadata?.is_visually_hidden_from_conversation
      || metadata?.is_user_system_message || metadata?.is_redacted
      || message.channel != null && !["final", "commentary"].includes(message.channel)
      || message.recipient != null && message.recipient !== "all") continue;
    // Native reasoning nodes can omit both channel and hidden flags.
    if (role === "assistant" && reasoningContentSchema.safeParse(message.content).success) continue;
    const content = contentSchema.safeParse(message.content);
    if (!content.success) return invalidHistory();
    const text = content.data.parts.filter(part => typeof part === "string").join("\n");
    if (!text.trim()) continue;
    const createdAt = message.create_time == null ? null : Math.round(message.create_time * 1000);
    if (createdAt !== null && !Number.isSafeInteger(createdAt)) return invalidHistory();
    messages.push({ id: message.id, role, text, created_at: createdAt });
  }
  return { title: history.title, messages };
}
