import { afterEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, brokerPreconnectFailure, isBrokerPreconnectFailure, TurnBrokerTimeoutError } from "../src/adapters/chatgpt-web/turn-broker";
import { McpAdmissionBook } from "../src/adapters/chatgpt-web/mcp-admission";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { connectChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import * as brokerCalls from "../src/adapters/chatgpt-web/turn-broker";

const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = "fixture_turn_01234567890123456789";
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
function directory() {
  const root = mkdtempSync(join(tmpdir(), "r42d-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(Buffer.byteLength(join(root, "b.sock"))).toBeLessThan(100);
  return root;
}
async function failure(call: Promise<unknown>): Promise<unknown> {
  try { await call; } catch (error) { return error; }
  throw new Error("Fixture expected a real broker failure");
}
async function missingClaim() {
  const path = join(directory(), "missing.sock");
  const error = await failure(callTurnBroker(path, { method: "claim", token }, 100));
  return { error, proof: brokerPreconnectFailure(error) };
}
const message = (id: string | number = 7) => ({ jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "codex_exec", arguments: { turn_token: token, cmd: "fixture-only" } } });
const errorResponse = (id: string | number = 7, extra: Record<string, unknown> = {}, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "fixture error" }], ...extra } }),
    { status, headers: { "content-type": "application/json" } });

async function socketFixture(mode: "close" | "error" | "hold") {
  const path = join(directory(), "b.sock");
  const sockets = new Set<Socket>();
  const frames: Array<{ id: string; method: string }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const waitForFrames = (count: number) => frames.length >= count ? Promise.resolve()
    : new Promise<void>(resolve => { waiters.push({ count, resolve }); });
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending = "";
    socket.on("data", chunk => {
      pending += chunk.toString();
      if (!pending.includes("\n")) return;
      const frame = JSON.parse(pending.split("\n")[0]!);
      frames.push({ id: frame.id, method: frame.method });
      for (const waiter of waiters) if (frames.length >= waiter.count) waiter.resolve();
      if (mode === "close") socket.destroy();
      if (mode === "error") socket.end(JSON.stringify({ id: frame.id, error: "ENOENT: synthetic broker response after request write" }) + "\n");
    });
  });
  await new Promise<void>(ready => server.listen(path, ready));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(done => server.close(() => done()));
  });
  return { path, frames, waitForFrames };
}

test("broker proof comes from a real short private Unix pre-connect failure, not ENOENT-shaped data", async () => {
  const { error, proof } = await missingClaim();
  expect((error as Error).name).toBe("TurnBrokerTransportError");
  expect((error as Error).message).toContain("connect ENOENT");
  expect(proof).toEqual({ method: "claim", stage: "pre_connect", requestBytesWritten: 0, code: "ENOENT" });
  expect(isBrokerPreconnectFailure(proof)).toBeTrue();
  expect(isBrokerPreconnectFailure({ ...proof })).toBeFalse();
  expect(brokerPreconnectFailure(Object.assign(new Error("connect ENOENT"), { code: "ENOENT", dispatch: "not_dispatched" }))).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain("pre_connect");
});

