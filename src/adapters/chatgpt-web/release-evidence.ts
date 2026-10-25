import { createHash, randomUUID } from "node:crypto";
import { VERSION } from "../../version";

/** Diagnostic identities only. None of these values participate in authorization or ownership. */
export const evidenceRef = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const runtimeInstance = randomUUID();
const candidateId = `${VERSION}/${runtimeInstance}`;
export type ReadinessStatus = "ready" | "partial" | "not_ready" | "unknown";
export interface ReadinessFact {
  status: ReadinessStatus;
  source: string;
  reason: string;
  observed_at?: string;
}

export function runtimeEvidenceHeaders(): Record<string, string> {
  return {
    "x-codex-web-version": VERSION,
    "x-codex-web-instance": runtimeInstance,
    ...(process.env.INVOCATION_ID ? { "x-codex-web-invocation-ref": evidenceRef(process.env.INVOCATION_ID) } : {}),
  };
}

/** An ingress header is a reported correlation value, never proof of a route or permission. */
export function runtimeRequestEvidence(
  headers: Headers,
  config: { mode: string; accountId?: string },
  traceId?: string,
) {
  const requestId = headers.get("x-request-id");
  return {
    schema_version: 1,
    candidate_id: candidateId,
    runtime_version: VERSION,
    runtime_instance: runtimeInstance,
    service_invocation_ref: process.env.INVOCATION_ID ? evidenceRef(process.env.INVOCATION_ID) : null,
    request_ref: requestId === null ? null : evidenceRef(requestId),
    request_ref_source: requestId === null ? "unavailable" : "ingress_reported",
    provider_mode: config.mode,
    account_ref: config.accountId ? evidenceRef(config.accountId) : null,
    trace_ref: traceId ? evidenceRef(traceId) : null,
    // The runtime cannot observe the upstream CPR hop/build or its account pool.
    cpr_route: "unknown",
    cpr_build: "unknown",
    account_pool: "unknown",
  };
}

/** Health never sends a model request or promotes a catalog/marker into a successful turn. */
export function runtimeReadinessEvidence(tool?: ReadinessFact) {
  const observed_at = new Date().toISOString();
  const unknown = (source: string): ReadinessFact => ({ status: "unknown", source, reason: "not_observed" });
  return {
    schema_version: 1,
    candidate_id: candidateId,
    observed_at,
    levels: {
      L0: { status: "ready" as const, source: "runtime_process", reason: "responding", observed_at },
      L1: unknown("upstream_route"),
      L2: unknown("provider_pool"),
      L3: unknown("browser_session"),
      L4: unknown("dated_authenticated_turn_canary"),
      L5: tool ?? unknown("connector_tool_canary"),
    },
  };
}

export type McpProtocolEvidence = {
  event: "initialize_reply_sent" | "tools_list_reply_sent" | "tool_reply_sent" | "transport_closed";
  request_ref?: string;
  protocol_version?: string;
  catalog_complete?: boolean;
  tool_count?: number;
  schema_ref?: string;
  is_error?: boolean;
};

/** This is a transient observation, not a second tool execution ledger. */
export class McpReadinessEvidence {
  private initialized?: { observed_at: string; protocol_version: string };
  private catalog?: { observed_at: string; complete: boolean; tool_count: number; schema_ref?: string };
  private lastReply?: { observed_at: string; request_ref?: string; is_error: boolean };
  private nativeResultAt?: string;
  private closed = false;

  observe(event: McpProtocolEvidence): void {
    const observed_at = new Date().toISOString();
    if (event.event === "initialize_reply_sent" && event.protocol_version) {
      this.initialized = { observed_at, protocol_version: event.protocol_version };
    } else if (event.event === "tools_list_reply_sent") {
      this.catalog = { observed_at, complete: event.catalog_complete === true,
        tool_count: event.tool_count ?? 0, schema_ref: event.schema_ref };
    } else if (event.event === "tool_reply_sent") {
      this.lastReply = { observed_at, request_ref: event.request_ref, is_error: event.is_error === true };
    } else if (event.event === "transport_closed") this.closed = true;
  }

  nativeResult(): void { this.nativeResultAt = new Date().toISOString(); }

  snapshot() {
    const observed_at = this.lastReply?.observed_at ?? this.catalog?.observed_at ?? this.initialized?.observed_at;
    const tool: ReadinessFact = {
      status: this.closed ? "not_ready" : observed_at ? "partial" : "unknown",
      source: "local_mcp_transport",
      reason: this.closed ? "transport_closed" : this.catalog && !this.catalog.complete
        ? "partial_catalog" : observed_at ? "remote_poll_and_delivery_not_observed" : "not_observed",
      ...(observed_at ? { observed_at } : {}),
    };
    return {
      ...runtimeReadinessEvidence(tool),
      mcp: {
        initialize: this.initialized ? { ...this.initialized } : null,
        tools_list: this.catalog ? { ...this.catalog } : null,
        native_result_observed_at: this.nativeResultAt ?? null,
        local_reply: this.lastReply ? { ...this.lastReply } : null,
        // Local send/HTTP completion is not a hosted-tunnel poll or a connector delivery ACK.
        control_plane_poll: "unknown",
        remote_discovery: "unknown",
        response_delivery_ack: "unknown",
      },
    };
  }
}
