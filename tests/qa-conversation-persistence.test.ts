import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptConversationStore, canonicalSavedChatUrl } from "../src/adapters/chatgpt-web/conversation-persistence";
import { assertNewChatPage } from "../src/chatgpt-session";

const parentUrl = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const childUrl = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "qa-conversation-store-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function recordPath(store: ChatGptConversationStore): string {
  const files = readdirSync(store.directory);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  return join(store.directory, files[0]!);
}

describe("saved-chat URL validation", () => {
  test("keeps native project identity in saved URLs and requires the selected project", async () => {
    const id = "g-p-" + "a".repeat(32);
    const url = `https://chatgpt.com/g/${id}/c/abc`;
    expect(canonicalSavedChatUrl(url + "?secret=removed")).toBe(url);
    expect(canonicalSavedChatUrl(`https://chatgpt.com/g/${id}-project-name/c/abc`)).toBe(url);
    expect(canonicalSavedChatUrl(`https://chatgpt.com/g/${id}-何慧杰/c/abc`)).toBe(url);
    expect(canonicalSavedChatUrl(`https://chatgpt.com/g/${id}-%E4%BD%95%E6%85%A7%E6%9D%B0/c/abc`)).toBe(url);
    await assertNewChatPage({ url: () => `https://chatgpt.com/g/${id}/project` } as any, true, id);
    await expect(assertNewChatPage({ url: () => "https://chatgpt.com/" } as any, true, id)).rejects.toThrow();
    await expect(assertNewChatPage({ url: () => `https://chatgpt.com/g/${id}/project` } as any, false, id)).rejects.toThrow();
    const store = new ChatGptConversationStore(root, "project-account");
    store.bind("project-thread", store.reserve("project-thread"), url);
    expect(new ChatGptConversationStore(root, "project-account").lookup("project-thread")?.url).toBe(url);
  });
  test("canonicalizes a saved URL without retaining query secrets", () => {
    expect(canonicalSavedChatUrl(parentUrl + "/?model=gpt-6&private=value#message")).toBe(parentUrl);
  });
  for (const invalid of ["not-a-url", "http://chatgpt.com/c/a", "https://example.com/c/a",
    "https://chatgpt.com.evil.test/c/a", "https://name:password@chatgpt.com/c/a", "https://chatgpt.com/",
    "https://chatgpt.com/share/a", "https://chatgpt.com/g/g-a/c/b", "https://chatgpt.com/c/a/more",
    "https://chatgpt.com/c/%2F", parentUrl + "?temporary-chat=true"]) {
    test("rejects unsafe route " + invalid.replace("name:password@", "credentials@"), () => {
      expect(() => canonicalSavedChatUrl(invalid)).toThrow(expect.objectContaining({ code: "saved_conversation_url_invalid", retryable: false }));
    });
  }
});

test("recreated stores restore bound chats and preserve arbitrarily old mappings", () => {
  const store = new ChatGptConversationStore(root, "account-1");
  const claim = store.reserve("parent");
  expect(store.bind("parent", claim, parentUrl).url).toBe(parentUrl);
  const path = recordPath(store);
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.createdAt = "2000-01-01T00:00:00.000Z";
  writeFileSync(path, JSON.stringify(record));
  const restored = new ChatGptConversationStore(root, "account-1").lookup("parent");
  expect(restored?.url).toBe(parentUrl);
  expect(restored?.createdAt).toBe(record.createdAt);
});

test("a saved temporary chat stays saved when its project move fails and resumes the same identity", () => {
  const store = new ChatGptConversationStore(root, "account");
  const project = { id: "g-p-" + "a".repeat(32), name: "何慧杰" };
  store.bind("thread", store.reserve("thread"), parentUrl, project);
  const restarted = new ChatGptConversationStore(root, "account");
  expect(restarted.lookup("thread")).toMatchObject({ state: "bound", url: parentUrl, pendingProject: project });
  expect(() => restarted.finishProjectMove("thread", `https://chatgpt.com/g/${project.id}/c/wrong-id`)).toThrow();
  const moved = `https://chatgpt.com/g/${project.id}/c/${parentUrl.split("/c/")[1]}`;
  expect(restarted.finishProjectMove("thread", moved).url).toBe(moved);
  expect(store.lookup("thread")?.pendingProject).toBeUndefined();
});

