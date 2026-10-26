import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { responseRequest } from "../src/server";
import { defaultConfig } from "../src/config";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

const agents = "# AGENTS.md instructions for /isolated\n\n<INSTRUCTIONS>\nRuntime policy.\n</INSTRUCTIONS>";
const environment = "<environment_context><cwd>/isolated</cwd><shell>bash</shell></environment_context>";
function body(stream: boolean) {
  const turn = randomUUID();
  return { model: "chatgpt-web/high", stream,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: randomUUID(), turn_id: turn }) },
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: agents }, { type: "input_text", text: environment },
    ] }, { type: "message", role: "user", content: "Explain this example.",
      internal_chat_message_metadata_passthrough: { turn_id: turn } }],
  };
}
const req = (value: unknown) => new Request("http://offline/v1/responses", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});
const config = () => ({ ...defaultConfig("browser-only"), accountId: randomUUID() });

for (const stream of [true, false]) test(`source ambiguity is HTTP400 before adapter creation, stream=${stream}`, async () => {
  let adapters = 0;
  const response = await responseRequest(req(body(stream)), config(), () => {
    adapters++; throw new Error("source ambiguity reached adapter creation");
  }, { rememberState: false });
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toMatchObject({ error: { code: "chatgpt_chat_provenance_required", retryable: false } });
  expect(adapters).toBe(0);
});

async function capture(value: unknown) {
  let parsed: CodexParsedRequest | undefined, adapters = 0;
  const response = await responseRequest(req(value), config(), () => {
    adapters++;
    return { async runTurn(input: CodexParsedRequest, _context: unknown, emit: (event: any) => void) {
      parsed = input;
      emit({ type: "error", code: "offline_boundary_reached", message: "No browser was started", retryable: false });
    } } as any;
  }, { rememberState: false });
  await response.text();
  return { response, parsed, adapters };
}

test("valid mixed human provenance reaches the real HTTP adapter boundary with all attachments", async () => {
  const value = body(false), turn = JSON.parse(value.client_metadata["x-codex-turn-metadata"]).turn_id;
  value.input = [{ type: "message", role: "user", content: [
    { type: "input_text", text: agents }, { type: "input_text", text: environment },
    { type: "input_image", image_url: "https://example.test/qa.png", detail: "high" },
    { type: "input_file", filename: "notes.txt", file_data: "data:text/plain;base64,YQ==" },
    { type: "input_text", text: "Explain this XML and attachments." },
  ], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [
    "agents_md.instructions", "user.text", "user.image", "user.file", "user.text",
  ] } }] as any;
  const result = await capture(value);
  expect(result.adapters).toBe(1);
  expect(result.parsed?._chatgptLocalTools).toBe(false);
  const compiled = compileChatGptWebPrompt(result.parsed!, {
    localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
  }, undefined, { importCodexPrompt: false });
  expect(compiled.text).toBe(`${environment}\n[Attached image: chatgpt-input-image-1]\n[Attached file: notes.txt]\nExplain this XML and attachments.`);
  expect(compiled.images).toEqual([{ ref: "chatgpt-input-image-1", imageUrl: "https://example.test/qa.png", detail: "high" }]);
  expect(compiled.files?.[0]?.fileData).toBe("data:text/plain;base64,YQ==");
});

test("pure runtime provenance cannot impersonate a current human message", async () => {
  const value = body(false), turn = JSON.parse(value.client_metadata["x-codex-turn-metadata"]).turn_id;
  value.input = [{ ...value.input[0], internal_chat_message_metadata_passthrough: {
    turn_id: turn, content_item_kinds: ["agents_md.instructions", "environments.environment_context"],
  } }] as any;
  const result = await capture(value);
  expect(result.adapters).toBe(0);
  expect(result.response.status).toBe(400);
});

test("human provenance does not authorize a different native turn", async () => {
  const value = body(false);
  value.input = [{ type: "message", role: "user", content: environment,
    internal_chat_message_metadata_passthrough: { turn_id: randomUUID(), content_item_kinds: ["user.text"] },
  }] as any;
  const result = await capture(value);
  expect(result.adapters).toBe(0);
  expect(result.response.status).toBe(400);
});

test("Chat source preflight does not reinterpret the configured Tools route", async () => {
  let adapters = 0;
  let parsed: CodexParsedRequest | undefined;
  const response = await responseRequest(req(body(false)), {
    ...defaultConfig("full"), accountId: randomUUID(), mcpProvider: "external-http",
  }, () => {
    adapters++;
    return { async runTurn(input: CodexParsedRequest, _context: unknown, emit: (event: any) => void) {
      parsed = input;
      emit({ type: "error", code: "offline_boundary_reached", message: "No tool was executed", retryable: false });
    } } as any;
  }, { rememberState: false });
  await response.text();
  expect(adapters).toBe(1);
  expect(parsed?._chatgptLocalTools).toBe(true);
});
