import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaPool } from "../src/qa-pool";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } from "../src/adapters/chatgpt-web/qa-conversation-key";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";

for (const format of ["json", "sse"] as const) {
  test(`paper ${format} capacity refusal preserves the upload and ready states`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paper-admission-"));
    const key = "e".repeat(32);
    const projectId = "g-p-" + "e".repeat(32);
    writeFileSync(join(root, "key"), key);
    const store = new ChatGptConversationStore(join(root, "conversations"), "account");
    let mode: "capacity" | "complete" | "generic" = "capacity";
    let sends = 0;
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json() as { client_metadata: Record<string, string> };
      if (mode !== "complete") {
        const error = { type: "rate_limit_error", code: mode === "capacity" ? "concurrency_limit_exceeded" : "rate_limit_exceeded", retryable: true, message: "capacity" };
        if (format === "json") return Response.json({ error }, { status: 429 });
        return new Response("data: " + JSON.stringify({ type: "response.failed", response: { status: "failed", error } }) + "\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      sends += 1;
      const identity = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!) as { thread_id: string };
      const nativeKey = chatGptQuestionAnswerKey(identity.thread_id, chatGptQuestionAnswerNamespace("account"));
      if (!store.lookup(nativeKey)) store.bind(nativeKey, store.reserve(nativeKey), `https://chatgpt.com/g/${projectId}/c/paper`);
      return Response.json({ id: `response-${sends}`, status: "completed", output: [] });
    } });
    const pool = createQaPool({
      host: "127.0.0.1", port: 0, databasePath: join(root, "sessions.sqlite"),
      clients: [{ id: "cpr", keyFile: join(root, "key") }],
      accounts: [{ id: "account", origin: backend.url.origin, models: ["standard"], sessionModes: true, conversationStoreDirectory: join(root, "conversations") }],
      projectRoutes: [{ name: "papers", sessionNamespace: "papers", accountId: "account", projectId }],
    });
    const paperId = `doi:10.1234/admission-${format}`;
    const request = (metadata: object, input: unknown = "resolve") => pool.fetch(new Request("http://pool/project/papers/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "standard", stream: format === "sse", input, client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } }),
    }));
    const resolve = async (token?: string) => {
      const response = await pool.fetch(new Request("http://pool/project/papers/v1/responses", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "standard", stream: false, input: "resolve", client_metadata: { "x-codex-turn-metadata": JSON.stringify({ paper_id: paperId, paper_operation: "resolve", paper_upload_token: token }) } }),
      }));
      const data = await response.json() as { output: Array<{ content: Array<{ text: string }> }> };
      expect(data).toHaveProperty("output");
      return JSON.parse(data.output[0]!.content[0]!.text) as { status: string; upload_token?: string; thread_id: string; conversation_url?: string };
    };
    try {
      const original = await resolve();
      const pdf = Buffer.from("%PDF-1.4\nadmission " + format + "\n%%EOF");
      const input = [{ role: "user", content: [
        { type: "input_file", filename: "paper.pdf", file_data: "data:application/pdf;base64," + pdf.toString("base64") },
        { type: "input_text", text: "question" },
      ] }];
      const metadata = { paper_id: paperId, paper_operation: "chat", paper_upload_token: original.upload_token, paper_pdf_sha256: createHash("sha256").update(pdf).digest("hex") };
      const rejected = await request(metadata, input);
      expect(rejected.status).toBe(format === "json" ? 429 : 200);
      await rejected.text();
      expect(sends).toBe(0);
      expect(await resolve(original.upload_token)).toEqual(original);
      mode = "complete";
      await (await request(metadata, input)).text();
      expect(sends).toBe(1);
      const ready = await resolve();
      expect(ready.status).toBe("ready");
      expect(ready.thread_id).toBe(original.thread_id);
      mode = "capacity";
      await (await request({ paper_id: paperId, paper_operation: "chat" }, "follow up")).text();
      expect(await resolve()).toEqual(ready);
      expect(sends).toBe(1);
      mode = "generic";
      await (await request({ paper_id: paperId, paper_operation: "chat" }, "follow up")).text();
      expect((await resolve()).status).toBe("uncertain");
    } finally {
      pool.close();
      backend.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a full retained-session registry rejects before starting and retains exact replay", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 1);
  let starts = 0;
  const start = () => {
    starts += 1;
    return { mode: "read-only" as const, browser: Promise.resolve("answer"), physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel: () => {} };
  };
  try {
    const first = sessions.getOrCreate("first", start);
    await first.browserOutcome;
    await first.physicalSettlement;
    let rejection: unknown;
    try { sessions.getOrCreate("second", start); } catch (error) { rejection = error; }
    expect(rejection).toMatchObject({ status: 429, code: "concurrency_limit_exceeded", retryable: true });
    expect(starts).toBe(1);
    expect(sessions.getOrCreate("first", start)).toBe(first);
    expect(starts).toBe(1);
  } finally { sessions.clear(); }
});