test("accounts and new fork identities cannot inherit or overwrite another chat", () => {
  const first = new ChatGptConversationStore(root, "account-1");
  const second = new ChatGptConversationStore(root, "account-2");
  first.bind("parent", first.reserve("parent"), parentUrl);
  expect(second.lookup("parent")).toBeUndefined();
  expect(first.lookup("child")).toBeUndefined();
  first.bind("child", first.reserve("child"), childUrl);
  second.bind("parent", second.reserve("parent"), childUrl);
  expect(first.lookup("parent")?.url).toBe(parentUrl);
  expect(first.lookup("child")?.url).toBe(childUrl);
  expect(second.lookup("parent")?.url).toBe(childUrl);
});

test("interrupted first submission remains unresolved instead of opening a new chat", () => {
  const store = new ChatGptConversationStore(root, "account");
  store.reserve("thread");
  const path = recordPath(store);
  const before = readFileSync(path, "utf8");
  const restarted = new ChatGptConversationStore(root, "account");
  expect(() => restarted.lookup("thread")).toThrow(expect.objectContaining({ code: "saved_conversation_unresolved", retryable: false }));
  expect(() => restarted.reserve("thread")).toThrow(expect.objectContaining({ code: "saved_conversation_conflict" }));
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readdirSync(store.directory)).toHaveLength(1);
});

test("only the reservation owner can bind and the resulting URL is immutable", () => {
  const store = new ChatGptConversationStore(root, "account");
  const owner = store.reserve("thread");
  const intruder = store.reserve("other");
  expect(() => store.bind("thread", intruder, childUrl)).toThrow(expect.objectContaining({ code: "saved_conversation_conflict" }));
  expect(store.bind("thread", owner, parentUrl).url).toBe(parentUrl);
  expect(store.bind("thread", owner, parentUrl + "?model=changed").url).toBe(parentUrl);
  expect(() => store.bind("thread", owner, childUrl)).toThrow(expect.objectContaining({ code: "saved_conversation_conflict" }));
  expect(store.lookup("thread")?.url).toBe(parentUrl);
});

test("corrupt or mismatched mapping fails closed without replacing the file", () => {
  const store = new ChatGptConversationStore(root, "account");
  store.bind("thread", store.reserve("thread"), parentUrl);
  const path = recordPath(store);
  const valid = readFileSync(path, "utf8");
  const wrong = { ...JSON.parse(valid), account: "wrong-account" };
  for (const text of ["not json", JSON.stringify(wrong), JSON.stringify({ ...JSON.parse(valid), url: "https://chatgpt.com/" })]) {
    writeFileSync(path, text);
    expect(() => store.lookup("thread")).toThrow(expect.objectContaining({ code: "conversation_store_invalid", retryable: false }));
    expect(readFileSync(path, "utf8")).toBe(text);
  }
});

test("private atomic files contain hashes and canonical URL without temporary leftovers", () => {
  const store = new ChatGptConversationStore(root, "private-account-name");
  store.bind("private-thread-name", store.reserve("private-thread-name"), parentUrl);
  const path = recordPath(store);
  const raw = readFileSync(path, "utf8");
  expect(raw).not.toContain("private-account-name");
  expect(raw).not.toContain("private-thread-name");
  expect(JSON.parse(raw)).toMatchObject({ state: "bound", url: parentUrl });
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
  }
});

test("write failures are explicit nonretryable store errors", () => {
  const file = join(root, "not-a-directory");
  writeFileSync(file, "occupied");
  const store = new ChatGptConversationStore(file, "account");
  expect(() => store.reserve("thread")).toThrow(expect.objectContaining({ code: "conversation_store_unavailable", retryable: false }));
  expect(readFileSync(file, "utf8")).toBe("occupied");
});

test("a proven pre-Send failure releases only the caller's still-pending reservation", () => {
  const store = new ChatGptConversationStore(root, "account");
  const claim = store.reserve("thread");
  const other = store.reserve("other");
  expect(() => store.cancelBeforeSend("thread", other)).toThrow(expect.objectContaining({ code: "saved_conversation_conflict" }));
  store.cancelBeforeSend("thread", claim);
  expect(store.lookup("thread")).toBeUndefined();
  const retry = store.reserve("thread");
  store.bind("thread", retry, parentUrl);
  expect(() => store.cancelBeforeSend("thread", retry)).toThrow(expect.objectContaining({ code: "saved_conversation_conflict" }));
  expect(store.lookup("thread")?.url).toBe(parentUrl);
});
