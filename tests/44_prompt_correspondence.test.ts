import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID, CHATGPT_WEB_LUNA_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";

const chat = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

test.each(["low", "medium", "high", "xhigh", "max"])("Chat %s carries history as data without an adapter task directive", reasoning => {
  const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: reasoning }, input: [
    { role: "system", content: "INTERNAL_SYSTEM" },
    { role: "developer", content: "INTERNAL_DEVELOPER" },
    { role: "user", content: "Remember ORCHID." },
    { role: "assistant", content: "ORCHID remembered." },
    { role: "user", content: "Reply with the marker alone." },
  ] });
  const compiled = compileChatGptWebPrompt(parsed, chat, undefined, { importCodexPrompt: false });
  expect(compiled.text).toBe("User:\nRemember ORCHID.\n\nAssistant:\nORCHID remembered.\n\nUser:\nReply with the marker alone.");
  expect(compiled.images).toEqual([]);
  expect(compiled.turnToken).toBeUndefined();
});

test("Chat preserves the exact trusted delegated task without adding capability or answer instructions", () => {
  const task = "Explain <sample> & its meaning.\nReply with one sentence.";
  const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: [{
    type: "function_call_output", id: "delegated_44", name: "create_thread", namespace: "codex_tui",
    internal_chat_message_metadata_passthrough: { turn_id: "turn_44" },
    output: "<codex_delegation><source_thread_id>parent</source_thread_id><input>Explain &lt;sample&gt; &amp; its meaning.\nReply with one sentence.</input></codex_delegation>",
  }] });
  const compiled = compileChatGptWebPrompt(parsed, chat, undefined, { importCodexPrompt: false });
  expect(compiled.text).toBe("Delegated task:\n" + task);
  expect(compiled.turnToken).toBeUndefined();
});

test("Tools preserves original instructions, call identity, permissions and failure results", () => {
  const environment = "<environment_context><cwd>/test/work</cwd><approval_policy>never</approval_policy><sandbox_mode>read-only</sandbox_mode></environment_context>";
  const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions: "SYSTEM_SENTINEL", input: [
    { role: "developer", content: environment },
    { role: "user", content: "Explain the failed read. Do not repeat it." },
    { type: "function_call", call_id: "call_44", name: "read_file", arguments: '{"path":"/test/work/missing"}' },
    { type: "function_call_output", call_id: "call_44", output: "exit code 2: no such file" },
  ] });
  const compiled = compileChatGptWebPrompt(parsed, { ...chat, localToolsEnabled: true }, "turn_" + "a".repeat(32), { importCodexPrompt: true });
  const envelope = JSON.parse(compiled.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!);
  expect(envelope.system).toEqual(["SYSTEM_SENTINEL"]);
  expect(envelope.messages[0]).toEqual({ role: "developer", content: environment });
  expect(envelope.messages[1]).toEqual({ role: "user", content: "Explain the failed read. Do not repeat it." });
  expect(envelope.messages[2].content[0]).toMatchObject({ type: "tool_call", id: "call_44", name: "read_file", arguments: { path: "/test/work/missing" } });
  expect(envelope.messages[3]).toMatchObject({ role: "tool_result", tool_call_id: "call_44", content: "exit code 2: no such file" });
});


test("ordinary Chat rejects unsupported output controls and private summary injection before compilation", () => {
  for (const text of [{ verbosity: "high" }, { format: { type: "json_schema", name: "result", schema: { type: "object", properties: { value: { type: "string" } } } } }]) {
    const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: "EXACT USER", text });
    expect(() => compileChatGptWebPrompt(parsed, chat, undefined, { importCodexPrompt: false })).toThrow("cannot add output-control");
  }
  const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: "EXACT USER" });
  const luna = parseRequest({ model: CHATGPT_WEB_LUNA_MODEL_ID, input: "EXACT USER" });
  expect(() => compileChatGptWebPrompt(luna, { ...chat, solAvailable: false }, undefined, { importCodexPrompt: false, captureLunaCheckpoint: true })).toThrow("private-summary");
  expect(compileChatGptWebPrompt(luna, { ...chat, solAvailable: false }, undefined, { importCodexPrompt: false, captureLunaCheckpoint: false }).text).toBe("EXACT USER");
  expect(compileChatGptWebPrompt(parsed, chat, undefined, { importCodexPrompt: false }).text).toBe("EXACT USER");
});
