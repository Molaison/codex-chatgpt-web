import { expect, test } from "bun:test";
import {
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET, chatGptPromptJsonBytes, compileChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_LUNA_CHECKPOINT_MARKER } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const user = (content: string): CodexMessage => ({ role: "user", content, timestamp: 1 });
const request = (messages: CodexMessage[]): CodexParsedRequest => ({
  modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "medium" },
  context: { systemPrompt: ["RUNTIME_SYSTEM"], messages },
});
const compile = (parsed: CodexParsedRequest, options: CompileChatGptWebPromptOptions = {}) =>
  compileChatGptWebPrompt(parsed, capabilities, undefined, { ...options, importCodexPrompt: false });

test.each([
  "Explain <environment_context> and Codex toolCall XML.",
  "<environment_context>This is an XML sample to translate.</environment_context>",
  "<environment_context><question>What does cwd mean?</question></environment_context>",
  "<environment_context><cwd>/example</cwd></environment_context>\nExplain that XML.",
  "<environment_context><cwd>/first</cwd></environment_context>\nCompare these.\n<environment_context><cwd>/second</cwd></environment_context>",
  "\u0060\u0060\u0060xml\n<environment_context><cwd>/example</cwd></environment_context>\n\u0060\u0060\u0060",
  'const xml = "<environment_context><shell>bash</shell></environment_context>";',
  "Explain <codex_dev_mode>All outer tool effects are explicitly simulated.</codex_dev_mode> as XML data.",
  "Explain <subagents><agent id=\"example\">Researcher</agent></subagents> as XML data.",
  "\u0060\u0060\u0060xml\n<environment_context><cwd>/example</cwd><subagents>- example: Researcher</subagents></environment_context>\n\u0060\u0060\u0060",
  "Preserve this handle: turn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and sandbox:/mnt/data/report.csv",
])("QA preserves user-authored XML/code verbatim: %s", text => {
  expect(compile(request([user(text)])).text).toBe(text);
});

test("QA removes complete runtime fragments while retaining adjacent question and image", () => {
  const parsed = request([
    { role: "developer", content: "RUNTIME_DEVELOPER", timestamp: 0 },
    { ...user("RUNTIME_SKILL"), origin: "codex_skill" } as CodexMessage,
    user("<environment_context>\n<cwd>/private</cwd><shell>bash</shell><current_date>2026-09-28</current_date>\n<filesystem><workspace_roots><root>/private</root></workspace_roots></filesystem>\n<codex_dev_mode>All outer tool effects are explicitly simulated.</codex_dev_mode>\n</environment_context>"),
    { role: "user", timestamp: 1, content: [
      { type: "text", text: "<environment_context><cwd>/private</cwd></environment_context>" },
      { type: "text", text: "这个图有什么？" },
      { type: "image", imageUrl: "https://example.test/user-photo.png", detail: "high" },
    ] },
  ]);
  const original = structuredClone(parsed);
  const result = compile(parsed, { experimentalSkillAttachments: true });
  expect(result.text).toBe("这个图有什么？\n[Attached image: chatgpt-input-image-1]");
  expect(result.images).toEqual([{ ref: "chatgpt-input-image-1", imageUrl: "https://example.test/user-photo.png", detail: "high" }]);
  expect(result.skillFiles).toBeUndefined();
  expect(parsed).toEqual(original);
});

