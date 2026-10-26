import { createHash } from "node:crypto";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isBrokerPreconnectFailure, isBrokerClaimRejection } from "./turn-broker";
import { nativeExecutionReceipt, CODEX_NATIVE_RECEIPT_WIRE_NAME } from "./native-terminal-receipt";

type Message = Record<string, any>;
type Wire = { status: number; headers: [string, string][]; body: string };
type Receipt = { digest: string; done: Promise<Wire>; finish: (wire: Wire) => void; pending: boolean; uncertain: boolean; claimNotDispatched?: boolean; localNotDispatched?: boolean };
const response = (wire: Wire) => new Response(wire.body, {status: wire.status, headers: wire.headers});
const tokenOf = (message: Message) => message.params?.arguments?.turn_token ?? message.params?.arguments?.request_id;
const kindOf = (message: Message) => message.params?.name === "codex_tool_call" ? message.params?.arguments?.wire_name : message.params?.name;
const argsOf = (message: Message) => message.params?.name === "codex_tool_call" ? message.params?.arguments?.arguments : message.params?.arguments;
const MAX_PENDING_RECEIPTS = 256;
const MAX_REPLAY_BODY_CHARS = 2 * 1024 * 1024;
const MAX_REPLAY_CACHE_CHARS = 16 * 1024 * 1024;
const completedWithoutBody: Wire = { status: 409, headers: [], body: "MCP request completed; result not retained; do not redispatch" };

/** Session-scoped MCP identities are not transferable to a fresh initialized
 * session. Preserve accepted requests here until that session closes naturally.
 * Duplicate POSTs join/replay the original receipt, never invoke the SDK twice.
 */
export class McpAdmissionBook {
  private receipts = new Map<string | number, Receipt>();
  private completed = new Map<string | number, string>();
  private replayBodies = new Map<string | number, Wire>();
  private replayBodyChars = 0;
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
  /** Called only by the local SDK handler after proving it never entered Native invoke. */
  noteLocalNotDispatched(id:string|number): boolean {
    const receipt=this.receipts.get(id);
    if (!receipt?.pending) return false;
    receipt.claimNotDispatched=true;
    receipt.localNotDispatched=true;
    return true;
  }
  duplicate(message: Message): Promise<Response> | undefined {
    const prior = this.receipts.get(message.id);
    const priorDigest = prior?.digest ?? this.completed.get(message.id);
    if (!priorDigest) return;
    const digest = createHash("sha256").update(JSON.stringify(message)).digest("hex");
    if (priorDigest !== digest) return Promise.resolve(new Response("MCP request identity conflict; original owner retained", {status: 409}));
    return prior ? prior.done.then(response) : Promise.resolve(response(this.replayBodies.get(message.id) ?? completedWithoutBody));
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
    if (this.receipts.has(message.id) || this.completed.has(message.id)
      || this.receipts.size >= MAX_PENDING_RECEIPTS) return false;
    let finish!: (wire: Wire) => void;
    const done = new Promise<Wire>(resolve => { finish = resolve; });
    this.receipts.set(message.id, {digest: createHash("sha256").update(JSON.stringify(message)).digest("hex"), done, finish, pending: true, uncertain: false});
    const token = tokenOf(message);
    if (typeof token === "string") this.turns.add(token);
    return true;
  }
  async complete(message: Message, incoming: Response, transportFailure = false): Promise<Response> {
    const receipt = this.receipts.get(message.id);
    if (!receipt) return this.duplicate(message)!;
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
    // SDK envelope validation can return a JSON-RPC error before entering claim. A local
    // rejection proof is required; broker proof alone cannot classify an RPC failure. Cancel,
    // timeout, connection loss and unclassified codes remain uncertain even with local proof.
    const localRpcRejection = receipt.localNotDispatched && [ErrorCode.InvalidRequest,
      ErrorCode.MethodNotFound, ErrorCode.InvalidParams, ErrorCode.InternalError].includes(rpc?.error?.code);
    receipt.uncertain = transportFailure || incoming.status >= 500 || !rpc || (Boolean(rpc.error) && !localRpcRejection)
      || (["codex_exec", "exec_command", "exec", "codex_write_stdin", "write_stdin"].includes(kind)
        && execution.state === "unknown" && !receipt.claimNotDispatched)
      || Boolean(result?.isError && !values.some(value => typeof value.exit_code === "number") && !receipt.claimNotDispatched
        && !(this.nativeReceipts && kind === CODEX_NATIVE_RECEIPT_WIRE_NAME));
    const wire = {status: incoming.status, headers: [...incoming.headers.entries()], body};
    // Oversized completed results cannot be re-executed under the old identity.
    const replay = body.length <= MAX_REPLAY_BODY_CHARS ? wire : completedWithoutBody;
    if (!receipt.uncertain) {
      // Keep all session identities as tombstones, but bound full response bodies separately.
      // Terminal history must not consume the capacity reserved for unresolved Native work.
      this.receipts.delete(message.id);
      this.completed.set(message.id, receipt.digest);
      this.replayBodies.set(message.id, replay);
      this.replayBodyChars += replay.body.length;
      while (this.replayBodies.size > MAX_PENDING_RECEIPTS || this.replayBodyChars > MAX_REPLAY_CACHE_CHARS) {
        const oldest = this.replayBodies.keys().next().value!;
        this.replayBodyChars -= this.replayBodies.get(oldest)!.body.length;
        this.replayBodies.delete(oldest);
      }
    }
    receipt.finish(replay);
    return response(wire);
  }
}
