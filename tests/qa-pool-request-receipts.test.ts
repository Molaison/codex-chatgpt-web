import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaPool, normalizeQaPoolRequest, type QaPoolConfig } from "../src/qa-pool";
import { ChatGptTurnSessions, ChatGptTraceFeed, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { MAX_CHATGPT_BROWSER_TABS } from "../src/adapters/chatgpt-web/concurrency";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { installReadyQaHealthFixture } from "./qa-pool-health-fixture";

installReadyQaHealthFixture();

// Real pool routing and SQLite; only the external backend is replaced. Counts
// prove forwards at this boundary, not physical browser Sends or CPR integration.
function payload(turn: string, text = "RECEIPT_CANARY", previous?: string, stream = false) {
  return { model: "standard", stream, reasoning: { effort: "high-temporary" },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
    ...(previous ? { previous_response_id: previous } : {}),
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "receipt-thread", turn_id: turn }) } };
}
function fixture(maxPages?: number) {
  const root = mkdtempSync(join(tmpdir(), "qa-request-receipts-")), key = "r".repeat(32);
  writeFileSync(join(root, "key"), key);
  const otherKey = "s".repeat(32); writeFileSync(join(root, "other-key"), otherKey);
  const config: QaPoolConfig = { host: "127.0.0.1", port: 0, databasePath: join(root, "pool.sqlite"),
    clients: [{ id: "receipt-client", keyFile: join(root, "key") }, { id: "other-client", keyFile: join(root, "other-key") }],
    accounts: [{ id: "receipt-account", origin: "http://127.0.0.1:9", models: ["standard"], sessionModes: true }] };
  const calls: any[] = [], upstreamSignals: Array<AbortSignal | null | undefined> = [], originalFetch = globalThis.fetch;
  let respond: (body: any) => Response | Promise<Response> = (body: any) => {
    const response = { id: `receipt-response-${calls.length}`, status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: `ANSWER_${calls.length}` }] }] };
    return body.stream ? new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }) : Response.json(response);
  };
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(init!.body as string); calls.push(body); upstreamSignals.push(init?.signal); return respond(body);
  }) as typeof fetch;
  let pageLimitHook: ReturnType<typeof spyOn> | undefined;
  if (maxPages !== undefined) {
    const originalExec = Database.prototype.exec;
    pageLimitHook = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: any, ...args: any[]) {
      const result = originalExec.call(this, sql, ...args);
      if (String(sql).includes("PRAGMA journal_mode")) originalExec.call(this, `PRAGMA max_page_count=${maxPages}`);
      return result;
    });
  }
  let pool: ReturnType<typeof createQaPool>;
  try { pool = createQaPool(config); } finally { pageLimitHook?.mockRestore(); }
  let open = true;
  const stop = () => { if (open) { pool.close(); open = false; } };
  return { calls, upstreamSignals, config, root, key,
    request: (body: object, otherClient = false, path = "/v1/responses", signal?: AbortSignal) => pool.fetch(new Request("http://pool" + path, { method: "POST",
      headers: { authorization: `Bearer ${otherClient ? otherKey : key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal })),
    rows: (query: string) => { const db = new Database(config.databasePath); try { return db.query(query).all(); } finally { db.close(); } },
    sql: (query: string) => { const db = new Database(config.databasePath); try { db.exec(query); } finally { db.close(); } },
    respond: (next: typeof respond) => { respond = next; },
    stop,
    restart: () => { stop(); pool = createQaPool(config); open = true; },
    close: () => { stop(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); },
  };
}

test("missing message IDs are stable for a native turn and distinct for a new turn", () => {
  const first = normalizeQaPoolRequest(payload("turn-one"), new Headers(), "transport-one");
  const retry = normalizeQaPoolRequest(payload("turn-one"), new Headers(), "transport-two");
  const next = normalizeQaPoolRequest(payload("turn-two"), new Headers(), "transport-three");
  const ids = (value: typeof first) => (value.payload.input as any[]).map(item => item.id);
  expect(ids(first)).toEqual(ids(retry));
  expect(ids(first)).not.toEqual(ids(next));
});

for (const stream of [false, true]) {
  test(`completed ${stream ? "stream" : "JSON"} receipt replays original previous head after restart`, async () => {
    const f = fixture();
    try {
      const seed = await f.request(payload("seed", "SEED_CONTEXT"));
      expect(seed.status).toBe(200); const r1 = (await seed.json()).id;
      const body = payload("second", "SECOND_QUESTION", r1, stream);
      const second = await f.request(body);
      expect(second.status).toBe(200);
      // Consume at the pool boundary, then discard delivery. This represents a
      // saved terminal result the caller did not retain, not a live TCP loss.
      const saved = await second.text();
      expect(saved).toContain("receipt-response-2");
      f.restart();
      const replay = await f.request(body), replayText = await replay.text();
      expect(replay.status).toBe(200);
      expect(replayText).toContain("receipt-response-2");
      expect(replayText).toContain("ANSWER_2");
      expect(f.calls).toHaveLength(2);
      const stale = await f.request(payload("unrelated-third", "THIRD_QUESTION", r1));
      expect(stale.status).toBe(409);
      expect(f.calls).toHaveLength(2);
    } finally { f.close(); }
  });
}

test("history write failure leaves a durable barrier to a context-free next turn", async () => {
  const f = fixture();
  try {
    f.sql("CREATE TRIGGER reject_history BEFORE INSERT ON temporary_history BEGIN SELECT RAISE(ABORT, 'injected history storage failure'); END");
    const failed = await f.request(payload("first", "REMEMBER_OLD_CONTEXT"));
    expect(failed.status).toBeGreaterThanOrEqual(400); await failed.text();
    expect(f.calls).toHaveLength(1);
    f.sql("DROP TRIGGER reject_history"); f.restart();
    const next = await f.request(payload("next", "WHAT_WAS_OLD_CONTEXT"));
    await next.text();
    expect(next.status).toBe(409);
    expect(f.calls).toHaveLength(1);
    const retry = await f.request(payload("first", "REMEMBER_OLD_CONTEXT"));
    expect(retry.status).toBeGreaterThanOrEqual(400); await retry.text();
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test("same native turn retries replay while intentional identical text in a new turn forwards", async () => {
  const f = fixture();
  try {
    const first = await f.request(payload("one")); expect(first.status).toBe(200);
    const firstId = (await first.json()).id;
    f.restart();
    const retry = await f.request(payload("one")); expect(retry.status).toBe(200);
    expect((await retry.json()).id).toBe(firstId); expect(f.calls).toHaveLength(1);
    const next = await f.request(payload("two")); expect(next.status).toBe(200);
    expect((await next.json()).id).not.toBe(firstId); expect(f.calls).toHaveLength(2);
  } finally { f.close(); }
});

test("reusing a native turn with changed input rejects rather than replaying or forwarding", async () => {
  const f = fixture();
  try {
    const first = await f.request(payload("one", "ORIGINAL")); expect(first.status).toBe(200); await first.text();
    const conflict = await f.request(payload("one", "CHANGED"));
    expect(conflict.status).toBe(409); await conflict.text(); expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test("identical thread and turn across authenticated client scopes do not share receipts", async () => {
  const f = fixture();
  try {
    const first = await f.request(payload("one")); expect(first.status).toBe(200);
    const firstId = (await first.json()).id;
    const other = await f.request(payload("one"), true); expect(other.status).toBe(200);
    expect((await other.json()).id).not.toBe(firstId); expect(f.calls).toHaveLength(2);
    expect(f.calls[0].client_metadata["x-codex-turn-metadata"]).not.toBe(f.calls[1].client_metadata["x-codex-turn-metadata"]);
    const retry = await f.request(payload("one")); expect(retry.status).toBe(200);
    expect((await retry.json()).id).toBe(firstId); expect(f.calls).toHaveLength(2);
  } finally { f.close(); }
});

test("failure to persist the pending barrier prevents any backend forward", async () => {
  const f = fixture();
  try {
    f.sql("CREATE TRIGGER reject_pending BEFORE UPDATE OF pending_history_turn ON sessions WHEN NEW.pending_history_turn IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected pending storage failure'); END");
    const response = await f.request(payload("one"));
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("temporary_history_unavailable");
    expect(f.calls).toHaveLength(0);
  } finally { f.close(); }
});

test("a same-process observer reconnect joins the accepted request and receives its complete wire", async () => {
  const f = fixture(), abort = new AbortController();
  const created = 'data: {"type":"response.created","response":{"id":"held-response","status":"in_progress","output":[]}}\n\n';
  const terminal = 'data: {"type":"response.completed","response":{"id":"held-response","status":"completed","output":[]}}\n\n';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let replay: Promise<Response> | undefined;
  try {
    f.respond(() => {
      let started = false;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!started) { started = true; controller.enqueue(new TextEncoder().encode(created)); return; }
          await gate; controller.enqueue(new TextEncoder().encode(terminal)); controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const body = payload("one", "ACCEPTED_RECONNECT", undefined, true);
    const first = await f.request(body, false, "/v1/responses", abort.signal);
    expect(first.status).toBe(200);
    const observer = first.body!.getReader();
    expect(new TextDecoder().decode((await observer.read()).value)).toBe(created);
    abort.abort(); await observer.cancel("observer disconnected after acceptance");
    expect(f.upstreamSignals[0]?.aborted ?? false).toBe(false);
    replay = f.request(body);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.calls).toHaveLength(1);
    release();
    const response = await replay; expect(response.status).toBe(200);
    expect(await response.text()).toBe(created + terminal);
    expect(f.calls).toHaveLength(1);
  } finally { release(); await replay; f.close(); }
}, 5000);

test("unknown upstream outcome remains blocked after restart", async () => {
  const f = fixture();
  try {
    f.respond(() => { throw new Error("injected disconnect after possible submission"); });
    const failed = await f.request(payload("one")); expect(failed.status).toBe(502); await failed.text();
    f.restart();
    const retry = await f.request(payload("one")); expect(retry.status).toBe(409); await retry.text();
    const next = await f.request(payload("two")); expect(next.status).toBe(409); await next.text();
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

for (const ending of ["malformed", "eof", "cancel"] as const) {
  test(`a ${ending} stream without a saved terminal cannot unlock the next temporary turn`, async () => {
    const f = fixture();
    try {
      const chunk = ending === "malformed" ? "data: {broken-json}\n\n" : 'data: {"type":"response.in_progress"}\n\n';
      f.respond(() => new Response(chunk, { headers: { "content-type": "text/event-stream" } }));
      const response = await f.request(payload("one", "STREAM_CONTEXT", undefined, true));
      expect(response.status).toBe(200);
      if (ending === "cancel") await response.body!.cancel("simulated observer cancellation");
      else if (ending === "malformed") await expect(response.text()).rejects.toThrow();
      else await response.text();
      f.restart();
      const next = await f.request(payload("two")); expect(next.status).toBe(409); await next.text();
      expect(f.calls).toHaveLength(1);
    } finally { f.close(); }
  });
}

test("legacy temporary requests without a stable turn still retain the uncertainty barrier", async () => {
  const f = fixture();
  try {
    const legacy = { ...payload("unused"), client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "legacy-thread" }) } };
    f.respond(() => { throw new Error("injected unknown outcome"); });
    const failed = await f.request(legacy); expect(failed.status).toBe(502); await failed.text();
    f.restart(); const retry = await f.request(legacy);
    expect(retry.status).toBe(409); await retry.text(); expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test("expired latest receipt removes cached content and cannot replay stale output", async () => {
  const f = fixture();
  try {
    const first = await f.request(payload("one", "PRIVATE_INPUT_CANARY")); expect(first.status).toBe(200); await first.text();
    f.sql("UPDATE qa_request_receipts SET expires_at=0"); f.restart();
    expect(f.rows("SELECT digest, response_json, state FROM qa_request_receipts")).toEqual([
      { digest: null, response_json: null, state: "expired" },
    ]);
    const retry = await f.request(payload("one", "PRIVATE_INPUT_CANARY"));
    expect(retry.status).toBe(409); expect((await retry.json()).error.code).toBe("request_receipt_expired");
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test("receipt retention is independent of turn count rather than capped at 256", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 270; index++) {
      const response = await f.request(payload(`turn-${index}`, `SYNTHETIC_${index}`));
      expect(response.status).toBe(200); await response.text();
    }
    expect(f.rows("SELECT COUNT(*) AS n FROM qa_request_receipts")).toEqual([{ n: 270 }]);
    expect(f.calls).toHaveLength(270);
    f.restart();
    const latest = await f.request(payload("turn-269", "SYNTHETIC_269"));
    expect(latest.status).toBe(200); expect((await latest.json()).id).toBe("receipt-response-270");
    expect(f.calls).toHaveLength(270);
  } finally { f.close(); }
}, 30_000);

test("distinct tool rounds and explicit Steer message IDs in one native turn are not collapsed", async () => {
  const f = fixture();
  try {
    const first = payload("one");
    const initial = await f.request(first); expect(initial.status).toBe(200); await initial.text();
    const toolRound = { ...first, input: [...first.input,
      { type: "function_call_output", call_id: "call-one", output: "TOOL_RESULT" }] };
    const tool = await f.request(toolRound); expect(tool.status).toBe(200);
    const toolId = (await tool.json()).id; expect(f.calls).toHaveLength(2);
    const replay = await f.request(toolRound); expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe(toolId); expect(f.calls).toHaveLength(2);
    const steer = { ...first, input: [{ ...first.input[0], id: "new-steer-message" }] };
    const steered = await f.request(steer); expect(steered.status).toBe(200); await steered.text();
    expect(f.calls).toHaveLength(3);
  } finally { f.close(); }
});

test("successful promotion removes cached responses and blocks duplicate promotion", async () => {
  const f = fixture();
  try {
    const seed = await f.request(payload("seed")); expect(seed.status).toBe(200); const id = (await seed.json()).id;
    const promote = { ...payload("promotion", "KEEP_CONTEXT", id), reasoning: { effort: "high-persistent" } };
    const first = await f.request(promote); expect(first.status).toBe(200); await first.text();
    f.restart(); const retry = await f.request(promote); expect(retry.status).toBe(409);
    expect((await retry.json()).error.code).toBe("request_completed_unretained"); expect(f.calls).toHaveLength(2);
    expect(f.rows("SELECT COUNT(*) AS n FROM qa_request_receipts WHERE digest IS NOT NULL OR response_json IS NOT NULL")).toEqual([{ n: 0 }]);
  } finally { f.close(); }
});

test("pure persistent turns do not introduce a durable response cache", async () => {
  const f = fixture();
  try {
    const body = { ...payload("one"), reasoning: { effort: "high-persistent" } };
    const first = await f.request(body); expect(first.status).toBe(200); await first.text();
    expect(f.rows("SELECT COUNT(*) AS n FROM qa_request_receipts")).toEqual([{ n: 0 }]);
    expect(f.rows("SELECT pending_history_turn FROM sessions")).toEqual([{ pending_history_turn: null }]);
  } finally { f.close(); }
});

test("an explicit pre-Send attachment rejection releases the request for a safe retry", async () => {
  const f = fixture();
  try {
    f.respond(() => Response.json({ error: { code: "prompt_attachments_not_submitted" } }, { status: 502 }));
    const rejected = await f.request(payload("one")); expect(rejected.status).toBe(502); await rejected.text();
    f.restart();
    f.respond(() => Response.json({ id: "safe-retry", status: "completed", output: [] }));
    const retry = await f.request(payload("one")); expect(retry.status).toBe(200);
    expect((await retry.json()).id).toBe("safe-retry"); expect(f.calls).toHaveLength(2);
  } finally { f.close(); }
});

test("stream replay preserves incremental consumer text and structured output events", async () => {
  const f = fixture();
  const output = [
    { id: "message-one", type: "message", role: "assistant", status: "completed", content: [
      { type: "output_text", text: "FIRST ", annotations: [{ type: "url_citation", url: "https://example.com/", title: "Synthetic", start_index: 0, end_index: 5 }] },
      { type: "output_text", text: "SECOND", annotations: [] }] },
    { id: "function-one", type: "function_call", call_id: "call-one", name: "synthetic", namespace: "test", arguments: '{"value":1}', encrypted_function_args: "synthetic-encrypted-args", status: "completed" },
    { id: "reasoning-one", type: "reasoning", encrypted_content: "synthetic-encrypted-reasoning", summary: [] },
    { id: "custom-one", type: "custom_tool_call", call_id: "custom-call", name: "custom", input: "SYNTHETIC", status: "completed" },
    { id: "compact-one", type: "compaction", encrypted_content: "synthetic-encrypted-compaction" },
  ];
  try {
    const terminal = { id: "rich-response", status: "completed", output };
    const wireEvents: any[] = [{ type: "response.created", response: { ...terminal, status: "in_progress", output: [] } }];
    output.forEach((item, output_index) => {
      wireEvents.push({ type: "response.output_item.added", output_index, item });
      if (item.type === "message") item.content!.forEach((part, content_index) => {
        const position = { item_id: item.id, output_index, content_index };
        wireEvents.push({ type: "response.content_part.added", ...position, part: { ...part, text: "" } },
          { type: "response.output_text.delta", ...position, delta: part.text },
          { type: "response.output_text.done", ...position, text: part.text },
          { type: "response.content_part.done", ...position, part });
      });
      if (item.type === "function_call") wireEvents.push(
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments });
      wireEvents.push({ type: "response.output_item.done", output_index, item });
    });
    wireEvents.push({ type: "response.completed", response: terminal });
    const wire = wireEvents.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
    f.respond(() => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
    const body = payload("one", "RICH_OUTPUT", undefined, true);
    const initial = await f.request(body); expect(initial.status).toBe(200); await initial.text();
    const replay = await f.request(body); expect(replay.status).toBe(200);
    const replayWire = await replay.text();
    expect(replayWire).toBe(wire);
    const events = replayWire.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.slice(6)));
    const done = events.filter(event => event.type === "response.output_item.done");
    expect(done.map(event => event.item)).toEqual(output);
    expect(done.map(event => event.output_index)).toEqual([0, 1, 2, 3, 4]);
    expect(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("")).toBe("FIRST SECOND");
    expect(events.filter(event => event.type === "response.output_text.done").map(event => event.text)).toEqual(["FIRST ", "SECOND"]);
    expect(events.filter(event => event.type === "response.content_part.done").map(event => event.part)).toEqual(output[0].content!);
    expect(events.filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join("")).toBe('{"value":1}');
    expect(events.filter(event => event.type === "response.function_call_arguments.done").map(event => event.arguments)).toEqual(['{"value":1}']);
    expect(events[0].type).toBe("response.created"); expect(events[0].response.id).toBe("rich-response");
    expect(events.at(-1).type).toBe("response.completed"); expect(events.at(-1).response).toEqual(terminal);
    expect(events.filter(event => event.type === "response.completed")).toHaveLength(1);
    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

for (const newline of ["\n", "\r\n"]) {
  test(`replayed ${newline.length === 1 ? "LF" : "CRLF"} terminal retains a split frame delimiter`, async () => {
    const f = fixture();
    try {
      const terminal = { type: "response.completed", response: { id: "split-terminal", status: "completed", output: [] } };
      const line = `data: ${JSON.stringify(terminal)}${newline}`;
      const chunks = [line, `${newline}data: {"partial":`];
      f.respond(() => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { const chunk = chunks.shift(); if (chunk === undefined) controller.close(); else controller.enqueue(new TextEncoder().encode(chunk)); },
      }), { headers: { "content-type": "text/event-stream" } }));
      const body = payload("one", "SPLIT_FRAME", undefined, true);
      const first = await f.request(body); await first.text(); f.restart();
      const replay = await f.request(body); expect(replay.status).toBe(200);
      const wire = await replay.text(); expect(wire).toBe(line + newline);
      const completeFrames = wire.split(newline + newline); expect(completeFrames.pop()).toBe("");
      expect(completeFrames.map(frame => JSON.parse(frame.slice(6)))).toEqual([terminal]);
      expect(f.calls).toHaveLength(1);
    } finally { f.close(); }
  });
}

for (const stream of [false, true]) {
  test(`oversized ${stream ? "stream" : "JSON"} response delivers normally without a replay cache`, async () => {
    const f = fixture();
    try {
      const response = { id: "oversized", status: "completed", output: [{ type: "message", role: "assistant", content: [
        { type: "output_text", text: "x".repeat(1024 * 1024 + 1) }] }] };
      f.respond(() => stream ? new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }) : Response.json(response));
      const first = await f.request(payload("one", "LARGE_RESULT", undefined, stream));
      expect(first.status).toBe(200);
      const delivered = await first.text(); expect(delivered).toContain('"id":"oversized"');
      expect(delivered).toContain('"status":"completed"');
      expect(f.rows("SELECT response_id FROM temporary_history")).toEqual([{ response_id: "oversized" }]);
      f.restart();
      const retry = await f.request(payload("one", "LARGE_RESULT", undefined, stream));
      expect(retry.status).toBe(409); expect((await retry.json()).error.code).toBe("request_completed_unretained"); expect(f.calls).toHaveLength(1);
      expect(f.rows("SELECT response_json, state FROM qa_request_receipts")).toEqual([{ response_json: null, state: "completed_unretained" }]);
    } finally { f.close(); }
  });
}

test("compact success does not leave a pending marker that blocks ordinary continuation", async () => {
  const f = fixture();
  try {
    const seed = await f.request(payload("seed")); expect(seed.status).toBe(200); await seed.text();
    f.respond(() => Response.json({ id: "compact-response", object: "response.compaction", output: [] }));
    const compact = await f.request(payload("compact"), false, "/v1/responses/compact");
    expect(compact.status).toBe(200); await compact.text();
    expect(f.rows("SELECT pending_history_turn FROM sessions")).toEqual([{ pending_history_turn: null }]);
    f.respond(() => Response.json({ id: "continued", status: "completed", output: [] }));
    const next = await f.request(payload("next")); expect(next.status).toBe(200); await next.text();
    expect(f.calls).toHaveLength(3);
  } finally { f.close(); }
});

test("new completion rolls latest receipt and history expiry together while replay does not extend either", async () => {
  const f = fixture();
  try {
    const seed = await f.request(payload("seed")); expect(seed.status).toBe(200); await seed.text();
    const oldDeadline = Date.now() + 60_000;
    f.sql(`UPDATE temporary_history SET expires_at=${oldDeadline}`);
    const before = Date.now();
    const next = await f.request(payload("next")); expect(next.status).toBe(200); await next.text();
    const after = Date.now();
    const expiries = () => f.rows("SELECT h.expires_at AS history_expiry, r.expires_at AS receipt_expiry FROM temporary_history h JOIN qa_request_receipts r USING (session_hash) ORDER BY r.expires_at DESC") as Array<{ history_expiry: number; receipt_expiry: number }>;
    const saved = expiries(); expect(saved).toHaveLength(2);
    expect(saved[0].receipt_expiry).toBe(saved[0].history_expiry);
    expect(saved[0].receipt_expiry).toBeGreaterThan(oldDeadline);
    expect(saved[0].receipt_expiry).toBeGreaterThanOrEqual(before + 48 * 60 * 60 * 1000);
    expect(saved[0].receipt_expiry).toBeLessThanOrEqual(after + 48 * 60 * 60 * 1000);
    await Bun.sleep(5);
    const replay = await f.request(payload("next")); expect(replay.status).toBe(200); await replay.text();
    expect(expiries()).toEqual(saved); expect(f.calls).toHaveLength(2);
  } finally { f.close(); }
});

test("pool shutdown settles an attached replay without claiming completion or losing uncertainty", async () => {
  const f = fixture();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    f.respond(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"shutdown-response"}}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } }));
    const body = payload("one", "SHUTDOWN_PENDING", undefined, true);
    const first = await f.request(body); const reader = first.body!.getReader(); await reader.read(); await reader.cancel();
    const replay = f.request(body).then(async response => ({ status: response.status, body: await response.text() })).catch(() => ({ status: 0, body: "" }));
    await new Promise(resolve => setTimeout(resolve, 10)); f.stop();
    const result = await Promise.race([replay, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("pool shutdown left the replay pending")), 1000);
    })]);
    expect(result.body).not.toContain('"type":"response.completed"');
    expect(f.calls).toHaveLength(1);
    f.restart();
    const retry = await f.request(body); expect(retry.status).toBe(409); await retry.text();
    expect(f.calls).toHaveLength(1);
  } finally { clearTimeout(timer); f.close(); }
}, 3000);

test("real admission rejection before worker start permits recovery and the next temporary question", async () => {
  const f = fixture(), sessions = new ChatGptTurnSessions();
  const finish: Array<() => void> = [];
  let acceptedWorkers = 0;
  try {
    for (let index = 0; index < MAX_CHATGPT_BROWSER_TABS; index++) sessions.getOrCreate(`occupied-${index}`, () => {
      const browser = new Promise<string>(resolve => finish.push(() => resolve("SETTLED")));
      return { mode: "read-only", browser, physicalSettlement: browser.then(() => {}),
        trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} };
    });
    f.respond(body => responseRequest(new Request("http://backend/v1/responses", {
      method: "POST", body: JSON.stringify({ ...body, model: "chatgpt-web/high" }),
    }), defaultConfig("browser-only"), () => ({ name: "real-admission-test",
      async runTurn(_parsed, _incoming, emit) {
        sessions.getOrCreate(`request-${f.calls.length}`, () => {
          acceptedWorkers++;
          const browser = Promise.resolve("ACCEPTED");
          return { mode: "read-only", browser, physicalSettlement: browser.then(() => {}),
            trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} };
        });
        emit({ type: "text_delta", text: "RECOVERED", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }), { rememberState: false }));
    const body = payload("admission");
    const rejected = await f.request(body); expect(rejected.status).toBe(429);
    expect((await rejected.json()).error.code).toBe("concurrency_limit_exceeded");
    expect(acceptedWorkers).toBe(0);
    finish[0]!(); await Bun.sleep(0);
    const retry = await f.request(body); expect(retry.status).toBe(200);
    expect((await retry.json()).status).toBe("completed"); expect(acceptedWorkers).toBe(1);
    await Bun.sleep(0);
    const next = await f.request(payload("after-admission")); expect(next.status).toBe(200);
    expect((await next.json()).status).toBe("completed"); expect(acceptedWorkers).toBe(2);
  } finally { for (const resolve of finish) resolve(); sessions.clear(); f.close(); }
});

test("a second pool committing between history read and reservation prevents stale forwarding", async () => {
  const f = fixture();
  let hook: ReturnType<typeof spyOn> | undefined;
  try {
    const seed = await f.request(payload("seed", "ORIGINAL_CONTEXT")); expect(seed.status).toBe(200);
    const originalHead = (await seed.json()).id;
    const childScript = join(f.root, "second-pool.ts");
    writeFileSync(childScript, `
import { createQaPool } from ${JSON.stringify(join(import.meta.dir, "../src/qa-pool.ts"))};
const { config, key, body } = await Bun.stdin.json();
let forwards = 0;
globalThis.fetch = async () => { forwards++; return Response.json({ id: "concurrent-head", status: "completed", output: [
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "CONCURRENT_CONTEXT" }] }] }); };
const pool = createQaPool(config);
try {
  const response = await pool.fetch(new Request("http://pool/v1/responses", { method: "POST", headers: {
    authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(body) }));
  console.log(JSON.stringify({ status: response.status, response: await response.json(), forwards }));
} finally { pool.close(); }
`);
    const originalTransaction = Database.prototype.transaction;
    let injected = false, concurrent: any;
    hook = spyOn(Database.prototype, "transaction").mockImplementation(function (this: Database, fn: any) {
      const transaction = originalTransaction.call(this, fn) as any;
      const immediate = transaction.immediate;
      const wrapped: any = (...args: any[]) => transaction(...args);
      wrapped.immediate = (...args: any[]) => {
        if (!injected) {
          injected = true;
          const result = Bun.spawnSync([process.execPath, childScript], { stdin: Buffer.from(JSON.stringify({
            config: f.config, key: f.key, body: payload("concurrent", "SECOND_POOL_QUESTION", originalHead),
          })), stdout: "pipe", stderr: "pipe", timeout: 3000 });
          if (result.exitCode !== 0) throw new Error(`Second pool failed: ${new TextDecoder().decode(result.stderr)}`);
          concurrent = JSON.parse(new TextDecoder().decode(result.stdout));
        }
        return immediate(...args);
      };
      return wrapped;
    });
    const stale = await f.request(payload("stale", "FIRST_POOL_STALE_QUESTION", originalHead));
    hook.mockRestore(); hook = undefined;
    expect(injected).toBe(true); expect(concurrent.status).toBe(200); expect(concurrent.forwards).toBe(1);
    expect(concurrent.response.id).toBe("concurrent-head");
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("temporary_history_changed");
    expect(f.calls).toHaveLength(1);
    expect(f.rows("SELECT response_id FROM temporary_history")).toEqual([{ response_id: "concurrent-head" }]);
    const recovered = await f.request(payload("recovered", "FIRST_POOL_NEW_QUESTION", "concurrent-head"));
    expect(recovered.status).toBe(200); await recovered.text(); expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(f.calls[1].input)).toContain("CONCURRENT_CONTEXT");
  } finally { hook?.mockRestore(); f.close(); }
}, 5000);

test("connection refusal is safely retryable while an unknown connection reset stays blocked", async () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET"]) {
    const f = fixture(); let unavailable = true, submitted = 0;
    try {
      f.respond(() => {
        if (unavailable) throw Object.assign(new Error(`injected ${code}`), { code });
        submitted++;
        return Response.json({ id: `recovered-${submitted}`, status: "completed", output: [] });
      });
      const first = await f.request(payload("connect")); expect(first.status).toBe(502); await first.text();
      expect(submitted).toBe(0); unavailable = false; f.restart();
      const retry = await f.request(payload("connect"));
      expect(retry.status).toBe(code === "ECONNREFUSED" ? 200 : 409); await retry.text();
      const next = await f.request(payload("after-connect"));
      expect(next.status).toBe(code === "ECONNREFUSED" ? 200 : 409); await next.text();
      expect(submitted).toBe(code === "ECONNREFUSED" ? 2 : 0);
    } finally { f.close(); }
  }
});

test("SQLite space pressure degrades optional cache but retains uncertainty when required history cannot fit", async () => {
  const f = fixture(91);
  try {
    const seed = await f.request(payload("seed")); expect(seed.status).toBe(200); await seed.text();
    f.respond(() => Response.json({ id: "large-history-head", status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(200 * 1024) }] }] }));
    const second = await f.request(payload("large-answer")); expect(second.status).toBe(200);
    expect((await second.json()).id).toBe("large-history-head");
    expect(f.rows("SELECT response_id FROM temporary_history")).toEqual([{ response_id: "large-history-head" }]);
    expect(f.rows("SELECT pending_history_turn FROM sessions")).toEqual([{ pending_history_turn: null }]);
    const receipts = f.rows("SELECT response_json FROM qa_request_receipts ORDER BY expires_at") as Array<{ response_json: string | null }>;
    expect(receipts).toHaveLength(2);
    expect(receipts[0].response_json).not.toBeNull();
    expect(receipts[1].response_json).toBeNull();
    f.respond(() => Response.json({ id: "following-head", status: "completed", output: [] }));
    const next = await f.request(payload("following", "CONTINUE_AFTER_LARGE_ANSWER", "large-history-head"));
    expect(next.status).toBe(200); expect((await next.json()).id).toBe("following-head");
    expect(f.calls).toHaveLength(3);
    expect(JSON.stringify(f.calls[2].input)).toContain("x".repeat(200 * 1024));
  } finally { f.close(); }
  const required = fixture(40);
  try {
    const seed = await required.request(payload("seed")); expect(seed.status).toBe(200); await seed.text();
    required.respond(() => Response.json({ id: "uncommitted-large-head", status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(200 * 1024) }] }] }));
    const failed = await required.request(payload("large-answer")); expect(failed.status).toBe(502); await failed.text();
    expect(required.rows("SELECT COUNT(*) AS n FROM sessions WHERE pending_history_turn IS NOT NULL")).toEqual([{ n: 1 }]);
    expect(required.rows("SELECT response_id FROM temporary_history")).toEqual([{ response_id: "receipt-response-1" }]);
    required.restart();
    const next = await required.request(payload("following")); expect(next.status).toBe(409); await next.text();
    expect(required.calls).toHaveLength(2);
  } finally { required.close(); }
});

for (const purpose of ["trigger", "memento"] as const) {
  test(`a legitimate same-turn ${purpose} compaction does not collide with a normal request`, async () => {
    const f = fixture();
    try {
      const ordinary = payload("one");
      const first = await f.request(ordinary); expect(first.status).toBe(200); const firstId = (await first.json()).id;
      const replay = await f.request(ordinary); expect(replay.status).toBe(200); expect((await replay.json()).id).toBe(firstId);
      const changed = await f.request(payload("one", "CHANGED_NORMAL_INPUT")); expect(changed.status).toBe(409); await changed.text();
      expect(f.calls).toHaveLength(1);
      const compact = purpose === "trigger"
        ? { ...ordinary, input: [...ordinary.input, { type: "compaction_trigger" }] }
        : { ...ordinary, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "receipt-thread", turn_id: "one",
          request_kind: "compaction", compaction: { implementation: "responses", strategy: "memento" } }) } };
      const response = await f.request(compact); expect(response.status).toBe(200); await response.text();
      const revised = { ...compact, input: [...compact.input, { type: "message", role: "assistant", content: "NEW_COMPACTION_REVISION" }] };
      const compactRevision = await f.request(revised); expect(compactRevision.status).toBe(200); await compactRevision.text();
      expect(f.calls).toHaveLength(3);
      if (purpose === "memento") {
        const invalid = { ...ordinary, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "receipt-thread", turn_id: "one",
          request_kind: "compaction", compaction: { implementation: "unsupported", strategy: "memento" } }) } };
        const invalidResponse = await f.request(invalid); expect(invalidResponse.status).toBe(400); await invalidResponse.text();
        expect(f.calls).toHaveLength(3);
      }
      f.respond(() => { throw Object.assign(new Error("uncertain ordinary turn"), { code: "ECONNRESET" }); });
      const uncertain = await f.request(payload("ordinary-pending")); expect(uncertain.status).toBe(502); await uncertain.text();
      const blocked = await f.request(compact); expect(blocked.status).toBe(409); await blocked.text();
      expect(f.calls).toHaveLength(4);
    } finally { f.close(); }
  });
}

test("a completed legacy ordinary receipt survives an upgrade without another forward", async () => {
  {
    const f = fixture();
    try {
      const body = { ...payload("upgrade"), input: [
        { ...payload("upgrade").input[0], id: "migration-user" },
      ] };
      const first = await f.request(body); expect(first.status).toBe(200); const id = (await first.json()).id;
      const row = f.rows("SELECT session_hash, identity_hash FROM qa_request_receipts")[0] as { session_hash: string; identity_hash: string };
      const scope = JSON.stringify([row.session_hash, "receipt-account", null, "/v1/responses"]);
      // Previous released receipt encoding, before compaction purpose separation.
      const legacyKey = createHash("sha256").update(JSON.stringify(["qa-receipt/v1", scope,
        ["turn", "upgrade", [["user", "migration-user"]]],
      ])).digest("hex");
      expect(row.identity_hash).toBe(legacyKey);
      f.sql(`UPDATE qa_request_receipts SET identity_hash='${legacyKey}'`);
      f.restart();
      const replay = await f.request(body); expect(replay.status).toBe(200);
      expect((await replay.json()).id).toBe(id); expect(f.calls).toHaveLength(1);
    } finally { f.close(); }
  }
});

function explicitRequest(body: ReturnType<typeof payload>, id: string): any {
  const native = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
  return { ...body, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...native, request_id: id }) } };
}

for (const stringInput of [false, true]) test(`ambiguous generated instruction fails before reservation and preserves replay, string=${stringInput}`, async () => {
  const f = fixture();
  try {
    const firstBody = explicitRequest(payload("same"), "first");
    if (stringInput) firstBody.input = "RECEIPT_CANARY";
    const first = await f.request(firstBody), result = await first.json(); expect(first.status).toBe(200);
    const before = f.rows("SELECT * FROM temporary_history"), receipts = f.rows("SELECT * FROM qa_request_receipts");
    const ambiguous = { ...explicitRequest(payload("same", "RECEIPT_CANARY", result.id), "second"), input: firstBody.input };
    const denied = await f.request(ambiguous), error = await denied.json();
    expect(denied.status).toBe(409); expect(error.error.code).toBe("instruction_identity_required");
    expect(error.error.message).toContain("no new message was sent");
    expect(f.calls).toHaveLength(1);
    expect(f.rows("SELECT * FROM temporary_history")).toEqual(before);
    expect(f.rows("SELECT * FROM qa_request_receipts")).toEqual(receipts);
    expect(f.rows("SELECT pending_history_turn FROM sessions")).toEqual([{ pending_history_turn: null }]);
    f.restart();
    const replay = await f.request(firstBody); expect(replay.status).toBe(200); expect((await replay.json()).id).toBe(result.id);
    const fixed = explicitRequest(payload("same", "RECEIPT_CANARY", result.id), "second"); fixed.input[0].id = "new-instruction";
    const next = await f.request(fixed); expect(next.status).toBe(200); await next.text(); expect(f.calls).toHaveLength(2);
  } finally { f.close(); }
});

for (const kind of ["changed-content", "new-turn", "caller-id", "tool-output", "full-history", "multiple-users", "non-message", "compaction", "changed-attachment", "same-attachment", "promotion"] as const) {
  test(`instruction guard scope: ${kind}`, async () => {
    const f = fixture();
    try {
      const firstBody = explicitRequest(payload("same"), "first");
      if (kind.includes("attachment")) firstBody.input[0].content.push({ type: "input_image", image_url: "data:image/png;base64,AAAA" });
      const first = await f.request(firstBody), result = await first.json(); expect(first.status).toBe(200);
      const next = explicitRequest(payload(kind === "new-turn" ? "next" : "same", kind === "changed-content" ? "CHANGED" : "RECEIPT_CANARY", result.id), "second");
      if (kind === "caller-id") next.input[0].id = "caller-new";
      if (kind === "promotion") next.reasoning.effort = "high-persistent";
      if (kind === "tool-output") next.input = [{ type: "function_call_output", call_id: "call-one", output: "ok" }];
      if (kind === "full-history") next.input = [...f.calls[0].input, ...result.output];
      if (kind === "multiple-users") next.input.push({ type: "message", role: "user", content: "another" });
      if (kind === "non-message") next.input.push({ type: "function_call", call_id: "call-one", name: "tool", arguments: "{}" });
      if (kind.includes("attachment")) next.input[0].content.push({ type: "input_image", image_url: kind === "same-attachment" ? "data:image/png;base64,AAAA" : "data:image/png;base64,BBBB" });
      const response = await f.request(next, false, kind === "compaction" ? "/v1/responses/compact" : "/v1/responses");
      expect(response.status).toBe(kind === "same-attachment" || kind === "promotion" ? 409 : 200); await response.text();
      expect(f.calls).toHaveLength(kind === "same-attachment" || kind === "promotion" ? 1 : 2);
    } finally { f.close(); }
  });
}

for (const mode of ["browser-only", "full"] as const) for (const stream of [false, true]) {
  test(`instruction guard precedes runtime in ${mode}, stream=${stream}`, async () => {
    const f = fixture(); let runs = 0;
    try {
      f.respond(body => responseRequest(new Request("http://backend/v1/responses", {
        method: "POST", body: JSON.stringify({ ...body, model: "chatgpt-web/high" }),
      }), defaultConfig(mode), () => ({ name: "identity-guard-test",
        async runTurn(_parsed, _incoming, emit) {
          runs++; emit({ type: "text_delta", text: "ANSWER", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      }), { rememberState: false }));
      const first = explicitRequest(payload("same", "QUESTION", undefined, stream), "first");
      const response = await f.request(first); expect(response.status).toBe(200); await response.text();
      const next = explicitRequest(payload("same", "QUESTION", undefined, stream), "second");
      const denied = await f.request(next); expect(denied.status).toBe(409);
      expect((await denied.json()).error.code).toBe("instruction_identity_required"); expect(runs).toBe(1);
      next.input[0].id = "new-user-instruction";
      const resumed = await f.request(next); expect(resumed.status).toBe(200); await resumed.text(); expect(runs).toBe(2);
    } finally { f.close(); }
  });
}