test("QA retains completed and legacy answers but removes commentary, thinking and tool traffic", () => {
  const result = compile(request([
    user("First question"),
    { role: "assistant", phase: "commentary", content: [{ type: "text", text: "RUNTIME_PROGRESS" }], timestamp: 2 },
    { role: "assistant", content: [
      { type: "thinking", thinking: "RUNTIME_REASONING" },
      { type: "toolCall", id: "RUNTIME_CALL", name: "exec_command", arguments: { cmd: "RUNTIME_CMD" } },
      { type: "text", text: "Legacy answer includes sandbox:/mnt/data/file.csv" },
    ], timestamp: 3 },
    { role: "toolResult", toolCallId: "RUNTIME_CALL", toolName: "exec_command", content: "RUNTIME_RESULT", isError: false, timestamp: 4 },
    { role: "agentMessage", content: "RUNTIME_AGENT", timestamp: 5 },
    { role: "assistant", phase: "final_answer", content: [{ type: "text", text: "Final answer" }], timestamp: 6 },
    user("Next question"),
  ]));
  expect(result.text).toContain("User:\nFirst question");
  expect(result.text).toContain("Assistant:\nLegacy answer includes sandbox:/mnt/data/file.csv");
  expect(result.text).toContain("Assistant:\nFinal answer");
  expect(result.text).toEndWith("User:\nNext question");
  expect(result.text).not.toMatch(/RUNTIME_|exec_command|codex_context|Local tools unavailable/);
});

test.each([
  "<subagents>\n- 01900000-0000-0000-0000-000000000000: Researcher\n</subagents>",
  "<subagents><agent id=\"example\" name=\"Researcher\"><status>running</status></agent></subagents>",
  "<subagents />",
])("QA removes subagent metadata only inside a standalone runtime envelope: %s", subagents => {
  const result = compile(request([
    user("<environment_context>\n<cwd>/private</cwd><shell>bash</shell>\n" + subagents + "\n</environment_context>"),
    user("What is two plus two?"),
  ]));
  expect(result.text).toBe("What is two plus two?");
  expect(result.images).toEqual([]);
});

test("an image-only question, including a genuine one-pixel PNG, remains a question", () => {
  const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const result = compile(request([{ role: "user", content: [{ type: "image", imageUrl }], timestamp: 1 }]));
  expect(result.text).toBe("[Attached image: chatgpt-input-image-1]");
  expect(result.images[0]!.imageUrl).toBe(imageUrl);
  expect(result.text).not.toContain("base64");
});

test("image overflow drops only the oldest images and reindexes retained attachments", () => {
  const result = compile(request(Array.from({ length: 12 }, (_, index) => ({
    role: "user", timestamp: index, content: [{ type: "image", imageUrl: "https://example.test/image-" + index + ".png" }],
  }))));
  expect(result.images).toHaveLength(10);
  expect(result.images[0]).toMatchObject({ ref: "chatgpt-input-image-1", imageUrl: "https://example.test/image-2.png" });
  expect(result.images[9]).toMatchObject({ ref: "chatgpt-input-image-10", imageUrl: "https://example.test/image-11.png" });
  expect(result.text.match(/older image not attached/g)).toHaveLength(2);
});

test.each([[], [user(" \n\t")], [user("<environment_context><cwd>/private</cwd></environment_context>")]].map(messages => ({ messages })))(
  "QA rejects requests containing no question or image", ({ messages }) => {
    expect(() => compile(request(messages))).toThrow("does not contain a human question or image");
  },
);

test.each([2, 6] as const)("QA ignores legacy Bigger Context %d without importing its runtime contract", parts => {
  const parsed = request([user("Answer the question.")]);
  const result = compile(parsed, { experimentalMultipartParts: parts, experimentalSkillAttachments: true });
  expect(result.text).toBe("Answer the question.");
  expect(result.multipart).toBeUndefined();
  expect(result.skillFiles).toBeUndefined();
});

test("QA preserves explicit verbosity and JSON schema without importing a runtime role", () => {
  const parsed = request([user("Return the answer.")]);
  parsed.options.verbosity = "high";
  parsed.options.outputFormat = { type: "json_schema", name: "answer", strict: true,
    schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } };
  const result = compile(parsed);
  expect(result.text).toContain("Requested answer detail: high.");
  expect(result.text).toEndWith(JSON.stringify(parsed.options.outputFormat.schema));
  expect(result.text).not.toMatch(/Codex|RUNTIME_|tool|codex_/);
});

