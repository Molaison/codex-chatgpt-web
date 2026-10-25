import { createHash } from "node:crypto";
import { isBrokerPreconnectFailure, isBrokerClaimRejection } from "./turn-broker";
import { nativeExecutionReceipt, CODEX_NATIVE_RECEIPT_WIRE_NAME } from "./native-terminal-receipt";

type Message = Record<string, any>;
type Wire = { status: number; headers: [string, string][]; body: string };
type Receipt = { digest: string; done: Promise<Wire>; finish: (wire: Wire) => void; pending: boolean; uncertain: boolean; claimNotDispatched?: boolean };
const response = (wire: Wire) => new Response(wire.body, {status: wire.status, headers: wire.headers});
const tokenOf = (message: Message) => message.params?.arguments?.turn_token ?? message.params?.arguments?.request_id;
const kindOf = (message: Message) => message.params?.name === "codex_tool_call" ? message.params?.arguments?.wire_name : message.params?.name;
const argsOf = (message: Message) => message.params?.name === "codex_tool_call" ? message.params?.arguments?.arguments : message.params?.arguments;

/** Session-scoped MCP identities are not transferable to a fresh initialized
 * session. Preserve accepted requests here until that session closes naturally.
 * Duplicate POSTs join/replay the original receipt, never invoke the SDK twice.
 */
export class McpAdmissionBook {
  private receipts = new Map<string | number, Receipt>();
  private processes = new Set<string>();
  private closedProcesses = new Set<string>();
  private agents = new Set<string>();
  private turns = new Set<string>();
  constructor(private readonly onProcessClosed?: (token: string, sessionId: number) => void,
    private readonly nativeReceipts = false) {}
  get pending() { return [...this.receipts.values()].filter(r => r.pending).length; }
  get uncertain() { return [...this.receipts.values()].filter(r => r.uncertain).length; }
  get continuations() { return this.processes.size + this.agents.size; }
  get canClose() { return this.pending === 0 && this.uncertain === 0 && this.continuations === 0; }
  noteProcessClosed(token: string, sessionId: number) {
    const key = JSON.stringify([token, sessionId]);
    if (!this.turns.has(token) && !this.processes.has(key)) return;
    this.closedProcesses.add(key);
    this.processes.delete(key);
  }
  noteClaimNotDispatched(id: string | number, proof: unknown): boolean {
    const receipt = this.receipts.get(id);
    // Completed/legacy uncertain receipts are immutable: this is not a reconcile operation.
    if (!receipt?.pending || (!isBrokerPreconnectFailure(proof) && !isBrokerClaimRejection(proof)) || proof.method !== "claim") return false;
    receipt.claimNotDispatched = true;
    return true;
  }
  duplicate(message: Message): Promise<Response> | undefined {
    const prior = this.receipts.get(message.id);
    if (!prior) return;
    const digest = createHash("sha256").update(JSON.stringify(message)).digest("hex");
    if (prior.digest !== digest) return Promise.resolve(new Response("MCP request identity conflict; original owner retained", {status: 409}));
    return prior.done.then(response);
  }
  allowed(message: Message, draining: boolean): boolean {
    if (!draining) return true;
    const token = tokenOf(message), kind = kindOf(message), args = argsOf(message);
    if (typeof token !== "string") return false;
    if (kind === "codex_turn_complete") return this.turns.has(token);
    if (this.nativeReceipts && kind === CODEX_NATIVE_RECEIPT_WIRE_NAME) return this.turns.has(token);
    if (kind === "codex_write_stdin" || kind === "write_stdin") return this.processes.has(JSON.stringify([token, args?.session_id]));
    if (kind === "multi_agent_v1__wait_agent") {
      const ids = args?.agent_ids ?? (args?.agent_id ? [args.agent_id] : []);
      return Array.isArray(ids) && ids.length > 0 && ids.every(id => this.agents.has(JSON.stringify([token, id])));
    }
    return false;
  }
  begin(message: Message): boolean {
    if (this.receipts.size >= 256) return false; // Do not evict accepted identities and silently permit replay.
    let finish!: (wire: Wire) => void;
    const done = new Promise<Wire>(resolve => { finish = resolve; });
    this.receipts.set(message.id, {digest: createHash("sha256").update(JSON.stringify(message)).digest("hex"), done, finish, pending: true, uncertain: false});
    const token = tokenOf(message);
    if (typeof token === "string") this.turns.add(token);
    return true;
  }
  async complete(message: Message, incoming: Response, transportFailure = false): Promise<Response> {
    const receipt = this.receipts.get(message.id)!;
    if (!receipt.pending) return receipt.done.then(response);
    const body = await incoming.text();
    let rpc: Message | undefined;
    try { rpc = JSON.parse(body); } catch { /* A failed transport is retained as uncertain, never redispatched. */ }
    const result = rpc?.result;
    const values: Message[] = [];
    if (result?.structuredContent && typeof result.structuredContent === "object") values.push(result.structuredContent);
    for (const content of result?.content ?? []) {
      if (content.type !== "text") continue;
      try { const value = JSON.parse(content.text); if (value && typeof value === "object") values.push(value); } catch { /* Native text envelopes are parsed below. */ }
    }
    const token = tokenOf(message), kind = kindOf(message), args = argsOf(message);
    const execution = result && Array.isArray(result.content) ? nativeExecutionReceipt(result) : { state: "unknown" as const };
    if (execution.state === "running" && ["codex_exec", "exec_command", "exec", "codex_write_stdin", "write_stdin"].includes(kind)) {
      const key = JSON.stringify([token, execution.sessionId]);
      if (["codex_exec", "exec_command", "exec"].includes(kind)) this.closedProcesses.delete(key);
      if (!this.closedProcesses.has(key)) this.processes.add(key);
    }
    for (const value of values) {
      if (typeof value.agent_id === "string") this.agents.add(JSON.stringify([token, value.agent_id]));
      for (const [id, status] of Object.entries(value.status ?? {})) {
        if (status && typeof status === "object" && ("completed" in status || "errored" in status || "shutdown" in status)) this.agents.delete(JSON.stringify([token, id]));
      }
    }
    if ((kind === "codex_write_stdin" || kind === "write_stdin") && execution.state === "terminal") {
      this.noteProcessClosed(token, args?.session_id);
      this.onProcessClosed?.(token, args?.session_id);
    }
    if (kind === "codex_turn_complete" && !result?.isError && !rpc?.error) this.turns.delete(token);
    receipt.pending = false;
    receipt.uncertain = transportFailure || incoming.status >= 500 || !rpc || Boolean(rpc.error)
      || (["codex_exec", "exec_command", "exec", "codex_write_stdin", "write_stdin"].includes(kind)
        && execution.state === "unknown" && !receipt.claimNotDispatched)
      || Boolean(result?.isError && !values.some(value => typeof value.exit_code === "number") && !receipt.claimNotDispatched
        && !(this.nativeReceipts && kind === CODEX_NATIVE_RECEIPT_WIRE_NAME));
    const wire = {status: incoming.status, headers: [...incoming.headers.entries()], body};
    // Oversized completed results cannot be re-executed under the old identity.
    receipt.finish(body.length <= 2 * 1024 * 1024 ? wire : {status: 409, headers: [], body: "MCP request completed; result not retained; do not redispatch"});
    return response(wire);
  }
}