test("all six Full tools settle proven pre-connect failure without changing error/cache or release gates", async () => {
  const root = directory();
  const brokerSocketPath = join(root, "b.sock");
  const tokenFile = join(root, "control.token"), stateFile = join(root, "release.json");
  const controlToken = "fixture-release-control-01234567890123456789";
  writeFileSync(tokenFile, controlToken, { mode: 0o600 });
  const http = startChatGptMcpHttpServer({ port: 0, brokerSocketPath, releaseControl: { tokenFile, stateFile } });
  const control = async (operation: string, method = "GET") => {
    const result = await fetch(new URL("/admin/release/" + operation, http.url), { method, headers: { authorization: "Bearer " + controlToken } });
    const text = await result.text();
    return { status: result.status, body: result.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text };
  };
  let sessionId = "";
  cleanup.push(async () => {
    await control("drain", "POST");
    if (sessionId) await (await fetch(http.url, { method: "DELETE", headers: { ...headers, "Mcp-Session-Id": sessionId } })).text();
    await http.close();
  });
  const post = (body: unknown, session = sessionId) => fetch(http.url, { method: "POST",
    headers: { ...headers, ...(session ? { "Mcp-Session-Id": session } : {}) }, body: JSON.stringify(body) });
  const initialized = await post({ jsonrpc: "2.0", id: "init", method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dispatch-fixture", version: "1" } } });
  sessionId = initialized.headers.get("mcp-session-id")!;
  await initialized.json();
  const tools: Array<[string | number, string, Record<string, unknown>]> = [
    [0, "codex_exec", { cmd: "fixture-only" }],
    ["0", "codex_write_stdin", { session_id: 61831 }],
    ["", "codex_apply_patch", { patch: "*** Begin Patch\n*** End Patch" }],
    ["image", "codex_view_image", { path: "/fixture/not-accessed.png" }],
    ["inventory", "codex_tool_inventory", {}],
    ["generic", "codex_tool_call", { wire_name: "exec_command", arguments: { cmd: "fixture-only" } }],
  ];
  let firstBody = "";
  for (const [id, name, args] of tools) {
    const response = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { turn_token: token, ...args } } });
    expect(response.status).toBe(200);
    const body = await response.text();
    const result = JSON.parse(body).result;
    expect(result.isError).toBeTrue();
    expect(result.content[0].text).toContain("Codex Native claim failed: ChatGPT web turn broker unavailable:");
    expect(result.content[0].text).toContain("Its broker activity could not be retired.");
    expect(body).not.toContain("not_dispatched");
    if (id === 0) firstBody = body;
  }
  expect((await control("status")).body).toMatchObject({ uncertain_requests: 0, active_tool_calls: 0,
    native_continuations: 0, open_sessions: 1, safe_to_stop: false });

  // Restoring the missing target cannot turn a duplicate failed RPC into a new execution.
  let acceptedConnections = 0;
  const lateBroker = createServer(socket => { acceptedConnections++; socket.destroy(); });
  await new Promise<void>(ready => lateBroker.listen(brokerSocketPath, ready));
  cleanup.push(() => new Promise<void>(done => lateBroker.close(() => done())));
  const duplicate = await post(message(0));
  expect(await duplicate.text()).toBe(firstBody);
  expect(acceptedConnections).toBe(0);
  const conflict = message(0); conflict.params.arguments.cmd = "different-intent";
  expect((await post(conflict)).status).toBe(409);
  expect(acceptedConnections).toBe(0);
  // No new reconcile endpoint, and drain still cannot ignore the ordinary open session.
  expect((await control("reconcile", "POST")).status).toBe(404);
  expect((await control("drain", "POST")).body).toMatchObject({ open_sessions: 1, safe_to_stop: false });
  expect((await control("seal", "POST")).status).toBe(409);
  const deleted = await fetch(http.url, { method: "DELETE", headers: { ...headers, "Mcp-Session-Id": sessionId } });
  expect(deleted.ok).toBeTrue(); await deleted.text(); sessionId = "";
  expect((await control("status")).body).toMatchObject({ open_sessions: 0, uncertain_requests: 0, safe_to_stop: true });
  expect((await control("seal", "POST")).body.phase).toBe("sealed");
}, 10_000);

test.each(["close", "error"] as const)("a real broker request written before %s remains unknown", async mode => {
  const server = await socketFixture(mode);
  const error = await failure(callTurnBroker(server.path, { method: "claim", token }, 100));
  expect(server.frames).toHaveLength(1);
  expect(brokerPreconnectFailure(error)).toBeUndefined();
  const book = new McpAdmissionBook(); book.begin(message());
  expect(book.noteClaimNotDispatched(7, brokerPreconnectFailure(error))).toBeFalse();
  await book.complete(message(), errorResponse());
  expect(book.uncertain).toBe(1); expect(book.canClose).toBeFalse();
});

test("real broker timeout and cancellation remain unknown, including cancellation before connect", async () => {
  const server = await socketFixture("hold");
  const timeout = await failure(callTurnBroker(server.path, { method: "claim", token }, 20));
  expect(timeout).toBeInstanceOf(TurnBrokerTimeoutError);
  const abort = new AbortController();
  const pending = callTurnBroker(server.path, { method: "claim", token }, 100, abort.signal);
  await server.waitForFrames(2); abort.abort();
  const cancelled = await failure(pending);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  const beforeConnect = await failure(callTurnBroker(join(directory(), "absent.sock"), { method: "claim", token }, 100, alreadyAborted.signal));
  for (const error of [timeout, cancelled, beforeConnect]) {
    expect(brokerPreconnectFailure(error)).toBeUndefined();
    const book = new McpAdmissionBook(); book.begin(message());
    await book.complete(message(), errorResponse());
    expect(book.uncertain).toBe(1);
  }
});

