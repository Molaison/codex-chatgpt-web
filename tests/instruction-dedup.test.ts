import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalConversationHistory, chatGptConversationKey, retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { ChatGptConversationStore, hasAcceptedChatGptInstructions } from "../src/adapters/chatgpt-web/conversation-persistence";
import { chatGptInstructionFingerprint, chatGptInstructionResumeRequest, compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false };
const token = "turn_" + "a".repeat(32);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const system = "SYSTEM_SENTINEL " + "Follow the workspace rules. ".repeat(300);
const developer = "DEVELOPER_SENTINEL: use only authorized local tools.";
const agents = "# AGENTS.md instructions\n" + "Preserve existing work. ".repeat(300);

function request(input: unknown[], instructions = system, thread = "thread-one"): CodexParsedRequest {
  return parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions, input, reasoning: { effort: "low" },
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "turn-one" }) } });
}
const initial = () => [
  { role: "developer", content: developer },
  { role: "user", content: agents },
  { role: "user", content: "Remember marker ORCHID." },
];
const followup = () => [...initial(), { role: "assistant", content: "ORCHID remembered." },
  { role: "user", content: "Reply with that marker." }];
const envelope = (text: string) => JSON.parse(text.match(/<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/)![1]!);
function compile(parsed: CodexParsedRequest, includeInstructions = true) {
  return compileChatGptWebPrompt(parsed, capabilities, token, {
    importCodexPrompt: true, includeSystemPrompt: includeInstructions, continuation: !includeInstructions,
  });
}
function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "instructions-dedup-")); roots.push(root);
  return { root, store: new ChatGptConversationStore(root, "isolated-account") };
}

test("first prompt carries full instructions; existing resume suffix sends exactly the new user record", () => {
  const first = compile(request(initial()));
  expect(envelope(first.text).system).toEqual([system]);
  expect(first.text).toContain("AGENTS.md");
  expect(first.text).toContain(developer);
  const parsed = request(followup());
  const original = structuredClone(parsed);
  const resume = retainedConversationResumeRequest(parsed)!;
  expect(resume.context.messages).toHaveLength(1);
  const next = compile(chatGptInstructionResumeRequest(parsed, resume, false), false);
  expect(envelope(next.text)).toMatchObject({ system: [], messages: [{ role: "user", content: "Reply with that marker." }] });
  expect(next.text).not.toMatch(/SYSTEM_SENTINEL|DEVELOPER_SENTINEL|AGENTS.md|Local access follows|sandbox and approval rules/);
  expect(next.text.match(new RegExp(token, "g"))).toHaveLength(1);
  expect(next.turnToken).toBe(token);
  expect(parsed).toEqual(original);
  console.log("INSTRUCTION_PROMPT_BYTES " + JSON.stringify([
    { turn: "first", before: Buffer.byteLength(first.text), after: Buffer.byteLength(first.text), records: envelope(first.text).messages.length },
    { turn: "followup", before: Buffer.byteLength(compile(resume).text), after: Buffer.byteLength(next.text),
      recordsBefore: envelope(compile(resume).text).messages.length, recordsAfter: envelope(next.text).messages.length },
  ]));
});

test("tool continuation keeps the original call result without old instructions or a duplicate tool invocation", () => {
  const parsed = request([...initial(),
    { type: "function_call", call_id: "call-original", name: "exec_command", arguments: '{"cmd":"printf ORCHID"}' },
    { type: "function_call_output", call_id: "call-original", output: "exit 0: ORCHID" },
  ]);
  const resume = retainedConversationResumeRequest(parsed)!;
  expect(resume.context.messages.map(message => message.role)).toEqual(["toolResult"]);
  const next = compile(chatGptInstructionResumeRequest(parsed, resume, false), false);
  expect(envelope(next.text).messages).toEqual([{
    role: "tool_result", tool_call_id: "call-original", tool_name: "exec_command", is_error: false, content: "exit 0: ORCHID",
  }]);
  expect(next.text).not.toContain("AGENTS.md");
  expect(next.text).not.toContain('"type":"tool_call"');
  expect(next.turnToken).toBe(token);
  console.log("INSTRUCTION_TOOL_BYTES " + JSON.stringify({
    before: Buffer.byteLength(compile(resume).text), after: Buffer.byteLength(next.text), records: 1,
  }));
});

