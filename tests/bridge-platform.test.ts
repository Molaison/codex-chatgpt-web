import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* completedEvents(chunks = 1): AsyncGenerator<AdapterEvent> {
  for (let index = 0; index < chunks; index++) {
    yield { type: "text_delta", text: `chunk-${index}:` + "x".repeat(2_048) };
  }
  yield { type: "done", endTurn: true };
}

function responseStream(platform: NodeJS.Platform, chunks = 1): ReadableStream<Uint8Array> {
  return bridgeToResponsesSSE(
    completedEvents(chunks),
    "chatgpt-web/test",
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { streamPlatform: platform },
  );
}

test("Responses SSE completes through the Windows push stream", async () => {
  const body = await new Response(responseStream("win32")).text();

  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("Darwin SSE remains decodable through Bun.serve under sustained chunking", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(responseStream("darwin", 64), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain("chunk-63:");
    expect(body).toContain("event: response.completed");
    expect(body).toEndWith("data: [DONE]\n\n");
  } finally {
    await server.stop(true);
  }
});


test("Responses SSE carries inert widget data before the terminal snapshot", async () => {
  const widget = { version: 1 as const, kind: "cartesian_chart" as const, id: "chart-1",
    mark: "bar" as const, title: "Activity", xField: "x", yField: "y",
    points: [{x:"WT", y:1.5}] };
  async function* events(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "Results" };
    yield { type: "rich_widget", widget };
    yield { type: "done", endTurn: true };
  }
  const body = await new Response(bridgeToResponsesSSE(events(), "papers/gpt-6-sol")).text();
  const records = body.split("\n\n").filter(frame => frame.includes("data: {")).map(frame => {
    const data = frame.split("\n").find(line => line.startsWith("data: {"))!;
    return JSON.parse(data.slice(6));
  });
  const widgetIndex = records.findIndex(row => row.type === "response.rich_widget.done");
  const completeIndex = records.findIndex(row => row.type === "response.completed");
  expect(widgetIndex).toBeGreaterThan(-1);
  expect(completeIndex).toBeGreaterThan(widgetIndex);
  expect(records[widgetIndex].widget).toEqual(widget);
  expect(records[completeIndex].response.rich_widgets).toEqual([widget]);
});
