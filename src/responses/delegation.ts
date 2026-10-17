/** Native task delivery is a synthetic output, not an ordinary tool result. */
export function parseCodexDelegation(item: Record<string, unknown> | undefined): string | undefined {
  const nativeRoute = (item?.name === "send_message_to_thread" && item.namespace === "codex_app")
    || (item?.name === "create_thread" && item.namespace === "codex_tui");
  if (item?.type !== "function_call_output" || !nativeRoute || item.call_id !== undefined
    || typeof item.id !== "string" || !item.id || typeof item.output !== "string") return undefined;
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== "object" || !("turn_id" in metadata)
    || typeof metadata.turn_id !== "string" || !metadata.turn_id.trim()) return undefined;
  // The producer escapes &, < and >. Reject nested tags and malformed entities.
  const fields = /^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([^<>]+)<\/input>\s*<\/codex_delegation>$/.exec(item.output.trim());
  if (!fields || !fields.slice(1).every(text => text.trim() && !/&(?!amp;|lt;|gt;)/.test(text))) return undefined;
  return fields[2]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