test("fingerprints track instructions and contract semantics, not timestamps, user text, or broker tokens", () => {
  const parsed = request(initial());
  const fingerprint = chatGptInstructionFingerprint(parsed, capabilities);
  expect(chatGptInstructionFingerprint(request(followup()), capabilities)).toBe(fingerprint);
  const retimed = structuredClone(parsed);
  retimed.context.messages.forEach(message => { message.timestamp += 10000; });
  expect(chatGptInstructionFingerprint(retimed, capabilities)).toBe(fingerprint);
  expect(chatGptInstructionFingerprint(request(initial(), system + " Changed"), capabilities)).not.toBe(fingerprint);
  const developerChange = request([...initial(), { role: "developer", content: "New permission boundary." }]);
  expect(chatGptInstructionFingerprint(developerChange, capabilities)).not.toBe(fingerprint);
  expect(chatGptInstructionFingerprint(parsed, capabilities, { completedNativeReceiptRecovery: true })).not.toBe(fingerprint);
  const controls = structuredClone(parsed);
  controls.options.verbosity = "high";
  expect(chatGptInstructionFingerprint(controls, capabilities)).not.toBe(fingerprint);
  const tools = structuredClone(parsed);
  tools.context.tools = [{ name: "new_tool", description: "Current schema", parameters: { type: "object" } }];
  expect(chatGptInstructionFingerprint(tools, capabilities)).not.toBe(fingerprint);
});

test("changed instructions reintroduce every developer record while preserving only the existing user suffix", () => {
  const parsed = request([...followup().slice(0, -1),
    { role: "developer", content: "NEW_DEVELOPER: read-only now." }, followup().at(-1)!], system + " Changed");
  const resume = retainedConversationResumeRequest(parsed)!;
  const next = compile(chatGptInstructionResumeRequest(parsed, resume, true));
  expect(envelope(next.text).system).toEqual([system + " Changed"]);
  expect(envelope(next.text).messages).toEqual([
    { role: "developer", content: developer },
    { role: "developer", content: "NEW_DEVELOPER: read-only now." },
    { role: "user", content: "Reply with that marker." },
  ]);
  expect(next.text).not.toContain("AGENTS.md");
});

test("accepted fingerprint restores after restart; absent legacy state sends a full contract once", () => {
  const { root, store } = storeFixture();
  const parsed = request(initial());
  const fingerprint = chatGptInstructionFingerprint(parsed, capabilities);
  const saved = store.bind("thread", store.reserve("thread"), "https://chatgpt.com/c/accepted");
  expect(hasAcceptedChatGptInstructions(saved, fingerprint)).toBeFalse();
  const committed = store.recordHistory("thread", saved, canonicalConversationHistory(parsed)!, fingerprint);
  expect(hasAcceptedChatGptInstructions(committed, fingerprint)).toBeTrue();
  const restarted = new ChatGptConversationStore(root, "isolated-account").lookup("thread");
  expect(hasAcceptedChatGptInstructions(restarted, fingerprint)).toBeTrue();
  expect(hasAcceptedChatGptInstructions(restarted, "b".repeat(64))).toBeFalse();
  const legacy = store.recordHistory("thread", committed, canonicalConversationHistory(parsed)!);
  expect(hasAcceptedChatGptInstructions(legacy, fingerprint)).toBeFalse();
  expect(legacy.instructionFingerprint).toBeUndefined();
  const resume = retainedConversationResumeRequest(request(followup()))!;
  const full = compile(chatGptInstructionResumeRequest(request(followup()), resume, true));
  expect(full.text).toContain(system);
  expect(full.text).toContain(developer);
  expect(full.text).toContain("sandbox and approval rules");
});

