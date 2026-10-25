// Isolated child process only. Physical browser work is synthetic; HTTP/adapter/journal are real.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { OperationJournal } from "../src/adapters/chatgpt-web/operation-journal";
import type { CodexProviderConfig } from "../src/types";

const [root, mode] = process.argv.slice(2) as [string, string];
if (mode === "before-send-storage-failure") {
  const write = OperationJournal.prototype.write;
  OperationJournal.prototype.write = function(key, value) {
    if ((value as { submission?: string }).submission === "send_activated") {
      throw new Error("synthetic durable storage failure before physical Send");
    }
    return write.call(this, key, value);
  };
}
if (mode === "measure") {
  const write = OperationJournal.prototype.write;
  const totals = { writes: 0, bytes: 0, maxBytes: 0 };
  OperationJournal.prototype.write = function(key, value) {
    const before = this.metrics.bytes;
    write.call(this, key, value);
    totals.writes++;
    const bytes = this.metrics.bytes - before;
    totals.bytes += bytes; totals.maxBytes = Math.max(totals.maxBytes, bytes);
    writeFileSync(join(root, "metrics.json"), JSON.stringify(totals));
  };
}
const marker = (phase: string) => writeFileSync(join(root, "phase"), phase);
const crashAt = (phase: string) => { marker(phase); if (mode === phase) process.kill(process.pid, "SIGKILL"); };
if (mode.startsWith("tool-")) {
  const endpoint = join(root, "broker.sock");
  const broker = TurnBroker.forSocket(endpoint);
  await broker.listen();
  if (mode !== "tool-recover") {
    const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, undefined, "fixture-tool-trace");
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(endpoint, { method: "claim", token });
    writeFileSync(join(root, "binding.json"), JSON.stringify({ token, bindingId }));
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as any;
    if (body.action === "next") {
      const calls = await broker.nextToolBatch(body.token);
      appendFileSync(join(root, "dispatches"), calls.map(call => call.callId + "\n").join(""));
      writeFileSync(join(root, "call.json"), JSON.stringify(calls[0]));
      crashAt("tool-dispatched");
      return Response.json(calls);
    }
    if (body.action === "complete") {
      broker.completeTool(body.token, body.callId, body.result);
      crashAt("tool-completed");
      return Response.json({ completed: true });
    }
    return new Response("bad action", { status: 400 });
  }});
  marker("ready"); console.log(`READY ${server.port}`);
} else {
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "browser://execution42",
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      threadEnvironmentStatePath: join(root, "environment.json"), brokerSocketPath: join(root, "broker.sock"),
      conversationStoreDirectory: join(root, "conversations") } };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  worker.run = async turn => {
    appendFileSync(join(root, "starts"), "start\n");
    crashAt("intent");
    await turn.onSendActivated?.();
    crashAt("before-send");
    appendFileSync(join(root, "sends"), "send\n");
    crashAt("after-send");
    await turn.onSubmitted?.();
    crashAt("accepted");
    if (mode === "failed") throw new Error("synthetic accepted transport failure");
    const answer = mode === "measure" ? "x".repeat(256 * 1024) : "recoverable-final-42";
    if (mode === "measure") {
      for (let i = 0; i < 1024; i++) { turn.onTextDelta("x".repeat(256)); await Bun.sleep(1); }
    } else for (let i = 0; i < answer.length; i++) turn.onTextDelta(answer[i]!);
    return answer;
  };
  const adapter = createChatGptWebAdapter(provider);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    return responseRequest(req, defaultConfig("browser-only"), () => adapter, {
      rememberState: false,
      onAdapterEvent(event) { if (event.type === "done") crashAt("final-before-delivery"); },
    });
  }});
  marker("ready"); console.log(`READY ${server.port}`);
}
