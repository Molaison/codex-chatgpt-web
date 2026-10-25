import type { BrokerToolResult } from "./turn-broker";

/** Reserved operation on the existing generic MCP tool, not a native execution. */
export const CODEX_NATIVE_RECEIPT_WIRE_NAME = "codex_native_receipt";

export type NativeExecutionReceipt = { state: "terminal" } | { state: "running"; sessionId: number } | { state: "unknown" };

/** Native formatter: core/src/tools/context.rs response_header/response_text.
 * Chunk/token headers are optional; running handles and failed exits are lifecycle facts,
 * not permission to rerun a command or evidence that its side effects were successful.
 */
export function nativeExecutionReceipt(result: BrokerToolResult): NativeExecutionReceipt {
  if (result.isError) return { state: "unknown" };
  const receipts: NativeExecutionReceipt[] = [];
  const structured = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const r = value as Record<string, unknown>;
    if (Number.isSafeInteger(r.session_id) && Number(r.session_id) >= 0 && r.exit_code == null) {
      receipts.push({ state: "running", sessionId: Number(r.session_id) });
    } else if (Number.isSafeInteger(r.exit_code) && r.session_id == null) receipts.push({ state: "terminal" });
    else receipts.push({ state: "unknown" });
  };
  if (result.structuredContent !== undefined) structured(result.structuredContent);
  for (const block of result.content) {
    if (!block || typeof block !== "object" || !("text" in block) || typeof block.text !== "string") continue;
    try { structured(JSON.parse(block.text)); continue; } catch { /* Native text is not JSON. */ }
    const match = /^(?:Chunk ID: [0-9a-f]{6}\n)?Wall time: [0-9]+(?:\.[0-9]+)? seconds\n(?:Process exited with code (-?[0-9]+)\n|Process running with session ID ([0-9]+)\n)(?:Original token count: [0-9]+\n)?Output:\n([\s\S]*)$/.exec(block.text);
    if (!match || /^(?:Chunk ID:|Wall time:|Process exited with code |Process running with session ID |Original token count:|Output:)/m.test(match[3]!)) {
      receipts.push({ state: "unknown" });
    } else {
      const value = Number(match[1] ?? match[2]);
      if (!Number.isSafeInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) receipts.push({ state: "unknown" });
      else receipts.push(match[1] !== undefined ? { state: "terminal" } : { state: "running", sessionId: value });
    }
  }
  if (!receipts.length || receipts.some(r => r.state === "unknown")) return { state: "unknown" };
  if (receipts.every(r => r.state === "terminal")) return { state: "terminal" };
  if (receipts.every(r => r.state === "running" && r.sessionId === (receipts[0] as { sessionId: number }).sessionId)) return receipts[0]!;
  return { state: "unknown" };
}
