import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const agents = "# AGENTS.md instructions for /isolated\n\n<INSTRUCTIONS>\nRuntime policy.\n</INSTRUCTIONS>";
const environment = "<environment_context><cwd>/isolated</cwd><shell>bash</shell></environment_context>";
const question = "Reply with exactly QA_SOURCE_NONCE.";
function request(kinds?: string[]) {
  return { model: CHATGPT_WEB_MODEL_ID, input: [
    { type: "message", role: "user", content: [
      { type: "input_text", text: agents }, { type: "input_text", text: environment },
    ], ...(kinds === undefined ? {} : { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } }) },
    { type: "message", role: "user", content: question,
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } },
  ] };
}
const compile = (body: unknown) => compileChatGptWebPrompt(parseRequest(body), capabilities, undefined, { importCodexPrompt: false });

test("real native runtime kinds leave exactly the human question without modifying input", () => {
  const body = request(["agents_md.instructions", "environments.environment_context"]);
  const original = structuredClone(body);
  expect(compile(body)).toEqual({ text: question, images: [] });
  expect(body).toEqual(original);
});

for (const kind of ["user.text", "unknown.future.kind"]) {
  test(`an identical human example with ${kind} retains both original parts`, () => {
    expect(compile(request([kind, kind])).text).toBe(`User:\n${agents}\n${environment}\n\nUser:\n${question}`);
  });
}

test("unattributed or misaligned runtime-shaped input rejects without guessing or adding prompt", () => {
  for (const kinds of [undefined, [], ["agents_md.instructions"]]) {
    try { compile(request(kinds)); throw new Error("ambiguous context accepted"); }
    catch (error: any) {
      expect(error.code).toBe("chatgpt_chat_provenance_required");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain("no message was sent");
    }
  }
});

test("malformed source indexes preserve a human environment and adjacent question whole", () => {
  const body = request(["environments.environment_context"]);
  body.input[0]!.content = [{ type: "input_text", text: environment }, { type: "input_text", text: "Explain this XML." }];
  expect(compile(body).text).toContain(environment + "\nExplain this XML.");
});

test("explicit human environment and AGENTS discussion survive history projection", () => {
  const body = request(["user.text", "user.text"]);
  body.input.splice(1, 0, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Earlier answer" }] } as any);
  const result = compile(body);
  expect(result.text).toContain(environment);
  expect(result.text).toContain("Assistant:\nEarlier answer");
  expect(result.text).toEndWith(question);
});

test("mixed source parts retain human text, image and file in their original order", () => {
  const body = { model: CHATGPT_WEB_MODEL_ID, input: [{ role: "user", content: [
    { type: "input_text", text: agents }, { type: "input_text", text: environment },
    { type: "input_image", image_url: "https://example.test/qa.png", detail: "high" },
    { type: "input_file", filename: "notes.txt", file_data: "data:text/plain;base64,YQ==" },
    { type: "input_text", text: question },
  ], internal_chat_message_metadata_passthrough: { content_item_kinds: [
    "agents_md.instructions", "user.text", "user.image", "user.file", "user.text",
  ] } }] };
  const result = compile(body);
  expect(result.text).toBe(`${environment}\n[Attached image: chatgpt-input-image-1]\n[Attached file: notes.txt]\n${question}`);
  expect(result.images).toEqual([{ ref: "chatgpt-input-image-1", imageUrl: "https://example.test/qa.png", detail: "high" }]);
  expect(result.files).toEqual([{ type: "file", filename: "notes.txt", fileData: "data:text/plain;base64,YQ==" }]);
});

test("Tools uses the same original runtime context regardless of the Chat projection", () => {
  const body = request(["agents_md.instructions", "environments.environment_context"]);
  const tagged = parseRequest(body), untagged = parseRequest(request());
  const options = { importCodexPrompt: true };
  const tools = { ...capabilities, localToolsEnabled: true };
  const first = compileChatGptWebPrompt(tagged, tools, "same-token", options);
  const second = compileChatGptWebPrompt(untagged, tools, "same-token", options);
  expect(first).toEqual(second);
  const context = JSON.parse(first.text.match(/<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/)![1]!);
  expect(context.messages[0].content).toBe(agents + "\n" + environment);
});