test("legacy writer advancing history cannot reuse an earlier instruction checkpoint", () => {
  const { store } = storeFixture();
  const parsed = request(initial());
  const fingerprint = chatGptInstructionFingerprint(parsed, capabilities);
  const saved = store.bind("thread", store.reserve("thread"), "https://chatgpt.com/c/accepted");
  store.recordHistory("thread", saved, canonicalConversationHistory(parsed)!, fingerprint);
  const path = join(store.directory, readdirSync(store.directory)[0]!);
  const legacyWrite = JSON.parse(readFileSync(path, "utf8"));
  legacyWrite.history = canonicalConversationHistory(request(followup()))!;
  writeFileSync(path, JSON.stringify(legacyWrite));
  expect(hasAcceptedChatGptInstructions(store.lookup("thread"), fingerprint)).toBeFalse();
});

test("fresh fork, compaction epoch, and recovery start with independent instruction state", () => {
  const { store } = storeFixture();
  const parsed = request(initial());
  const key = chatGptConversationKey(parsed, "isolated")!;
  const fingerprint = chatGptInstructionFingerprint(parsed, capabilities);
  const saved = store.bind(key, store.reserve(key), "https://chatgpt.com/c/original");
  store.recordHistory(key, saved, canonicalConversationHistory(parsed)!, fingerprint);
  const child = request(initial(), system, "fork-child");
  expect(chatGptConversationKey(child, "isolated")).not.toBe(key);
  expect(hasAcceptedChatGptInstructions(store.lookup(chatGptConversationKey(child, "isolated")!), fingerprint)).toBeFalse();
  const compacted = request([{ type: "context_compaction" }, ...initial()]);
  expect(chatGptConversationKey(compacted, "isolated")).not.toBe(key);
  expect(compile(compacted).text).toContain(system);
  const recovered = store.recover(key, saved);
  expect(recovered.instructionFingerprint).toBeUndefined();
  expect(hasAcceptedChatGptInstructions(recovered, fingerprint)).toBeFalse();
});

test("ambiguous reservation or invalid checkpoint never advances accepted instruction state", () => {
  const { store } = storeFixture();
  const pending = store.reserve("thread");
  expect(hasAcceptedChatGptInstructions(pending, "a".repeat(64))).toBeFalse();
  expect(() => store.recordHistory("thread", pending, ["b".repeat(64)], "a".repeat(64))).toThrow();
  expect(store.read("thread")?.instructionFingerprint).toBeUndefined();
  store.cancelBeforeSend("thread", pending);
  expect(store.read("thread")).toBeUndefined();
});

test("QA compilation ignores the new instruction-dedup controls", () => {
  const parsed = request(followup());
  const chat = { ...capabilities, localToolsEnabled: false };
  const normal = compileChatGptWebPrompt(parsed, chat, undefined, { importCodexPrompt: false });
  const changed = compileChatGptWebPrompt(parsed, chat, undefined, {
    importCodexPrompt: false, includeSystemPrompt: false, continuation: true,
  });
  expect(changed).toEqual(normal);
});

test("compaction and native receipt recovery never inherit instruction-omission controls", () => {
  const parsed = request(initial());
  const compacted = compile({ ...parsed, _compactionRequest: true }, false);
  expect(compacted.text).toContain(system);
  expect(compacted.text).toContain("history-compaction checkpoint");
  const recovered = compileChatGptWebPrompt(parsed, capabilities, token, {
    importCodexPrompt: true, includeSystemPrompt: false, continuation: true, completedNativeReceiptRecovery: true,
  });
  expect(recovered.text).toContain(system);
  expect(recovered.text).toContain("verified against durable receipts");
});

test("removing an earlier output format changes the fingerprint and refreshes the contract", () => {
  const parsed = request(followup());
  const strict = structuredClone(parsed);
  strict.options.outputFormat = { type: "json_schema", name: "result", strict: true, schema: { type: "object" } };
  expect(chatGptInstructionFingerprint(parsed, capabilities)).not.toBe(chatGptInstructionFingerprint(strict, capabilities));
  const resumed = retainedConversationResumeRequest(parsed)!;
  const changed = compileChatGptWebPrompt(chatGptInstructionResumeRequest(parsed, resumed, true), capabilities, token, {
    importCodexPrompt: true, replaceInstructions: true,
  });
  expect(changed.text).toContain("an earlier output schema or verbosity setting is no longer active");
});
