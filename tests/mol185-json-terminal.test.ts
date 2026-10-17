import { expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

const model = "chatgpt-web/mol185-offline";

test.each([
  ["empty", []],
  ["heartbeat only", [{ type: "heartbeat" }]],
  ["partial text", [{ type: "text_delta", text: "unfinished answer" }]],
] as const)("MOL-185 nonstream %s EOF requires an authoritative terminal", (_name, input) => {
  const response = buildResponseJSON([...input] as AdapterEvent[], model);
  expect(response).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "adapter_eof" },
  });
});

test("MOL-185 compaction EOF never fabricates replacement history", () => {
  const response = buildResponseJSON([
    { type: "text_delta", text: "unfinished checkpoint" },
  ], model, { compaction: true });
  expect(response).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "adapter_eof" },
  });
  expect((response.output as Array<{ type: string }>).some(item => item.type === "compaction")).toBe(false);
});

test("MOL-185 explicit done still completes ordinary and compaction responses", () => {
  const events: AdapterEvent[] = [
    { type: "text_delta", text: "complete answer" },
    { type: "done", endTurn: true },
  ];
  expect(buildResponseJSON(events, model).status).toBe("completed");
  const compacted = buildResponseJSON(events, model, { compaction: true });
  expect(compacted.status).toBe("completed");
  expect((compacted.output as Array<{ type: string }>).some(item => item.type === "compaction")).toBe(true);
});

test("MOL-185 streaming EOF already reports incomplete", async () => {
  async function* truncated(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "unfinished answer" };
  }
  const text = await new Response(bridgeToResponsesSSE(truncated(), model)).text();
  expect(text).toContain("event: response.incomplete");
  expect(text).toContain("adapter_eof");
  expect(text).not.toContain("event: response.completed");
});

test("MOL-185 explicit failure remains failed instead of becoming EOF", () => {
  const response = buildResponseJSON([{
    type: "error", message: "injected failure", status: 502,
    errorType: "server_error", code: "upstream_server_error", retryable: false,
  }], model, { compaction: true });
  expect(response).toMatchObject({ status: "failed", retryable: false });
  expect(response.incomplete_details).toBeUndefined();
  expect((response.output as Array<{ type: string }>).some(item => item.type === "compaction")).toBe(false);
});

test("MOL-185 explicit incomplete preserves its reason and usage", () => {
  const response = buildResponseJSON([{
    type: "incomplete", reason: "upstream_stall_timeout", retryable: false,
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  }], model, { compaction: true });
  expect(response).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "upstream_stall_timeout", retryable: false },
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
  expect((response.output as Array<{ type: string }>).some(item => item.type === "compaction")).toBe(false);
});

test("MOL-185 max-token done preserves truncation and cannot compact", () => {
  const response = buildResponseJSON([
    { type: "text_delta", text: "truncated" },
    { type: "done", stopReason: "max_tokens" },
  ], model, { compaction: true });
  expect(response).toMatchObject({
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
  });
  expect((response.output as Array<{ type: string }>).some(item => item.type === "compaction")).toBe(false);
});
