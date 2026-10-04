import { expect, test } from "bun:test";
import { createDownloadGateway, validateDownloadGatewayConfig } from "../src/download-gateway";

/**
 * 网关自身的测试。部署里的账号运行时文件缓存（下载生成器）不属于本 PR 范围，
 * 因此这里用最小上游替身提供网关会触达的路径，只验证网关的账号前缀、
 * 文件路径与 estuary 参数白名单行为。
 */
function accountRuntime(entry: { token: string; name: string; mime: string; bytes: Uint8Array }) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    const match = /^\/files\/([a-f0-9]{64})\/([^/]+)$/.exec(url.pathname);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("private control", { status: 405 });
    if (!match || match[1] !== entry.token || decodeURIComponent(match[2]!) !== entry.name) {
      return new Response("private control", { status: 404 });
    }
    return new Response(req.method === "HEAD" ? null : entry.bytes, { headers: {
      "content-type": entry.mime,
      "content-length": String(entry.bytes.length),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    } });
  } });
}

test("portable gateway delivers account files and rejects control endpoints and cross-account links", async () => {
  const bytes = new TextEncoder().encode("cross-network-file\n");
  const token = "a".repeat(64);
  const entry = { token, name: "报告.csv", mime: "text/csv", bytes };
  const a = accountRuntime(entry);
  const b = accountRuntime({ ...entry, token: "b".repeat(64) });
  const gateway = createDownloadGateway({ host: "127.0.0.1", port: 0, accounts: { first: a.url.origin, second: b.url.origin } });
  await new Promise<void>(done => gateway.listen(0, "127.0.0.1", done));
  const address = gateway.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const url = `${origin}/first/files/${token}/${encodeURIComponent(entry.name)}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect((await fetch(url, { method: "HEAD" })).headers.get("content-length")).toBe(String(bytes.length));
    for (const bad of [url.replace("/first/", "/second/"), origin + "/first/v1/models", origin + "/v1/responses", url + "?x=1", url.replace("/first/", "/unknown/")])
      expect((await fetch(bad)).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
  } finally {
    await new Promise<void>((done, fail) => gateway.close(error => error ? fail(error) : done()));
    await a.stop(true); await b.stop(true);
  }
});

test("gateway rejects external origins and URL credentials", () => {
  for (const origin of ["http://example.com", "https://127.0.0.1", "http://user:pass@127.0.0.1", "http://127.0.0.1/path"])
    expect(() => validateDownloadGatewayConfig({ host: "127.0.0.1", port: 17860, accounts: { account: origin } })).toThrow();
});

test("optional CPR ingress preserves authenticated streaming and WebSocket traffic", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(JSON.stringify({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") }), { headers: { "content-type": "text/event-stream" } });
    }, websocket: { message(ws, message) { ws.send(message); } },
  });
  const gateway = createDownloadGateway({ host: "127.0.0.1", port: 0, accounts: { first: upstream.url.origin }, pathPrefix: "/qa-files", proxyOrigin: upstream.url.origin });
  await new Promise<void>(done => gateway.listen(0, "127.0.0.1", done));
  const port = (gateway.address() as { port: number }).port;
  try {
    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, { headers: { authorization: "Bearer test" } });
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(await result.json()).toEqual({ path: "/v1/responses", auth: "Bearer test" });
    expect((await fetch(`http://127.0.0.1:${port}/qa-files/first/v1/responses`)).status).toBe(404);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`);
    await new Promise<void>((done, fail) => {
      ws.onopen = () => ws.send("persistent"); ws.onerror = () => fail(new Error("WebSocket proxy failed"));
      ws.onmessage = event => { expect(event.data).toBe("persistent"); ws.close(); done(); };
    });
  } finally { gateway.closeAllConnections(); await new Promise<void>(done => gateway.close(() => done())); await upstream.stop(true); }
});

test("native ChatGPT-shaped links forward only the file identity and reject tampered parameters", async () => {
  const bytes = new TextEncoder().encode("name,value\nalpha,1\n");
  const filename = "报告.csv";
  const fileId = "file_0000000040908230be0f58ee10e88df7";
  const runtime = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/estuary/content" || url.searchParams.get("id") !== fileId || url.searchParams.get("fn") !== filename)
      return new Response("private control", { status: 404 });
    return new Response(bytes, { headers: {
      "content-type": "text/csv",
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    } });
  } });
  const gateway = createDownloadGateway({ host: "127.0.0.1", port: 0, accounts: { first: runtime.url.origin } });
  await new Promise<void>(done => gateway.listen(0, "127.0.0.1", done));
  const port = (gateway.address() as { port: number }).port;
  try {
    const url = `http://127.0.0.1:${port}/first/estuary/content?id=${fileId}&fn=${encodeURIComponent(filename)}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect((await fetch(url, { method: "HEAD" })).headers.get("content-length")).toBe(String(bytes.length));
    // 原生参数不进公共入口：签名与时间戳由运行时自己重放。
    expect((await fetch(`${url}&cd=attachment&sig=other&ts=99`)).status).toBe(200);
    for (const bad of [
      url.replace(fileId, "file_0000000040908230be0f58ee10e88df8"),
      url.replace("file_", "other_"),
      url.replace("fn=" + encodeURIComponent(filename), "fn=..%2F..%2Fetc%2Fpasswd"),
      url.replace("/first/", "/second/"),
      url.replace(/\?.*$/, ""),
    ]) expect((await fetch(bad)).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
  } finally {
    gateway.closeAllConnections();
    await new Promise<void>(done => gateway.close(() => done()));
    await runtime.stop(true);
  }
});


test("MCP ingress routes only exact configured account paths and preserves request bodies", async () => {
  const requests: string[] = [];
  const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    requests.push(new URL(req.url).pathname);
    return Response.json({ path: new URL(req.url).pathname, body: await req.text(), session: req.headers.get("mcp-session-id") });
  } });
  const fallback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("CPR"); } });
  const gateway = createDownloadGateway({
    host: "127.0.0.1", port: 0, accounts: { first: fallback.url.origin },
    pathPrefix: "/qa-files", proxyOrigin: fallback.url.origin,
    mcpAccounts: { "account-1": mcp.url.origin, "account-2": mcp.url.origin },
  });
  await new Promise<void>(done => gateway.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  try {
    for (const account of [1, 2]) {
      const result = await fetch(`${origin}/local-mcp/account-${account}/mcp`, {
        method: "POST", body: '{"method":"tools/list"}', headers: { "mcp-session-id": "session-test" },
      });
      expect(await result.json()).toEqual({ path: "/mcp", body: '{"method":"tools/list"}', session: "session-test" });
    }
    for (const path of ["/local-mcp", "/local-mcp/account-3/mcp", "/local-mcp/account-1/control", "/local-mcp/account-1/mcp?x=1", "/local-mcp/account-1/mcp/"]) {
      expect((await fetch(origin + path)).status).toBe(404);
    }
    expect(requests).toEqual(["/mcp", "/mcp"]);
    expect(await (await fetch(origin + "/v1/models")).text()).toBe("CPR");
    expect(() => validateDownloadGatewayConfig({
      host: "127.0.0.1", port: 0, accounts: { first: fallback.url.origin }, mcpAccounts: { bad: "http://example.com" },
    })).toThrow();
  } finally {
    gateway.closeAllConnections();
    await new Promise<void>(done => gateway.close(() => done()));
    await mcp.stop(true); await fallback.stop(true);
  }
});
