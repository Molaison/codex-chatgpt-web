import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildResponseJSON } from "../src/bridge";
import { chatGptPartialReceiptRound, chatGptTurnRoundKey } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

const trace = "original-trace";
const original = (): CodexParsedRequest => ({
  modelId: "chatgpt-web/gpt-5.6-tools-persist", stream: true, options: { reasoning: "xhigh" },
  context: { messages: [{ role: "user", content: "New fixture request", timestamp: 0 }] },
  _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "fixture-thread", turn_id: "fixture-turn" }) },
    input: [{ type: "message", id: "user-current", role: "user", content: "New fixture request",
      internal_chat_message_metadata_passthrough: { turn_id: "fixture-turn" } },
      { type: "function_call_output", call_id: "original-call", output: "One accepted side effect" }] },
});
const partial = "A repeated paragraph.\n\nA repeated paragraph.\n\nPartial";
const events: AdapterEvent[] = [
  { type: "assistant_boundary" },
  { type: "thinking_delta", thinking: "Observed original tool" },
  { type: "text_delta", text: "Checking the original receipt.", phase: "commentary" },
  { type: "assistant_boundary" },
  { type: "thinking_delta", thinking: "Read original receipt" },
  { type: "assistant_boundary" },
  { type: "thinking_delta", thinking: "Continue original answer" },
  { type: "text_delta", text: partial, phase: "final_answer" },
];
function fixture() {
  const parsed = original(), key = chatGptTurnRoundKey(parsed);
  const identity = createHash("sha256").update(JSON.stringify([trace, key])).digest("hex").slice(0, 32);
  const output = buildResponseJSON(events, parsed.modelId, { replayIdentity: identity }).output as any[];
  const item = output.find(v => v.type === "message" && v.phase === "final_answer");
  const receipt = { type: "message", id: item.id, role: "assistant", phase: item.phase,
    content: [{ type: "output_text", text: partial }] };
  const earlier = output.filter(v => v.id !== item.id).map(v => v.type === "reasoning"
    ? { type: "reasoning", id: v.id, summary: v.summary }
    : { type: "message", id: v.id, role: v.role, phase: v.phase,
      content: v.content.map((part: any) => ({ type: part.type, text: part.text })) });
  const retry = { ...parsed, _rawBody: { ...(parsed._rawBody as any), input: [...(parsed._rawBody as any).input, ...earlier, receipt] } };
  return { parsed, key, identity, receipt, retry, rounds: { [key]: { events } } };
}

test("Native's exact partial item receipt preserves response and item identity without deduplicating legitimate prose", () => {
  const f = fixture();
  expect(chatGptTurnRoundKey(f.retry)).not.toBe(f.key);
  expect(f.receipt.id).toBe(`msg_${f.identity}_4`);
  expect(chatGptPartialReceiptRound(f.retry, trace, f.rounds)).toBe(f.key);
  const replay = { ...f.retry, _chatgptObserverRoundKey: f.key };
  expect(chatGptTurnRoundKey(replay)).toBe(f.key);
  const next = buildResponseJSON([...events, { type: "text_delta", text: "\n\nActual continuation.", phase: "final_answer" }], f.parsed.modelId,
    { replayIdentity: f.identity }).output as any[];
  const message = next.find(v => v.type === "message" && v.phase === "final_answer");
  expect(message.id).toBe(f.receipt.id);
  expect(message.content[0].text).toBe(partial + "\n\nActual continuation.");
  expect(message.content[0].text.match(/A repeated paragraph\./g)).toHaveLength(2);
});

test("an exact received prefix of the same ID remains provable while the original journal grows", () => {
  const f = fixture();
  f.receipt.content[0].text = partial.slice(0, 25);
  expect(chatGptPartialReceiptRound(f.retry, trace, f.rounds)).toBe(f.key);
});

test("clear Native reasoning receipts before the partial item do not invent a new round; opaque content still does", () => {
  const f = fixture();
  const body = f.retry._rawBody as any;
  body.input = [...(f.parsed._rawBody as any).input,
    { type: "reasoning", id: `rs_${f.identity}_3` }, f.receipt];
  expect(chatGptPartialReceiptRound(f.retry, trace, f.rounds)).toBe(f.key);
  body.input[body.input.length - 2].encrypted_content = "opaque state";
  expect(chatGptPartialReceiptRound(f.retry, trace, f.rounds)).toBeUndefined();
});

test("a reasoning-only reconnect still proves the receipt for completed-state replacement", () => {
  const f = fixture();
  (f.retry._rawBody as any).input = [...(f.parsed._rawBody as any).input,
    { type: "reasoning", id: `rs_${f.identity}_3`, content: null, encrypted_content: null }];
  expect(chatGptTurnRoundKey(f.retry)).toBe(f.key);
  expect(chatGptPartialReceiptRound(f.retry, trace, f.rounds)).toBe(f.key);
  (f.retry._rawBody as any).input.at(-1).id += "foreign";
  expect(chatGptPartialReceiptRound(f.retry, trace, f.rounds)).toBeUndefined();
});

test("a foreign ID, edited prefix, changed phase or missing journal cannot erase input", () => {
  for (const change of [(x: any) => x.id += "foreign", (x: any) => x.content[0].text = "Edited " + partial,
    (x: any) => x.phase = "commentary"]) {
    const f = fixture(); change(f.receipt);
    expect(chatGptPartialReceiptRound(f.retry, trace, f.rounds)).toBeUndefined();
  }
  const f = fixture();
  expect(chatGptPartialReceiptRound(f.retry, "other-trace", f.rounds)).toBeUndefined();
  expect(chatGptPartialReceiptRound(f.retry, trace, {})).toBeUndefined();
});

test("new tool results and user instructions remain distinct physical rounds", () => {
  for (const item of [{ type: "function_call_output", call_id: "new-call", output: "new receipt" },
    { type: "message", id: "new-user", role: "user", content: "Steer the task" }]) {
    const f = fixture(); (f.retry._rawBody as any).input.push(item);
    expect(chatGptPartialReceiptRound(f.retry, trace, f.rounds)).toBeUndefined();
  }
});

test("compaction does not borrow the normal response's partial-output identity", () => {
  const f = fixture();
  expect(chatGptPartialReceiptRound({ ...f.retry, _compactionRequest: true }, trace, f.rounds)).toBeUndefined();
});
