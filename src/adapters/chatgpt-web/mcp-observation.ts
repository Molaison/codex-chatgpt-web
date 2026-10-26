import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHash } from "node:crypto";
import { evidenceRef, type McpProtocolEvidence } from "./release-evidence";

export const mcpRequestRef = (requestId: string | number) => evidenceRef(JSON.stringify([typeof requestId, requestId]));

/** Reconnection keeps a logical RPC identity; a fresh RPC with identical arguments is not merged. */
export function mcpInvocationId(bindingId: string, requestId: string | number, wireName: string): string {
  return "mcp_" + createHash("sha256").update(JSON.stringify([bindingId, typeof requestId, requestId, wireName])).digest("hex");
}

/** The model override only; prompts, names, items and other tool arguments stay private. */
export function subagentModelObservation(wireName: string, args?: Record<string, unknown>) {
  if (!/^(multi_agent_v[12]|collaboration)__spawn_agent$/.test(wireName)) return undefined;
  if (!args || !Object.hasOwn(args, "model")) return { modelOverride: "omitted" as const };
  const model = args.model;
  // Unknown model values remain visible as an explicit override without logging arbitrary input.
  return typeof model === "string" && /^(?:chatgpt-web\/)?gpt-[a-z0-9][a-z0-9._-]{0,79}$/.test(model)
    ? { modelOverride: "explicit" as const, requestedModel: model }
    : { modelOverride: "unrecognized" as const };
}

/** Content-free receipt/reply observations. A sent MCP result is not proof of tool execution. */
export function observeMcpToolCalls(
  transport: Transport,
  knownTools: ReadonlySet<string>,
  write: (event: Record<string, unknown>) => void = event => console.error(`[chatgpt-web-mcp] transport=${JSON.stringify(event)}`),
  onProtocolEvidence?: (event: McpProtocolEvidence) => void,
): Transport {
  let sequence = 0;
  const pending = new Map<string | number, { call: number; tool: string; started: number } | null>();
  const protocol = new Map<string | number, { method: "initialize" | "tools/list"; cursor: boolean } | null>();
  const observe = (event: McpProtocolEvidence) => {
    try { onProtocolEvidence?.(event); } catch { /* Evidence cannot change protocol semantics. */ }
  };
  const emit = (event: Record<string, unknown>) => {
    // Logging is observational: a broken sink cannot change the invocation or its result.
    try { write({ pid: process.pid, ...event }); } catch { /* Preserve transport semantics. */ }
  };
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (onProtocolEvidence && "method" in message && "id" in message
      && (message.method === "initialize" || message.method === "tools/list")) {
      if (protocol.has(message.id)) protocol.set(message.id, null);
      else if (protocol.size < 1_024) protocol.set(message.id, { method: message.method, cursor: message.params?.cursor !== undefined });
    }
    if ("method" in message && message.method === "tools/call" && "id" in message) {
      const name = message.params?.name;
      const tool = typeof name === "string" && knownTools.has(name) ? name : "unknown";
      if (pending.has(message.id)) {
        // An ambiguous protocol ID cannot safely correlate either reply.
        pending.set(message.id, null);
        emit({ event: "uncorrelated_call", reason: "duplicate_id", tool });
      } else if (pending.size >= 1_024) {
        emit({ event: "uncorrelated_call", reason: "tracking_limit", tool });
      } else {
        const call = { call: ++sequence, tool, started: performance.now() };
        pending.set(message.id, call);
        emit({ event: "call_received", call: call.call, tool, request_ref: mcpRequestRef(message.id) });
      }
    }
    receive?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const id = "id" in message ? message.id : undefined;
    const call = id !== undefined && id !== null && !("method" in message) ? pending.get(id) : undefined;
    const handshake = id !== undefined && id !== null && !("method" in message) ? protocol.get(id) : undefined;
    try {
      await send(message, options);
      if (call) {
        const result = "result" in message ? message.result : undefined;
        emit({
          event: "reply_sent", call: call.call, tool: call.tool,
          request_ref: mcpRequestRef(id!),
          elapsed_ms: Math.round(performance.now() - call.started),
          outcome: "error" in message ? "protocol_error" : "result",
          ...("result" in message ? { is_error: result?.isError === true } : {}),
        });
        observe({ event: "tool_reply_sent", request_ref: mcpRequestRef(id!),
          is_error: "error" in message || ("result" in message && message.result?.isError === true) });
      }
      if (handshake && "result" in message) {
        const value = message.result;
        if (handshake.method === "initialize" && typeof value?.protocolVersion === "string"
          && /^\d{4}-\d{2}-\d{2}$/.test(value.protocolVersion)) {
          observe({ event: "initialize_reply_sent", request_ref: mcpRequestRef(id!), protocol_version: value.protocolVersion });
        } else if (handshake.method === "tools/list") {
          const tools = value?.tools;
          const valid = Array.isArray(tools) && tools.every(tool => tool && typeof tool === "object"
            && typeof tool.name === "string" && knownTools.has(tool.name)
            && tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema));
          observe({ event: "tools_list_reply_sent", request_ref: mcpRequestRef(id!),
            catalog_complete: valid && !handshake.cursor && value.nextCursor === undefined,
            tool_count: Array.isArray(tools) ? tools.length : 0,
            ...(valid ? { schema_ref: evidenceRef(JSON.stringify(tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })))) } : {}),
          });
        }
      }
    } catch (error) {
      if (call) emit({ event: "reply_send_failed", call: call.call, tool: call.tool });
      throw error;
    } finally {
      if (call && id !== undefined && id !== null) pending.delete(id);
      if (id !== undefined && id !== null) protocol.delete(id);
    }
  };
  const close = transport.onclose;
  transport.onclose = () => {
    if (pending.size) emit({ event: "transport_closed", tracked_calls: pending.size });
    pending.clear();
    protocol.clear();
    observe({ event: "transport_closed" });
    close?.();
  };
  return transport;
}
