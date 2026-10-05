// HTTP 边界回归：真实本机 upstream + 真实 cpr-provider.mjs 进程，只覆盖公开 -tools 模型别名
// 与 QA 模式不变的那条边界。
// Run with Node.js available on PATH, or set CPR_PROVIDER_NODE to its executable.
import { expect, setDefaultTimeout, test } from "bun:test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

setDefaultTimeout(30_000);

const providerScript = resolve(import.meta.dir, "../deploy/cpr-provider.mjs");
// 生产用 Node 24 跑 provider；默认使用 PATH 中的 node，本地可用 CPR_PROVIDER_NODE 指到 node24。
const providerNode = process.env.CPR_PROVIDER_NODE || "node";
// The deployed provider uses Unix sockets and is a Linux-host component.
const providerTest = process.platform === "win32" ? test.skip : test;
const AUTH = { authorization: "Bearer provider-secret" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };
const FULL_CATALOG = [
  { slug: "gpt-5.6-sol", display_name: "5.6 Sol", description: "native", context_window: 300000, supported_in_api: true },
  { slug: "chatgpt-web/gpt-5.6-sol", display_name: "5.6 Sol Web", context_window: 400000 },
];

type UpstreamCall = { path: string; body: any; authorization?: string; acceptEncoding?: string };
type Handler = (call: UpstreamCall, response: ServerResponse) => void;

async function startScenario(options: { mode: string; models: unknown[]; handler: Handler }) {
  const home = mkdtempSync(join(tmpdir(), "cpr-provider-"));
  const calls: UpstreamCall[] = [];
  const upstream = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(chunk));
    incoming.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const call: UpstreamCall = {
        path: incoming.url!,
        body: raw ? JSON.parse(raw) : undefined,
        authorization: incoming.headers.authorization,
        acceptEncoding: incoming.headers["accept-encoding"],
      };
      calls.push(call);
      if (!response.headersSent) options.handler(call, response);
    });
  });
  await new Promise<void>(ready => upstream.listen(0, "127.0.0.1", ready));
  const port = (upstream.address() as AddressInfo).port;
  mkdirSync(join(home, "cpr"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ mode: options.mode, port, storageStatePath: join(home, "browser-state") }));
  writeFileSync(join(home, "provider.key"), "provider-secret\n");
  writeFileSync(join(home, "models.json"), JSON.stringify({ models: options.models }));
  writeFileSync(join(home, "browser-state.verified.json"), "{}\n");
  const child = Bun.spawn([providerNode, providerScript, home], { stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const socketPath = join(home, "cpr", "provider.sock");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(socketPath)) break;
    if (await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>(ready => setTimeout(() => ready(false), 50)),
    ])) throw new Error(`provider exited before listening: ${await stderr}`);
    if (attempt === 99) throw new Error("provider did not listen within 5s");
  }
  return {
    socketPath,
    calls,
    close: async () => {
      child.kill();
      await child.exited;
      await new Promise<void>(done => upstream.close(() => done()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function socketRequest(socketPath: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string; onChunk?: (chunk: string) => void }) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve_, reject) => {
    const outgoing = httpRequest({ socketPath, path, method: options.method ?? "GET", headers: options.headers }, response => {
      const chunks: string[] = [];
      response.setEncoding("utf8");
      response.on("data", chunk => { chunks.push(chunk); options.onChunk?.(chunk); });
      response.on("end", () => resolve_({ status: response.statusCode!, headers: response.headers, text: chunks.join("") }));
    });
    outgoing.on("error", reject);
    if (options.body) outgoing.write(options.body);
    outgoing.end();
  });
}

const jsonResponse = (call: UpstreamCall, response: ServerResponse) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "resp_1",
    object: "response",
    model: call.body.model,
    metadata: { model: call.body.model },
    output: [{ type: "message", content: [{ type: "output_text", text: "upstream chatgpt-web/gpt-5.6-sol in text" }] }],
  }));
};

providerTest("Full 模式只发布 -tools 别名并显示 tools 语义", async () => {
  const scenario = await startScenario({ mode: "full", models: FULL_CATALOG, handler: jsonResponse });
  try {
    const models = await socketRequest(scenario.socketPath, "/v1/models", { headers: AUTH });
    expect(models.status).toBe(200);
    const body = JSON.parse(models.text);
    expect(body.data.map((model: any) => model.id)).toEqual(["gpt-5.6-sol-tools", "chatgpt-web/gpt-5.6-sol-tools"]);
    expect(body.models.map((model: any) => model.slug)).toEqual(["gpt-5.6-sol-tools", "chatgpt-web/gpt-5.6-sol-tools"]);
    expect(body.models[0].display_name).toBe("5.6 Sol-tools");
    expect(body.models[0].description).toContain("Local tools");
    expect(body.models[0].context_window).toBe(300000);
    expect(models.text).not.toContain('"slug":"gpt-5.6-sol"');
  } finally { await scenario.close(); }
});

