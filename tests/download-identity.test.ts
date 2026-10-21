import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { collectGeneratedChatGptFiles } from "../src/adapters/chatgpt-web/downloads";
import { serveGeneratedFile, storeGeneratedFile } from "../src/generated-files";

type Card = { filename: string; text: string; source?: string; fail?: boolean };

async function collect(cards: Card[]) {
  const events = new EventEmitter();
  const page = Object.assign(events, {
    async evaluateHandle(create: () => unknown) {
      const state = create();
      return { evaluate: async (read: (value: unknown, arg: unknown) => unknown, arg: unknown) => read(state, arg), dispose: async () => {} };
    },
    async waitForFunction() {},
  });
  const rows = {
    count: async () => cards.length,
    nth(index: number) {
      const card = cards[index]!;
      return {
        evaluate: async () => card.filename,
        locator: () => ({
          count: async () => 1,
          async click() {
            if (card.fail) throw new Error("download failed");
            if (card.source) events.emit("request", { url: () => card.source });
            const blob = URL.createObjectURL(new Blob([card.text], { type: "text/csv" }));
            events.emit("download", { url: () => blob, suggestedFilename: () => card.filename, cancel: async () => {} });
            URL.revokeObjectURL(blob);
          },
        }),
      };
    },
  };
  return collectGeneratedChatGptFiles(page as unknown as Page, { locator: () => rows } as unknown as Locator);
}

const source = (id: string, signature = "one") => `https://chatgpt.com/backend-api/estuary/content?id=${id}&fn=report.csv&sig=${signature}`;

test("same-named distinct artifacts survive collection, storage and independent download", async () => {
  const files = await collect([
    { filename: "report.csv", text: "first", source: source("file_a") },
    { filename: "report.csv", text: "second", source: source("file_b") },
  ]);
  expect(files).toHaveLength(2);
  const root = mkdtempSync(join(tmpdir(), "same-name-downloads-"));
  try {
    const urls = files.map(file => storeGeneratedFile(root, "http://127.0.0.1:12345", file.filename, file.mime, file.bytes));
    expect(new Set(urls).size).toBe(2);
    expect(await serveGeneratedFile(new Request(urls[0]!), root)!.text()).toBe("first");
    expect(await serveGeneratedFile(new Request(urls[1]!), root)!.text()).toBe("second");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repeated file ID deduplicates even when its download signature changes", async () => {
  const files = await collect([
    { filename: "report.csv", text: "same", source: source("file_a", "one") },
    { filename: "report.csv", text: "same", source: source("file_a", "two") },
  ]);
  expect(files).toHaveLength(1);
  expect(files[0]!.sources).toHaveLength(2);
});

test("interpreter identity includes both the conversation and sandbox path", async () => {
  const endpoint = (conversation: string, signature: string) =>
    `https://chatgpt.com/backend-api/conversation/${conversation}/interpreter/download?sandbox_path=%2Fmnt%2Fdata%2Freport.csv&sig=${signature}`;
  const files = await collect([
    { filename: "report.csv", text: "same", source: endpoint("chat-a", "one") },
    { filename: "report.csv", text: "same", source: endpoint("chat-a", "two") },
    { filename: "report.csv", text: "same", source: endpoint("chat-b", "one") },
  ]);
  expect(files).toHaveLength(2);
  expect(files[0]!.sources).toHaveLength(2);
});

test("a repeated endpoint never hides changed bytes and separate identities stay separate", async () => {
  const files = await collect([
    { filename: "report.csv", text: "first", source: source("file_a") },
    { filename: "report.csv", text: "second", source: source("file_a") },
    { filename: "report.csv", text: "second", source: source("file_b") },
  ]);
  expect(files.map(file => new TextDecoder().decode(file.bytes))).toEqual(["first", "second", "second"]);
});

test("blob-only duplicates require equal names and bytes and partial failures remain errors", async () => {
  expect(await collect([
    { filename: "report.csv", text: "first" },
    { filename: "report.csv", text: "first" },
    { filename: "report.csv", text: "second" },
  ])).toHaveLength(2);
  const original = URL.createObjectURL;
  await expect(collect([
    { filename: "report.csv", text: "first" },
    { filename: "report.csv", text: "second", fail: true },
  ])).rejects.toThrow("download failed");
  expect(URL.createObjectURL).toBe(original);
});
