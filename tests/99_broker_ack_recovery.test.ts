// Real SDK/socket/broker and file effect; Native execution is synthetic here.
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConnection, createServer, type Socket } from "node:net";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";

const terminal = (count: number): BrokerToolResult => ({ content: [{ type: "text", text:
  `Wall time: 0.0010 seconds\nProcess exited with code 0\nOutput:\n${count}\n` }] });

test.each(["completed", "unknown", "rejected"] as const)("broker ACK %s: recover only exact completed receipt; never redispatch", async mode => {
  const root = mkdtempSync(join(tmpdir(), "r42ack-"));
  const broker = TurnBroker.forSocket(join(root, "b.sock")); await broker.listen();
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
    tools: [{ name: "exec_command", description: "synthetic native", parameters: {
      type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }] });
  const sockets = new Set<Socket>(); const frames: any[] = []; let cut = false;
  const track = (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket; };
  const proxy = createServer(incoming => {
    track(incoming); let body = "";
    incoming.on("data", chunk => {
      body += chunk; if (!body.includes("\n")) return;
      incoming.removeAllListeners("data"); const request = JSON.parse(body.split("\n")[0]!); frames.push(request);
      if (mode === "rejected" && request.method === "invoke") {
        incoming.end(JSON.stringify({ id: request.id, error: "explicit authority rejection" }) + "\n"); return;
      }
      const outgoing = track(createConnection(join(root, "b.sock"))); let response = "";
      outgoing.once("connect", () => outgoing.write(body));
      incoming.once("close", () => outgoing.destroy());
      outgoing.once("error", () => incoming.destroy());
      outgoing.on("data", chunk => {
        response += chunk; if (!response.includes("\n")) return;
        if (mode === "completed" && request.method === "invoke" && !cut) {
          cut = true; incoming.destroy(); outgoing.destroy();
        } else incoming.end(response);
      });
      if (mode === "unknown" && request.method === "invoke" && !cut) {
        void broker.nextToolBatch(token).then(() => { cut = true; incoming.destroy(); outgoing.destroy(); });
      }
    });
  });
  await new Promise<void>(resolve => proxy.listen(join(root, "p.sock"), resolve));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await connectChatGptMcpServer({ brokerSocketPath: join(root, "p.sock") }, serverTransport);
  const client = new Client({ name: "ack-contract", version: "1" }); await client.connect(clientTransport);
  try {
    const call = () => client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "same explicit command" } });
    const first = call();
    if (mode === "completed") {
      const [request] = await broker.nextToolBatch(token); appendFileSync(join(root, "effect"), "line\n");
      broker.completeTool(token, request!.callId, terminal(1));
    }
    const response = await first;
    const invocations = frames.filter(f => f.method === "invoke");
    if (mode === "completed") {
      expect(response.isError).not.toBe(true); expect(response.content).toEqual(terminal(1).content);
      expect(cut).toBe(true); expect(invocations).toHaveLength(2);
      expect(invocations[1].invocationId).toBe(invocations[0].invocationId);
      expect(invocations[1].arguments).toEqual(invocations[0].arguments);
      expect(frames.filter(f => f.method === "owner_invocation_receipt")).toHaveLength(1);
      expect(readFileSync(join(root, "effect"), "utf8")).toBe("line\n");
      // A separate intentional invocation with identical text must not be deduplicated.
      const next = call(); const [request] = await broker.nextToolBatch(token);
      appendFileSync(join(root, "effect"), "line\n"); broker.completeTool(token, request!.callId, terminal(2));
      expect((await next).content).toEqual(terminal(2).content);
      expect(readFileSync(join(root, "effect"), "utf8")).toBe("line\nline\n");
    } else {
      expect(response.isError).toBe(true); expect(invocations).toHaveLength(1);
      expect(frames.filter(f => f.method === "owner_invocation_receipt")).toHaveLength(mode === "unknown" ? 1 : 0);
    }
  } finally {
    await client.close(); await mcp.close(); await broker.close();
    for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