providerTest("Full 模式接受别名、上游收到原名、响应 JSON 回显别名且不动文本", async () => {
  const scenario = await startScenario({ mode: "full", models: FULL_CATALOG, handler: jsonResponse });
  try {
    const instructions = "keep my instructions";
    const tools = [{ type: "function", name: "shell", parameters: { type: "object" } }];
    const response = await socketRequest(scenario.socketPath, "/v1/responses", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol-tools", stream: false, instructions, tools }),
    });
    expect(response.status).toBe(200);
    expect(scenario.calls).toHaveLength(1);
    expect(scenario.calls[0]!.path).toBe("/v1/responses");
    expect(scenario.calls[0]!.body.model).toBe("chatgpt-web/gpt-5.6-sol");
    expect(scenario.calls[0]!.body.instructions).toBe(instructions);
    expect(scenario.calls[0]!.body.tools).toEqual(tools);
    const body = JSON.parse(response.text);
    expect(body.model).toBe("chatgpt-web/gpt-5.6-sol-tools");
    expect(body.metadata.model).toBe("chatgpt-web/gpt-5.6-sol");
    expect(body.output[0].content[0].text).toBe("upstream chatgpt-web/gpt-5.6-sol in text");
  } finally { await scenario.close(); }
});

providerTest("Full 模式 SSE 增量转发，只改写 model 字段", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const literal = 'literal chatgpt-web/gpt-5.6-sol and {"model":"gpt-5.6-sol"} stay text';
  const scenario = await startScenario({
    mode: "full",
    models: FULL_CATALOG,
    handler: (call, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", model: call.body.model } })}\n\n`);
      void gate.then(() => response.end(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: literal })}\n\n`
        + `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", model: call.body.model, output: [] } })}\n\ndata: [DONE]\n\n`));
    },
  });
  try {
    let resolveFirst!: (chunk: string) => void;
    const firstChunk = new Promise<string>(done => { resolveFirst = done; });
    const pending = socketRequest(scenario.socketPath, "/v1/responses", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol-tools", stream: true }),
      onChunk: chunk => resolveFirst(chunk),
    });
    // 上游还在持有连接时就拿到首块，说明没有整包缓冲。
    const first = await firstChunk;
    expect(first).toContain('"model":"chatgpt-web/gpt-5.6-sol-tools"');
    release();
    const response = await pending;
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect((response.text.match(/"model":"chatgpt-web\/gpt-5\.6-sol-tools"/g) ?? []).length).toBe(2);
    expect(response.text).not.toContain('"model":"chatgpt-web/gpt-5.6-sol"');
    expect(response.text).toContain(JSON.stringify(literal));
    expect(response.text).toContain("data: [DONE]");
  } finally { await scenario.close(); }
});

providerTest("Full 模式在转发前拒绝未加后缀的原名和未知别名", async () => {
  const scenario = await startScenario({ mode: "full", models: FULL_CATALOG, handler: jsonResponse });
  try {
    const body = JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", stream: false });
    const original = await socketRequest(scenario.socketPath, "/v1/responses", { method: "POST", headers: JSON_HEADERS, body });
    expect(original.status).toBe(400);
    expect(JSON.parse(original.text).error.message).toBe("Model unavailable for this account");
    const unknown = await socketRequest(scenario.socketPath, "/v1/responses", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ model: "chatgpt-web/gpt-9-unknown-tools" }) });
    expect(unknown.status).toBe(400);
    expect(scenario.calls).toHaveLength(0);
  } finally { await scenario.close(); }
});

providerTest("Full 模式 compact 用同一套别名与响应回显", async () => {
  const scenario = await startScenario({ mode: "full", models: FULL_CATALOG, handler: jsonResponse });
  try {
    const response = await socketRequest(scenario.socketPath, "/v1/responses/compact", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol-tools", input: [] }),
    });
    expect(response.status).toBe(200);
    expect(scenario.calls[0]!.path).toBe("/v1/responses/compact");
    expect(scenario.calls[0]!.body.model).toBe("chatgpt-web/gpt-5.6-sol");
    expect(JSON.parse(response.text).model).toBe("chatgpt-web/gpt-5.6-sol-tools");
  } finally { await scenario.close(); }
});

providerTest("QA 模式目录、请求体与 -tools 拒绝规则保持原样", async () => {
  const scenario = await startScenario({ mode: "browser-only", models: FULL_CATALOG, handler: jsonResponse });
  try {
    const catalog = await socketRequest(scenario.socketPath, "/v1/models", { headers: AUTH });
    const listed = JSON.parse(catalog.text);
    expect(listed.data.map((model: any) => model.id)).toEqual(["gpt-5.6-sol", "chatgpt-web/gpt-5.6-sol"]);
    expect(listed.models.map((model: any) => model.slug)).toEqual(["gpt-5.6-sol", "chatgpt-web/gpt-5.6-sol"]);
    const instructions = "qa instructions";
    const tools = [{ type: "function", name: "shell", parameters: { type: "object" } }];
    const response = await socketRequest(scenario.socketPath, "/v1/responses", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", stream: false, instructions, tools }),
    });
    expect(response.status).toBe(200);
    expect(scenario.calls[0]!.body.model).toBe("chatgpt-web/gpt-5.6-sol");
    expect(scenario.calls[0]!.body.instructions).toBe(instructions);
    expect(scenario.calls[0]!.body.tools).toEqual(tools);
    expect(JSON.parse(response.text).model).toBe("chatgpt-web/gpt-5.6-sol");
    const aliased = await socketRequest(scenario.socketPath, "/v1/responses", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol-tools", stream: false }),
    });
    expect(aliased.status).toBe(400);
    expect(scenario.calls).toHaveLength(1);
  } finally { await scenario.close(); }
});