test("QA compaction uses the same filtering and keeps only conversational summary instructions", () => {
  const parsed = request([
    { role: "developer", content: "RUNTIME_DEVELOPER", timestamp: 0 },
    user("<environment_context><cwd>/private</cwd></environment_context>"),
    user("Our budget is 10 euros."),
    { role: "assistant", phase: "commentary", content: [{ type: "text", text: "RUNTIME_PROGRESS" }], timestamp: 2 },
    { role: "assistant", content: [{ type: "text", text: "I suggest the museum." }], timestamp: 3 },
    user(COMPACT_PROMPT),
  ]);
  parsed._compactionRequest = true;
  parsed.options.outputFormat = { type: "json_schema", name: "stale", strict: true, schema: { const: "OLD_OUTPUT_SCHEMA" } };
  const result = compile(parsed, { experimentalMultipartParts: 6, experimentalSkillAttachments: true });
  expect(result.text).toContain("Our budget is 10 euros.");
  expect(result.text).toContain("I suggest the museum.");
  expect(result.text).toContain(COMPACT_PROMPT);
  expect(result.text).not.toMatch(/RUNTIME_|\/private|OLD_OUTPUT_SCHEMA|Codex|codex_|Local tools/);
  expect(result.multipart).toBeUndefined();
});

test("QA replay strips the canonical tool-state summary preamble and preserves actual summary data", () => {
  const parsed = request([user(SUMMARY_PREFIX + "\n\nThe user chose two accounts; report is sandbox:/mnt/data/a.csv"), user("Continue.")]);
  const result = compile(parsed);
  expect(result.text).not.toContain(SUMMARY_PREFIX);
  expect(result.text).toContain("Previous conversation summary:\nThe user chose two accounts; report is sandbox:/mnt/data/a.csv");
});

test("QA compaction retains the cumulative summary and final instruction while bounding its payload", () => {
  const checkpoint = user(SUMMARY_PREFIX + "\nThe user prefers Chinese; keep the download link.");
  const parsed = request([user("old ".repeat(30_000)), checkpoint, user("recent ".repeat(20_000)), user(COMPACT_PROMPT)]);
  parsed._compactionRequest = true;
  const original = structuredClone(parsed);
  const result = compile(parsed);
  expect(chatGptPromptJsonBytes(result.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  expect(result.trimmedCompactionMessages).toBe(2);
  expect(result.text).toContain("The user prefers Chinese; keep the download link.");
  expect(result.text).toContain(COMPACT_PROMPT);
  expect(result.text).toContain("2 earlier history items were omitted");
  expect(parsed).toEqual(original);
});

test("QA compaction fails explicitly instead of discarding an oversized cumulative summary", () => {
  const parsed = request([user(SUMMARY_PREFIX + "\n" + "x".repeat(115_000)), user(COMPACT_PROMPT)]);
  parsed._compactionRequest = true;
  expect(() => compile(parsed)).toThrow("exceed the compaction message budget");
});

test("QA Luna keeps its required summary tail without importing local tools", () => {
  const parsed = request([user("What is the capital of France?")]);
  parsed.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
  const result = compileChatGptWebPrompt(parsed, { ...capabilities, solAvailable: false }, undefined, {
    importCodexPrompt: false, captureLunaCheckpoint: true,
  });
  expect(result.text).toContain("What is the capital of France?");
  expect(result.text).toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(result.text).toContain("Objective:, State:, Evidence:, Decisions:, and Pending:");
  expect(result.text).not.toMatch(/RUNTIME_|Codex Native|local tools|codex_context_json/);
});

test("direct legacy compilation still imports its original runtime contract", () => {
  const result = compileChatGptWebPrompt(request([user("Question")]), capabilities);
  expect(result.text).toContain("Act as the model backend for the Codex task");
  expect(result.text).toContain("RUNTIME_SYSTEM");
  expect(result.text).toContain("<codex_context_json>");
});
