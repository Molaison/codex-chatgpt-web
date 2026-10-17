import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import type { CodexProviderConfig } from "../src/types";

// The real adapter/session journal handles both the first feed and exact replay.
// Only the browser worker is replaced: no browser/model requests are submitted.
for (const stream of [false, true]) {
  test(`real adapter exact replay retains queue failure through observer wrapping, stream=${stream}`, async () => {
    const id = randomUUID();
    const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://pressure-${id}`,
      chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false } };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    let starts = 0, sends = 0;
    let browserSignal: AbortSignal | undefined;
    let readerStarted = false, consumedTextLength = 0, confirmedBatches = 0, released = false;
    let wakeConsumer: (() => void) | undefined;
    let firstReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const notifyConsumer = () => { const wake = wakeConsumer; wakeConsumer = undefined; wake?.(); };
    const waitForConsumption = async (target: number) => {
      while (!released && (!readerStarted || consumedTextLength < target)) {
        await new Promise<void>(resolve => { wakeConsumer = resolve; });
      }
      if (!released && target > 0) confirmedBatches++;
    };
    const run = spyOn(worker, "run").mockImplementation(async (turn: BrowserTurn) => {
      starts++; browserSignal = turn.abortSignal;
      const prepared = await turn.prepare(); prepared.release();
      sends++; await turn.onSendActivated?.(); await turn.onSubmitted?.();
      // Only the first SSE feed waits for actual body consumption; journal replay stays synchronous.
      if (stream) await waitForConsumption(0);
      for (let n = 0; n < 10001; n++) {
        turn.onTextDelta("x");
        // Keep the final 101 deltas together before returning the authoritative browser answer.
        if (stream && (n + 1) % 100 === 0 && n + 100 < 10001) await waitForConsumption(n + 1);
      }
      return "x".repeat(10001);
    });
    const adapter = createChatGptWebAdapter(provider);
    const body = { model: "chatgpt-web/gpt-5.6-sol-instant", stream,
      input: [{ type: "message", role: "user", id: "pressure-user", content: "controlled browser feed" }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread-${id}`, turn_id: `turn-${id}` }) } };
    const results: any[] = [];
    try {
      for (const attempt of ["feed", "exact-replay"]) {
        const notifications: any[] = [];
        const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }), { ...defaultConfig("browser-only"), useSavedChats: false }, () => adapter,
        { rememberState: false, onAdapterEvent(event) { if (event.type === "error") notifications.push(event); } });
        let wire = "";
        if (stream && attempt === "feed") {
          firstReader = response.body!.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          for (;;) {
            const next = await firstReader.read();
            if (next.done) break;
            const chunk = decoder.decode(next.value, { stream: true });
            wire += chunk; pending += chunk;
            for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
              const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
              if (!line.startsWith("data: {")) continue;
              const event = JSON.parse(line.slice(6));
              // These acknowledgements come from the SSE reader, never onAdapterEvent.
              if (event.type === "response.created") readerStarted = true;
              if (event.type === "response.output_text.delta") consumedTextLength += event.delta.length;
              notifyConsumer();
            }
          }
          firstReader.releaseLock(); firstReader = undefined;
        } else wire = await response.text();
        const frames = stream ? wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))) : [];
        const terminals = stream ? frames.filter(event => ["response.completed", "response.failed", "response.incomplete"].includes(event.type)) : [];
        results.push({ attempt, httpStatus: response.status,
          terminalCount: stream ? terminals.length : 1,
          response: stream ? terminals[0]?.response : JSON.parse(wire),
          doneCount: stream ? wire.split("data: [DONE]").length - 1 : undefined, notifications });
        if (attempt === "feed") {
          // Fail before replay can wait behind a worker whose consumption gate was never reached.
          const feed = results.at(-1)!;
          expect(feed.httpStatus).toBe(200);
          expect(feed.terminalCount).toBe(1);
          expect(feed.response).toMatchObject({ status: "completed" });
          expect(feed.response.output[0].content[0].text).toBe("x".repeat(10001));
          expect(feed.notifications).toHaveLength(0);
          if (stream) expect(feed.doneCount).toBe(1);
        }
      }
      console.info("REAL_ADAPTER_PRESSURE", JSON.stringify({ stream, starts, simulatedSends: sends,
        consumer: stream ? { readerStarted, consumedTextLength, confirmedBatches } : undefined,
        physicalModelSubmissions: 0, results: results.map(r => ({ attempt: r.attempt, httpStatus: r.httpStatus,
          terminalCount: r.terminalCount, status: r.response?.status, error: r.response?.error,
          retryable: r.response?.retryable, errorNotifications: r.notifications.length })) }));
      expect(starts).toBe(1); expect(sends).toBe(1);
      expect(browserSignal?.aborted).toBe(false);
      const [, replay] = results;
      expect(replay.httpStatus).toBe(stream ? 200 : 502);
      expect(replay.terminalCount).toBe(1);
      expect(replay.response).toMatchObject({ status: "failed", error: { code: "adapter_event_backlog_exceeded" }, retryable: false });
      expect(replay.notifications).toHaveLength(1);
      expect(replay.notifications[0]).toMatchObject({ code: "adapter_event_backlog_exceeded", retryable: false });
      if (stream) expect(replay.doneCount).toBe(1);
    } finally {
      // Release both the current wait and any future batch waits after a failed assertion/read.
      released = true; notifyConsumer();
      if (firstReader) { await firstReader.cancel().catch(() => {}); firstReader.releaseLock(); }
      run.mockRestore(); chatGptTurnSessions.clear(); await chatGptTurnSessions.waitForPhysicalSettlement();
    }
  });
}
