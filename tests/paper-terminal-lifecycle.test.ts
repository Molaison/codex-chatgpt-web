import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaPool } from "../src/qa-pool";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } from "../src/adapters/chatgpt-web/qa-conversation-key";

type CancelBehavior = "resolve" | "pending" | "reject";
type Upstream = { chunks: Uint8Array[]; cancel?: CancelBehavior; bind?: boolean; readError?: Error };
const encode = (value: string) => new TextEncoder().encode(value);
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const completed = frame({ type: "response.completed", response: { id: "paper-response", status: "completed", output: [] } });
const capacity = frame({ type: "response.failed", response: { id: "paper-response", status: "failed", error: {
  type: "rate_limit_error", code: "concurrency_limit_exceeded", message: "No browser turn was admitted", retryable: true,
} } });

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Paper result waited for upstream EOF or cancellation")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paper-terminal-"));
  const key = "d".repeat(32), projectId = "g-p-" + "d".repeat(32), accountId = "terminal-account";
  const paperId = "doi:10.1234/terminal-lifecycle";
  writeFileSync(join(root, "key"), key);
  const store = new ChatGptConversationStore(join(root, "conversations"), accountId);
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const originalFetch = globalThis.fetch;
  let upstream: Upstream = { chunks: [encode(completed)] };
  let calls = 0, cancellations = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url) !== "http://127.0.0.1:9/v1/responses") throw new Error("Unexpected upstream URL");
    calls++;
    const body = JSON.parse(String(init?.body));
    const turn = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
    const nativeKey = chatGptQuestionAnswerKey(turn.thread_id, chatGptQuestionAnswerNamespace(accountId));
    const plan = upstream;
    if (plan.bind !== false && !store.lookup(nativeKey)) {
      store.bind(nativeKey, store.reserve(nativeKey), `https://chatgpt.com/g/${projectId}/c/paper-terminal`);
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
        for (const chunk of plan.chunks) controller.enqueue(chunk);
      },
      pull(controller) { if (plan.readError) controller.error(plan.readError); },
      cancel() {
        cancellations++;
        if (plan.cancel === "pending") return new Promise<void>(() => {});
        if (plan.cancel === "reject") return Promise.reject(new Error("Injected upstream cancel rejection"));
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const pool = createQaPool({
    host: "127.0.0.1", port: 0, databasePath: join(root, "pool.sqlite"),
    clients: [{ id: "cpr", keyFile: join(root, "key") }],
    accounts: [{ id: accountId, origin: "http://127.0.0.1:9", models: ["standard"], sessionModes: true,
      conversationStoreDirectory: join(root, "conversations") }],
    projectRoutes: [{ name: "papers", sessionNamespace: "papers", accountId, projectId }],
  });
  const pdf = Buffer.from("%PDF-1.4\nterminal lifecycle fixture\n%%EOF");
  const input = [{ role: "user", content: [
    { type: "input_text", text: "question" },
    { type: "input_file", filename: "paper.pdf", file_data: "data:application/pdf;base64," + pdf.toString("base64") },
  ] }];
  const request = (metadata: object, input: unknown = "resolve") => pool.fetch(new Request("http://pool/project/papers/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "standard", stream: true, input,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ paper_id: paperId, ...metadata }) } }),
  }));
  const resolve = async (token?: string) => {
    const result = await pool.fetch(new Request("http://pool/project/papers/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "standard", input: "resolve", client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ paper_id: paperId, paper_operation: "resolve", paper_upload_token: token }),
      } }),
    }));
    expect(result.status).toBe(200);
    return JSON.parse((await result.json() as { output_text: string }).output_text) as {
      status: string; upload_token?: string; thread_id: string; conversation_url?: string;
    };
  };
  return {
    resolve,
    respond: (plan: Upstream) => { upstream = plan; },
    chat: (token?: string) => request({ paper_operation: "chat", paper_upload_token: token,
      paper_pdf_sha256: createHash("sha256").update(pdf).digest("hex") }, input),
    get calls() { return calls; }, get cancellations() { return cancellations; },
    close() {
      pool.close();
      for (const controller of controllers) { try { controller.close(); } catch {} }
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const cancel of ["resolve", "pending", "reject"] as const) {
  test(`completed paper stream releases its owner with ${cancel} upstream cancellation`, async () => {
    const f = fixture();
    try {
      const reserved = await f.resolve();
      f.respond({ chunks: [encode(completed)], cancel });
      const response = await f.chat(reserved.upload_token);
      expect(await bounded(response.text())).toBe(completed);
      const ready = await f.resolve();
      expect(ready.status).toBe("ready");
      expect(ready.thread_id).toBe(reserved.thread_id);
      expect(f.cancellations).toBe(1);
      f.respond({ chunks: [encode(completed)] });
      expect(await bounded((await f.chat()).text())).toBe(completed);
      expect((await f.resolve()).status).toBe("ready");
      expect(f.calls).toBe(2);
    } finally { f.close(); }
  });

  test(`pre-send paper failure is retryable before EOF with ${cancel} upstream cancellation`, async () => {
    const f = fixture();
    try {
      const reserved = await f.resolve();
      f.respond({ chunks: [encode(capacity)], cancel, bind: false });
      expect(await bounded((await f.chat(reserved.upload_token)).text())).toBe(capacity);
      expect(await f.resolve(reserved.upload_token)).toEqual(reserved);
      expect(f.cancellations).toBe(1);
      f.respond({ chunks: [encode(completed)] });
      expect(await bounded((await f.chat(reserved.upload_token)).text())).toBe(completed);
      expect((await f.resolve()).status).toBe("ready");
      expect(f.calls).toBe(2);
    } finally { f.close(); }
  });
}

for (const type of ["response.failed", "response.incomplete", "error"] as const) {
  test(`${type} closes a paper response and preserves uncertainty`, async () => {
    const f = fixture();
    const terminal = frame(type === "error"
      ? { type, code: "upstream_error", message: "Unknown submission result" }
      : { type, response: { id: "paper-response", status: type.slice("response.".length), output: [],
        error: { code: "upstream_error", message: "Unknown submission result" } } });
    try {
      const reserved = await f.resolve();
      f.respond({ chunks: [encode(terminal)], cancel: "pending", bind: false });
      expect(await bounded((await f.chat(reserved.upload_token)).text())).toBe(terminal);
      expect((await f.resolve()).status).toBe("uncertain");
      const retry = await f.chat(reserved.upload_token);
      expect(retry.status).toBe(409);
      expect((await retry.json() as { error: { code: string } }).error.code).toBe("paper_uncertain");
      expect(f.calls).toBe(1);
      expect(f.cancellations).toBe(1);
    } finally { f.close(); }
  });
}

test("paper completion stops before conflicting or malformed events in the same chunk", async () => {
  const f = fixture();
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [encode(completed + capacity + "data: not-json\n\n")], cancel: "reject" });
    expect(await bounded((await f.chat(reserved.upload_token)).text())).toBe(completed);
    expect((await f.resolve()).status).toBe("ready");
    expect(f.cancellations).toBe(1);
  } finally { f.close(); }
});

