export function parseChatGptSessionEffort(value: unknown): { effort?: string; mode: "temporary" | "persistent"; explicit: boolean } {
  const effort = typeof value === "string" && value.trim() ? value.trim() : undefined;
  const matched = effort && /^(none|minimal|low|medium|high|xhigh|max|ultra)-(temporary|persistent)$/.exec(effort);
  return matched ? { effort: matched[1], mode: matched[2] === "temporary" ? "temporary" : "persistent", explicit: true }
    : { effort, mode: "persistent", explicit: false };
}
