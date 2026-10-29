import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalConversationHistory } from "../src/adapters/chatgpt-web/conversation-key";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import type { CodexParsedRequest } from "../src/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
const request = (texts: string[], extra = {}) => ({ _rawBody: { input: texts.map(text => ({ type: "message", role: "user", content: text })), ...extra },
  context: { messages: texts.map(text => ({ role: "user", content: [{ type: "text", text }] })) },
}) as unknown as CodexParsedRequest;

test("actual rewind removes an accepted message from the canonical prefix", () => {
  const first = canonicalConversationHistory(request(["keep"]))!;
  const extended = canonicalConversationHistory(request(["keep", "remove"]))!;
  const rewound = canonicalConversationHistory(request(["keep", "new question"]))!;
  expect(extended.slice(0, first.length)).toEqual(first);
  expect(rewound.slice(0, extended.length)).not.toEqual(extended);
  expect(JSON.stringify(extended)).not.toContain("remove");
});

test("incremental saved-response API usage is not mistaken for rewind", () => {
  expect(canonicalConversationHistory(request(["new"], { previous_response_id: "resp_old" }))).toBeUndefined();
});

test("paper-session increments are not mistaken for rewind", () => {
  const metadata = JSON.stringify({
    paper_registry_version: 2,
    paper_id: "doi:10.9999/example",
    paper_session_id: "local-session-a",
    paper_operation: "chat",
  });
  expect(canonicalConversationHistory(request(["follow-up"], {
    client_metadata: { "x-codex-turn-metadata": metadata },
  }))).toBeUndefined();
  expect(canonicalConversationHistory(request(["follow-up"], {
    client_metadata: {
      "x-codex-turn-metadata": metadata.replace('"chat"', '"history"'),
    },
  }))).toHaveLength(1);
});

test("new identical native instruction IDs are not text-deduplicated", () => {
  const a = request(["same"], { input: [{ type: "message", role: "user", id: "msg_old", content: "same" }] });
  const b = request(["same"], { input: [{ type: "message", role: "user", id: "msg_new", content: "same" }] });
  expect(canonicalConversationHistory(a)).not.toEqual(canonicalConversationHistory(b));
});

test("accepted history survives a new store instance and is archived on recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "r42-rewind-")); roots.push(root);
  const store = new ChatGptConversationStore(root, "isolated-account");
  const saved = store.bind("thread", store.reserve("thread"), "https://chatgpt.com/c/original");
  const history = canonicalConversationHistory(request(["keep", "remove"]))!;
  const recorded = store.recordHistory("thread", saved, history);
  expect(new ChatGptConversationStore(root, "isolated-account").lookup("thread")?.history).toEqual(history);
  const replacement = store.recover("thread", recorded);
  expect(replacement.history).toBeUndefined();
  expect(replacement.previous?.at(-1)?.url).toBe(saved.url);
  expect(() => store.recordHistory("thread", saved, history)).toThrow();
  const fresh = store.bind("thread", replacement, "https://chatgpt.com/c/replacement");
  expect(store.recordHistory("thread", fresh, history.slice(0, 1)).history).toEqual(history.slice(0, 1));
});

test("a malformed witness cannot be persisted as accepted history", () => {
  const root = mkdtempSync(join(tmpdir(), "r42-rewind-")); roots.push(root);
  const store = new ChatGptConversationStore(root, "isolated-account");
  const saved = store.bind("thread", store.reserve("thread"), "https://chatgpt.com/c/original");
  expect(() => store.recordHistory("thread", saved, ["raw prompt"])).toThrow();
  expect(store.lookup("thread")?.history).toBeUndefined();
});
