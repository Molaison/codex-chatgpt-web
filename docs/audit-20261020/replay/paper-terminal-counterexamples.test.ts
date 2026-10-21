import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const denyNetwork = (async () => { throw new Error("Network is disabled in this audit replay"); }) as typeof fetch;
globalThis.fetch = denyNetwork;

function checkout(name: string): string {
  const configured = process.env[name];
  if (!configured) throw new Error(`Set ${name} to the local checkout root`);
  const directory = resolve(configured);
  if (!existsSync(join(directory, "src"))) throw new Error(`${name} must contain a src directory`);
  return directory;
}

function revision(directory: string): string {
  const result = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]);
  if (result.exitCode !== 0) throw new Error("The audit target must be a Git checkout");
  return new TextDecoder().decode(result.stdout).trim();
}

const upstreamRoot = checkout("PAPER_AUDIT_UPSTREAM_ROOT");
const upstreamRevision = revision(upstreamRoot);
const upstreamModule = (path: string) => import(pathToFileURL(join(upstreamRoot, path)).href);
const { createQaPool } = await upstreamModule("src/qa-pool.ts");
const { ChatGptConversationStore } = await upstreamModule("src/adapters/chatgpt-web/conversation-persistence.ts");
const { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } = await upstreamModule("src/adapters/chatgpt-web/qa-conversation-key.ts");

console.log(JSON.stringify({ audit: "paper-terminal-counterexamples", upstream: upstreamRevision }));

type CancelBehavior = "resolve" | "pending" | "reject";
type Upstream = { chunks: Uint8Array[]; cancel?: CancelBehavior; bind?: boolean; readError?: Error; json?: unknown; cancelGate?: Promise<void> };
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
    if (plan.json !== undefined) return Response.json(plan.json);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
        for (const chunk of plan.chunks) controller.enqueue(chunk);
      },
      pull(controller) { if (plan.readError) controller.error(plan.readError); },
      cancel() {
        cancellations++;
        if (plan.cancelGate) return plan.cancelGate;
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
    emit: (bytes: Uint8Array) => controllers.at(-1)!.enqueue(bytes),
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


test("verified completion already enqueued settles despite observer cancellation", async () => {
  const f = fixture();
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [], cancel: "pending" });
    const response = await f.chat(reserved.upload_token);
    const reader = response.body!.getReader();
    const pending = reader.read();
    await Promise.resolve();
    f.emit(encode(completed));
    await bounded(reader.cancel());
    await pending;
    const actual = await f.resolve();
    expect(actual.status).toBe("ready");
  } finally { f.close(); }
});

test("malformed JSON completion remains uncertain", async () => {
  const f = fixture();
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [], json: { status: "completed", output: [] } });
    const response = await f.chat(reserved.upload_token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", output: [] });
    expect((await f.resolve()).status).toBe("uncertain");
    expect((await f.chat(reserved.upload_token)).status).toBe(409);
    expect(f.calls).toBe(1);
  } finally { f.close(); }
});

test("completed JSON with missing saved mapping cannot become ready", async () => {
  const f = fixture();
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [], bind: false, json: { id: "paper-response", status: "completed", output: [] } });
    const response = await f.chat(reserved.upload_token);
    expect(response.status).toBe(502);
    expect((await f.resolve()).status).toBe("uncertain");
  } finally { f.close(); }
});

test("completed SSE with missing saved mapping cannot become ready", async () => {
  const f = fixture();
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [encode(completed)], bind: false });
    await expect(bounded((await f.chat(reserved.upload_token)).text())).rejects.toThrow();
    expect((await f.resolve()).status).toBe("uncertain");
    expect(f.cancellations).toBe(1);
  } finally { f.close(); }
});

test("terminal truncation preserves every possible split boundary", async () => {
  const prefix = frame({ type: "response.output_text.delta", delta: "中😀文" });
  const bytes = encode(prefix + completed + capacity + "data: badjson\n\n");
  for (let at = 1; at < encode(prefix + completed).length; at++) {
    const f = fixture();
    try {
      const reserved = await f.resolve();
      f.respond({ chunks: [bytes.subarray(0,at), bytes.subarray(at)], cancel: "reject" });
      expect(await bounded((await f.chat(reserved.upload_token)).text())).toBe(prefix + completed);
      expect((await f.resolve()).status).toBe("ready");
    } finally { f.close(); }
  }
}, 30_000);

test("late prior cancellation rejection cannot release a newer paper owner", async () => {
  const f = fixture();
  let rejectCancel!: (reason: Error) => void;
  const gate = new Promise<void>((_, reject) => { rejectCancel = reject; });
  try {
    const reserved = await f.resolve();
    f.respond({ chunks: [encode(completed)], cancelGate: gate });
    expect(await bounded((await f.chat(reserved.upload_token)).text())).toBe(completed);
    expect((await f.resolve()).status).toBe("ready");
    f.respond({ chunks: [] });
    const newer = await f.chat();
    expect((await f.resolve()).status).toBe("pending");
    rejectCancel(new Error("Late prior cancel rejection"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await f.resolve()).status).toBe("pending");
    const overlapping = await f.chat();
    expect(overlapping.status).toBe(409);
    expect((await overlapping.json() as {error:{code:string}}).error.code).toBe("paper_busy");
    expect(f.calls).toBe(2);
    f.emit(encode(completed));
    expect(await bounded(newer.text())).toBe(completed);
    expect((await f.resolve()).status).toBe("ready");
  } finally { rejectCancel(new Error("cleanup")); f.close(); }
});
