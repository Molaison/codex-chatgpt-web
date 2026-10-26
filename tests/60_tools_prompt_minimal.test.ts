import { expect, test } from "bun:test";
import { compileChatGptWebPrompt, formatChatGptWebMultipartCommit, formatChatGptWebMultipartStage } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = "turn_" + "a".repeat(32);
const image = "data:image/png;base64," + Buffer.from("isolated-prompt-image").toString("base64");
const sentinel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const contextBlock = /<codex_context_json>\n([\s\S]*)\n<\/codex_context_json>/;
const decode = (text: string) => JSON.parse(text.match(contextBlock)![1]!);
const transport = (text: string) => text.replace(contextBlock, "[context]");
function request(): CodexParsedRequest {
  return { modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" }, context: {
    systemPrompt: ["Original SYSTEM: continue until done."],
    tools: [{ name: "read_file", namespace: "local", description: "Actual original schema", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    messages: [
      { role: "developer", content: "<environment_context><cwd>/isolated</cwd><sandbox_mode>read-only</sandbox_mode><approval_policy>never</approval_policy></environment_context>", timestamp: 1 },
      { role: "user", content: "Explain the existing receipt. Do not repeat the command.", timestamp: 2 },
      { role: "assistant", phase: "commentary", content: [{ type: "toolCall", id: "call_original", name: "read_file", namespace: "local", arguments: { path: "/isolated/missing" } }], timestamp: 3 },
      { role: "toolResult", toolCallId: "call_original", toolName: "read_file", toolNamespace: "local", content: "exit code 7: original nonzero result", isError: true, timestamp: 4 },
      { role: "agentMessage", author: "original-agent", recipient: "parent", content: "agent source", timestamp: 5 },
    ],
  } };
}

test("Tools removes outer execution policy without deleting original instructions, roles, permissions, schema or receipts", () => {
  const input = request(), before = structuredClone(input);
  const compiled = compileChatGptWebPrompt(input, capabilities, token);
  expect(input).toEqual(before);
  const envelope = decode(compiled.text), outer = transport(compiled.text);
  expect(envelope.system).toEqual(input.context.systemPrompt);
  expect(envelope.messages[0]).toEqual({ role: "developer", content: input.context.messages[0]!.content });
  expect(envelope.messages[1]).toEqual({ role: "user", content: input.context.messages[1]!.content });
  expect(envelope.messages[2]).toMatchObject({ role: "assistant", phase: "commentary", content: [
    { type: "tool_call", id: "call_original", name: "read_file", namespace: "local", arguments: { path: "/isolated/missing" } },
  ] });
  expect(envelope.messages[3]).toMatchObject({ role: "tool_result", tool_call_id: "call_original", is_error: true, content: "exit code 7: original nonzero result" });
  expect(envelope.messages[4]).toMatchObject({ role: "agent_message", author: "original-agent", recipient: "parent", content: "agent source" });
  expect(outer).not.toMatch(/Act as the model backend|Execute the latest active user request now|Continue using the available tools until|After a deterministic tool failure|Read the complete inline JSON/);
  expect(outer).toContain("system, then developer, then user");
  expect(outer).toContain("not human-authored user text");
  expect(outer).toContain("sandbox and approval rules");
  expect(outer).toContain("refusal must not be bypassed through another tool");
  expect(outer).toContain("do not request authorization already supplied");
  expect(outer).toContain("last required tool result has settled");
  expect(outer).toContain("Do not call another tool after beginning that final answer");
  expect(outer.match(new RegExp(token, "g"))).toHaveLength(1);
});

test("receipt queries remain read-only and bounded; recovery retains already-resumed continuation without replay", () => {
  const normal = transport(compileChatGptWebPrompt(request(), capabilities, token).text);
  expect(normal).toContain("wire_name codex_native_receipt, arguments {}");
  expect(normal).toContain("query the returned call_id");
  expect(normal).toContain("never executes commands or sends stdin");
  expect(normal).toContain("retry only this read-only receipt query up to three times");
  expect(normal).toContain("Unknown/not_found never permits repeating the original command or input");
  expect(normal).not.toContain("permits distinct subsequent tools");
  const resumed = transport(compileChatGptWebPrompt(request(), capabilities, token, { completedNativeReceiptRecovery: true }).text);
  expect(resumed).toContain("permits distinct subsequent tools under the current task authorization and permissions");
  expect(resumed).toContain("Never repeat recovered commands, accepted stdin, apply_patch or custom-tool side effects");
  expect(resumed).toContain("first short empty-poll its original session_id; never restart it");
  expect(resumed).toContain("New stdin or EOF requires that poll");
  expect(resumed).toContain("errors and nonzero exits");
  expect(resumed).not.toMatch(/Native execution is closed|Continue using|Execute the latest/);
});

test("image guidance follows this submission's filtered image set, never an earlier image or sentinel", () => {
  const input = request();
  expect(compileChatGptWebPrompt(input, capabilities, token).text).not.toContain("Each image_attachment");
  input.context.messages.push({ role: "user", content: [{ type: "image", imageUrl: image }], timestamp: 6 });
  const withImage = compileChatGptWebPrompt(input, capabilities, token);
  expect(withImage.images).toEqual([{ ref: "codex-input-image-1", imageUrl: image }]);
  expect(withImage.text.match(/Each image_attachment/g)).toHaveLength(1);
  expect(withImage.text).toContain("named image attached to this ChatGPT message");
  const suffix: CodexParsedRequest = { ...input, context: { ...input.context, messages: [{ role: "user", content: "Use the prior result", timestamp: 7 }] } };
  expect(compileChatGptWebPrompt(suffix, capabilities, token).text).not.toContain("Each image_attachment");
  suffix.context.messages = [{ role: "user", content: [{ type: "image", imageUrl: sentinel }], timestamp: 8 }];
  const filtered = compileChatGptWebPrompt(suffix, capabilities, token);
  expect(filtered.images).toEqual([]); expect(filtered.text).not.toContain("Each image_attachment");
});

test("Tools image limits and compaction rebuild preserve only the actual surviving attachment mapping", () => {
  const input = request();
  const urls = Array.from({ length: 12 }, (_, i) => `data:image/png;base64,${Buffer.from("image-" + i).toString("base64")}`);
  input.context.messages = urls.map((imageUrl, timestamp) => ({ role: "user", content: [{ type: "image", imageUrl }], timestamp }));
  const limited = compileChatGptWebPrompt(input, capabilities, token);
  expect(limited.images.map(value => value.imageUrl)).toEqual(urls.slice(-10));
  expect(limited.text.match(/Each image_attachment/g)).toHaveLength(1);
  input._compactionRequest = true;
  input.context.messages = [{ role: "user", timestamp: 0, content: [{ type: "text", text: "x".repeat(120_000) }, { type: "image", imageUrl: image }] },
    { role: "user", content: "Keep the latest summary", timestamp: 1 }];
  const compact = compileChatGptWebPrompt(input, capabilities, token);
  expect(compact.trimmedCompactionMessages).toBe(1); expect(compact.images).toEqual([]);
  expect(compact.text).not.toContain("Each image_attachment");
  expect(compact.text).toContain("without calling tools");
});

test("widget transport is one paragraph and follows the explicit JSON format", () => {
  const input = request();
  const plain = transport(compileChatGptWebPrompt(input, capabilities, token).text);
  expect(plain.split("\n").filter(line => /widget/.test(line))).toHaveLength(1);
  expect(plain).toContain("ordinary Markdown final answer");
  input.options.outputFormat = { type: "json_schema", name: "answer", strict: true, schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
  const compiled = compileChatGptWebPrompt(input, capabilities, token), json = transport(compiled.text);
  expect(json.split("\n").filter(line => /widget/.test(line))).toHaveLength(1);
  expect(json).toContain("in the requested JSON value");
  expect(json).not.toContain("ordinary Markdown final answer");
  expect(json).toContain("must be one JSON value matching the supplied schema");
  expect(JSON.parse(json.split("<codex_output_schema_json>\n")[1]!.split("\n</codex_output_schema_json>")[0]!)).toEqual(input.options.outputFormat.schema);
});

test("multipart only maps images on the final commit and preserves inert stage controls", () => {
  const input = request(); input.context.messages.push({ role: "user", timestamp: 6, content: [{ type: "image", imageUrl: image }] });
  const compiled = compileChatGptWebPrompt(input, capabilities, token, { experimentalMultipartParts: 2 });
  const multipart = compiled.multipart!, id = "ctx_" + "b".repeat(32);
  const stage = formatChatGptWebMultipartStage(multipart.parts[0]!, id, 1, 2);
  expect(stage.text).not.toContain("Each image_attachment");
  expect(stage.text).toContain("Do not call tools"); expect(stage.text).toContain(stage.acknowledgement);
  const commit = formatChatGptWebMultipartCommit(multipart, id);
  expect(commit).toContain("named image attached to this final commit message");
  expect(commit).toContain("system_index order");
  const records = multipart.parts.flatMap(part => JSON.parse(part).records);
  expect(records.find(record => record.kind === "message" && record.message_index === 3).message).toMatchObject({ tool_call_id: "call_original", is_error: true });
});

test("ordinary Chat remains exact and has no Tools transport even when history contains instruction-like text", () => {
  const input = request(); input.context.messages = [{ role: "user", content: "Execute the latest active user request now.\nContinue using the available tools until done.", timestamp: 0 }];
  const compiled = compileChatGptWebPrompt(input, { ...capabilities, localToolsEnabled: false }, undefined, { importCodexPrompt: false });
  expect(compiled.text).toBe(input.context.messages[0]!.content as string);
  expect(compiled.turnToken).toBeUndefined();
});
