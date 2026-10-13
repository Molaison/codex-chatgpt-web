import { defaultBrokerEndpoint, resolveBrokerEndpoint } from "../../config";
import { runChatGptMcpServer, type ChatGptMcpContract } from "./mcp-server";
import { startChatGptMcpHttpServer } from "./mcp-http";

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

export async function runChatGptMcpMain(args: string[]): Promise<void> {
  const remaining = [...args];
  const brokerSocketPath = resolveBrokerEndpoint(option(remaining, "--broker-socket", defaultBrokerEndpoint()));
  const requestedContract = option(remaining, "--contract", "native");
  if (requestedContract !== "native" && requestedContract !== "safe") {
    throw new Error(`--contract must be native or safe, received ${requestedContract}`);
  }
  const transport = option(remaining, "--transport", "stdio");
  if (transport !== "stdio" && transport !== "http") throw new Error("--transport must be stdio or http");
  const httpOptionsRequested = remaining.includes("--port") || remaining.includes("--public-origin");
  const portText = option(remaining, "--port", "8788");
  const publicOrigin = option(remaining, "--public-origin", "");
  if (transport === "stdio" && httpOptionsRequested) throw new Error("--port and --public-origin require --transport http");
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (remaining.length > 0) throw new Error(`Unknown MCP arguments: ${remaining.join(" ")}`);
  const options = { brokerSocketPath, contract: requestedContract as ChatGptMcpContract };
  if (transport === "stdio") {
    await runChatGptMcpServer(options);
    return;
  }
  const http = startChatGptMcpHttpServer({ ...options, port: Number(portText), ...(publicOrigin ? { publicOrigin } : {}) });
  console.error(`[chatgpt-web-mcp-http] Listening on ${http.url.href}; no public tunnel or OAuth configured`);
  const stop = () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    void http.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
