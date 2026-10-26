import { expect, test } from "bun:test";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

function interrupted(partial = false): CodexParsedRequest {
  return { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "xhigh" },
    context: { messages: [
      { role: "user", content: "Original task: write exactly once, then explain interruption safety. Do not repeat that command.", timestamp: 1 },
      { role: "assistant", content: partial ? [{ type: "text", text: "An unfinished explanation" }] : [], phase: "final_answer", timestamp: 2 },
      { role: "user", content: "<turn_aborted>\nThe user interrupted the previous turn on purpose. Commands may have partially executed.\n</turn_aborted>", timestamp: 3 },
      { role: "user", content: "go on", timestamp: 4 },
    ] }, _rawBody: { input: [], marker: "unchanged native authority" } };
}

for (const partial of [false, true]) {
  test(`interrupted ${partial ? "partial text" : "tool-call"} keeps the original task, not only the abort suffix`, () => {
    const source = interrupted(partial);
    const result = retainedConversationResumeRequest(source)!;
    expect(result.context.messages).toEqual(source.context.messages);
    expect(result._rawBody).toBe(source._rawBody);
    expect(result.context.messages.at(-1)?.content).toBe("go on");
  });
}

test("a completed reply after the interruption restores ordinary suffix-only continuation", () => {
  const source = interrupted();
  source.context.messages.push({ role: "assistant", content: [{ type: "text", text: "The task is finished" }], phase: "final_answer", timestamp: 5 },
    { role: "user", content: "A genuinely new task", timestamp: 6 });
  expect(retainedConversationResumeRequest(source)!.context.messages).toEqual([source.context.messages.at(-1)!]);
});

test("Full prompt retains the real goal and says neither interrupted nor not_found proves no side effect", () => {
  const source = interrupted(), resumed = retainedConversationResumeRequest(source)!;
  const prompt = compileChatGptWebPrompt(resumed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false }, "turn_" + "a".repeat(32));
  expect(prompt.text).toContain("Original task: write exactly once");
  expect(prompt.text).toContain("Do not repeat that command");
  expect(prompt.text).toContain("An interrupted result or not_found receipt does not prove the original action never ran.");
  expect(prompt.text).toContain("Missing replies and unknown outcomes never authorize redispatch of past commands or input.");
  expect(prompt.text).toContain("to read retained receipts only; it never executes commands or sends stdin.");
});