test("a paper pre-send failure cannot be replaced by a later completion in the same chunk", async () => {
  const f = fixture();
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [encode(capacity + completed)], cancel: "reject" });
    expect(await bounded((await f.chat(reserved.upload_token)).text())).toBe(capacity);
    expect(await f.resolve(reserved.upload_token)).toEqual(reserved);
  } finally { f.close(); }
});

test("split paper terminal frames preserve UTF-8 bytes and CRLF framing", async () => {
  const f = fixture();
  const prefix = frame({ type: "response.output_text.delta", delta: "论文正文" }).replaceAll("\n", "\r\n");
  const terminal = completed.replaceAll("\n", "\r\n");
  const bytes = encode(prefix + terminal + capacity);
  const split = encode(prefix + terminal.slice(0, 20)).length;
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [bytes.subarray(0, 45), bytes.subarray(45, split), bytes.subarray(split)], cancel: "pending" });
    expect(await bounded((await f.chat(reserved.upload_token)).text())).toBe(prefix + terminal);
    expect((await f.resolve()).status).toBe("ready");
  } finally { f.close(); }
});

test("malformed paper completion cannot commit success", async () => {
  const f = fixture();
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [encode(frame({ type: "response.completed", response: { status: "completed", output: [] } }))] });
    await expect(bounded((await f.chat(reserved.upload_token)).text())).rejects.toThrow("Invalid completed response");
    expect((await f.resolve()).status).toBe("uncertain");
    expect(f.cancellations).toBe(1);
  } finally { f.close(); }
});

test("paper transport read failure releases the owner without claiming completion", async () => {
  const f = fixture();
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [], readError: new Error("Injected paper read failure"), bind: false });
    await expect(bounded((await f.chat(reserved.upload_token)).text())).rejects.toThrow("Injected paper read failure");
    expect((await f.resolve()).status).toBe("uncertain");
    expect((await f.chat(reserved.upload_token)).status).toBe(409);
    expect(f.calls).toBe(1);
  } finally { f.close(); }
});

for (const cancel of ["pending", "reject"] as const) {
  test(`paper observer cancellation releases its owner despite ${cancel} upstream cancellation`, async () => {
    const f = fixture();
    try {
      const reserved = await f.resolve();
      f.respond({ chunks: [encode(": opened\n\n")], cancel, bind: false });
      const reader = (await f.chat(reserved.upload_token)).body!.getReader();
      await reader.read();
      await bounded(reader.cancel());
      expect((await f.resolve()).status).toBe("uncertain");
      expect(f.cancellations).toBe(1);
    } finally { f.close(); }
  });
}