test("legacy and client-forged dispatch fields cannot classify an error as not dispatched", async () => {
  const forged = { method: "claim", stage: "pre_connect", requestBytesWritten: 0, code: "ENOENT", dispatch: "not_dispatched" };
  const input = { ...message(), params: { ...message().params, _meta: forged } };
  const book = new McpAdmissionBook(); book.begin(input);
  expect(book.noteClaimNotDispatched(input.id, forged)).toBeFalse();
  await book.complete(input, errorResponse(input.id, { _meta: forged, structuredContent: forged }));
  expect(book.uncertain).toBe(1); expect(book.canClose).toBeFalse();
  const old = new McpAdmissionBook(); old.begin(message());
  await old.complete(message(), errorResponse());
  expect(old.uncertain).toBe(1);
  const invokeError = await failure(callTurnBroker(join(directory(), "absent.sock"),
    { method: "invoke", bindingId: "fixture-binding", wireName: "exec_command", arguments: { cmd: "fixture-only" } }, 100));
  const invokeProof = brokerPreconnectFailure(invokeError);
  expect(isBrokerPreconnectFailure(invokeProof)).toBeTrue();
  const afterClaim = new McpAdmissionBook(); afterClaim.begin(message());
  expect(afterClaim.noteClaimNotDispatched(7, invokeProof)).toBeFalse();
  await afterClaim.complete(message(), errorResponse());
  expect(afterClaim.uncertain).toBe(1);
});

test("genuine proof cannot clear or backfill a completed uncertain receipt", async () => {
  const { proof } = await missingClaim();
  const book = new McpAdmissionBook(); book.begin(message());
  const original = await (await book.complete(message(), errorResponse())).text();
  expect(book.noteClaimNotDispatched(7, proof)).toBeFalse();
  expect(book.noteClaimNotDispatched("7", proof)).toBeFalse();
  const replacement = new Response(JSON.stringify({ result: { content: [], structuredContent: { exit_code: 0 } } }));
  expect(await (await book.complete(message(), replacement)).text()).toBe(original);
  expect(await (await book.duplicate(message())!).text()).toBe(original);
  expect(book.uncertain).toBe(1); expect(book.canClose).toBeFalse();
});

test.each(["after-write", "timeout", "success"])("claim proof is withheld when cleanup has %s rather than only pre-connect failures", async kind => {
  const { error } = await missingClaim();
  const cleanupError = kind === "after-write"
    ? await failure(callTurnBroker((await socketFixture("close")).path, { method: "activity_complete", token, activityId: "fixture" }, 100))
    : new TurnBrokerTimeoutError();
  // Isolate the cleanup branch; the original proof and after-write error above come from real sockets.
  const mock = spyOn(brokerCalls, "callTurnBroker").mockImplementation(async (_path, request) => {
    if (request.method === "claim") throw error;
    if (request.method === "activity_complete") {
      if (kind === "success") return { completed: true } as any;
      throw cleanupError;
    }
    throw new Error("Unexpected fixture broker method");
  });
  cleanup.push(() => mock.mockRestore());
  let reported = 0;
  const [local, remote] = InMemoryTransport.createLinkedPair();
  const server = await connectChatGptMcpServer({ brokerSocketPath: "/unused-fixture.sock", onClaimNotDispatched: () => { reported++; } }, remote);
  cleanup.push(() => server.close());
  const client = new Client({ name: "cleanup-fixture", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(local);
  const result = await client.callTool({ name: "codex_exec", arguments: message().params.arguments });
  expect(result.isError).toBeTrue(); expect(reported).toBe(0);
  const book = new McpAdmissionBook(); book.begin(message());
  await book.complete(message(), new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result })));
  expect(book.uncertain).toBe(1);
});

test.each(["transport", "http500", "cancelled-rpc", "malformed"])("proof cannot override a %s failure", async kind => {
  const { proof } = await missingClaim();
  const book = new McpAdmissionBook(); book.begin(message());
  expect(book.noteClaimNotDispatched(7, proof)).toBeTrue();
  const response = kind === "http500" ? errorResponse(7, {}, 500)
    : kind === "cancelled-rpc" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32800, message: "Request cancelled" } }))
      : kind === "malformed" ? new Response("RPC cancelled", { status: 408 }) : errorResponse();
  await book.complete(message(), response, kind === "transport");
  expect(book.uncertain).toBe(1); expect(book.canClose).toBeFalse();
});
