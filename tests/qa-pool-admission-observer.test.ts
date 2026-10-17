// Scoped admission/observer regression coverage extracted from the reviewed offline fixture.
// Missing-ID CPR recovery is intentionally unresolved; the original eleven-case
// fixture is preserved in the integration evidence, without weakening its assertions.
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The deployed .mjs module has no declaration in the upstream repository.
// @ts-expect-error checked by runtime integration below
import { normalizeCprRequest } from "../deploy/cpr-session.mjs";
import { createQaPool } from "../src/qa-pool";
import { defaultConfig, providerConfig } from "../src/config";
import { startServer } from "../src/server";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { flushResponseState } from "../src/responses/state";

const MODEL = "chatgpt-web/gpt-5.6-sol-instant";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise,resolve}; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture timed out")), 3000); })]); }
  finally { clearTimeout(timer!); }
}
const observations: unknown[] = [];
function observe(value: unknown) { observations.push(value); console.log("DOT_ADMISSION " + JSON.stringify(value)); if (process.env.DOT_EVIDENCE_PATH) writeFileSync(process.env.DOT_EVIDENCE_PATH, JSON.stringify(observations,null,2)+"\n"); }

// Real HTTP -> production CPR normalizer -> pool/SQLite -> real startServer
// admission -> production Responses handler/adapter/registry. Only browser/model
// execution is replaced. The Node Unix-socket provider wrapper is tested separately.
function fixture(options: { holdFirst?: boolean; holdFirstHeaders?: boolean; afterAcceptedError?: object; afterAcceptedStatus?: number; directPool?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dot-cpr-admission-"));
  const oldHome = process.env.CODEX_CHATGPT_WEB_HOME; process.env.CODEX_CHATGPT_WEB_HOME = root;
  const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  const key = "a".repeat(32), account = "account-"+randomUUID(), thread = "thread-"+randomUUID();
  writeFileSync(join(root,"key"),key);
  const config = {...defaultConfig(), port:0, accountId:account, browserHost:"launcher" as const,
    browserHostDescriptorPath:join(root,"unused.json"), useSavedChats:false,
    conversationStoreDirectory:join(root,"conversations"), brokerSocketPath:join(root,"broker.sock")};
  const accepted = deferred(), release = deferred();
  const starts: string[] = [], input: unknown[] = [], execution: string[] = [];
  const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
  const run = spyOn(worker,"run").mockImplementation(async (turn:BrowserTurn) => {
    const prepared = await turn.prepare(); starts.push(prepared.text); prepared.release();
    await turn.onSendActivated?.(); await turn.onSubmitted?.();
    if (starts.length===1) { accepted.resolve(); if(options.holdFirst) await release.promise; }
    const answer="ANSWER_"+starts.length; turn.onTextDelta(answer); return answer;
  });
  const runtime = startServer(config,{adapterFactory:provider => {
    const adapter=createChatGptWebAdapter(provider);
    return {...adapter, async runTurn(parsed,incoming,emit) { execution.push(chatGptTurnExecutionKey(parsed)); return adapter.runTurn!(parsed,incoming,emit); }};
  }});
  const backend = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
    input.push((await req.clone().json()).input);
    const response = await fetch(new URL(new URL(req.url).pathname,runtime.url),{method:req.method,headers:req.headers,body:await req.arrayBuffer(),signal:req.signal});
    if (options.afterAcceptedError && response.ok) {
      // Infrastructure returns 503 only AFTER the actual runtime completed the work.
      await response.text(); return Response.json({error:options.afterAcceptedError},{status:options.afterAcceptedStatus??503});
    }
    return response;
  }});
  const poolConfig={host:"127.0.0.1",port:0,databasePath:join(root,"pool.sqlite"),clients:[{id:"test",keyFile:join(root,"key")}],accounts:[{id:account,origin:backend.url.origin,models:[MODEL],sessionModes:true}]};
  let pool=createQaPool(poolConfig);
  const observerSignals: AbortSignal[] = [];
  let firstIngress = true;
  const ingress=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
    const raw = await req.json();
    const payload=options.directPool ? raw : normalizeCprRequest(raw,Object.fromEntries(req.headers));
    const forward=new Request(req.url,{method:"POST",headers:req.headers,body:JSON.stringify(payload),signal:req.signal});
    observerSignals.push(forward.signal);
    const holdHeaders = options.holdFirstHeaders && firstIngress; firstIngress = false;
    const response = await pool.fetch(forward);
    if (holdHeaders) {
      // Deterministic downstream transport delay: the socket aborts before Bun
      // is given this response body. No upstream lifecycle signal is fabricated.
      await new Promise<void>(resolve => { if(req.signal.aborted) resolve(); else req.signal.addEventListener("abort",()=>resolve(),{once:true}); });
    }
    return response;
  }});
  const body=(turn:string,text="QUESTION",id?:string,stream=false):any=>({model:MODEL,stream,reasoning:{effort:"low-temporary"},input:[{type:"message",role:"user",...(id?{id}:{}),content:[{type:"input_text",text}]}],client_metadata:{"x-codex-turn-metadata":JSON.stringify({thread_id:thread,turn_id:turn})}});
  const request=(payload:unknown,signal?:AbortSignal)=>fetch(new URL("/v1/responses",ingress.url),{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify(payload),signal});
  const sql=(query:string)=>{const db=new Database(poolConfig.databasePath);try{return db.query(query).get() as any;}finally{db.close();}};
  const control=async(action:"drain"|"resume")=>{const r=await fetch(new URL("/admin/"+action,runtime.url),{method:"POST",headers:{authorization:"Bearer "+config.controlToken}}); expect(r.status).toBe(200); await r.text();};
  return {body,request,accepted,release,starts,input,execution,sql,control,runtime,observerListenerCounts:()=>observerSignals.map(signal=>getEventListeners(signal,"abort").length),
    restart:()=>{pool.close();pool=createQaPool(poolConfig);},
    async close() { release.resolve(); await delay(20); pool.close(); ingress.stop(true);backend.stop(true);runtime.stop(true);run.mockRestore();
      for(const signal of ["SIGINT","SIGTERM"] as const) for(const listener of process.listeners(signal)) if(!signals[signal].includes(listener)) process.removeListener(signal,listener);
      await TurnBroker.forSocket(config.brokerSocketPath).close();flushResponseState();
      if(oldHome===undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME=oldHome;
      rmSync(root,{recursive:true,force:true}); }
  };
}

for (const [point, explicitId] of [["before-headers",true],["after-headers",true]] as const) {
  test(`CPR ${point} accepted disconnect reconnect, ${explicitId ? "caller ID" : "missing ID"}`,async()=>{
    const f=fixture({holdFirst:true,holdFirstHeaders:point==="before-headers"}), abort=new AbortController(); let first:Promise<unknown>|undefined;
    const headersReady=deferred();let headersSeen=false;
    try {
      const body=f.body("retry","RECONNECT",explicitId?"original-stable-id":undefined,true);
      first=f.request(body,abort.signal).then(r=>{headersSeen=true;headersReady.resolve();return r.text();}).catch(()=>undefined);
      await bounded(f.accepted.promise);
      if(point==="after-headers") await bounded(headersReady.promise); else expect(headersSeen).toBe(false);
      abort.abort();await first;
      // Retaining upstream work is intentional; losing the downstream observer
      // must not leave the pool's completion reader parked on backpressure.
      const retry=f.request(body);await delay(30);f.release.resolve();
      const response=await bounded(retry),text=await bounded(response.text());
      const events=response.ok?text.split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6))):[];
      const terminal=events.filter(event=>event.type==="response.completed");
      observe({case:"cpr-accepted-reconnect",point,explicitId,status:response.status,workerStarts:f.starts.length,adapterCalls:f.execution.length,terminalCount:terminal.length,error:response.ok?undefined:JSON.parse(text).error?.code});
      expect(response.status).toBe(200);expect(terminal).toHaveLength(1);expect(terminal[0].response.status).toBe("completed");expect(terminal[0].response.output[0].content[0].text).toBe("ANSWER_1");
      expect(f.starts).toHaveLength(1);expect(f.execution).toHaveLength(1);expect(f.sql("SELECT pending_history_turn IS NOT NULL AS pending FROM sessions").pending).toBe(0);
      const intentional=await f.request(f.body("new-turn","RECONNECT",undefined,false));expect(intentional.status).toBe(200);await intentional.text();expect(f.starts).toHaveLength(2);expect(f.observerListenerCounts().every(n=>n===0)).toBe(true);
    } finally {f.release.resolve();await first;await f.close();}
  });
}

for(const stream of [false,true])test(`real runtime draining ${stream?"SSE":"JSON"} rejects before admission then retry and next turn succeed`,async()=>{
  const f=fixture();
  try {
    await f.control("drain");const body=f.body("drain","RECOVER",undefined,stream);
    const first=await f.request(body),error=await first.json();
    expect(first.status).toBe(503);expect(f.starts).toHaveLength(0);expect(f.execution).toHaveLength(0);
    const pending=f.sql("SELECT pending_history_turn IS NOT NULL AS pending FROM sessions");
    f.restart();await f.control("resume");
    const retry=await f.request(body),text=await retry.text();
    const next=await f.request(f.body("next","NEXT")),nextText=await next.text();
    observe({case:"runtime-drain-recovery",stream,error,pending,retry:retry.status,next:next.status,workerStarts:f.starts.length,adapterCalls:f.execution.length});
    expect(error.error).toMatchObject({code:"server_draining",submission_state:"not_submitted",phase:"admission"});
    expect(pending.pending).toBe(0);expect(retry.status).toBe(200);expect(text).toContain('"completed"');expect(next.status).toBe(200);expect(nextText).toContain('"completed"');expect(f.starts).toHaveLength(2);
    expect(JSON.stringify(f.input.at(-1))).toContain("RECOVER");expect(f.observerListenerCounts().every(n=>n===0)).toBe(true);
  } finally {await f.close();}
});

test("draining compact is explicitly unadmitted while the model catalog does not claim submission state",async()=>{
  const f=fixture();try{
    await f.control("drain");
    const compact=await fetch(new URL("/v1/responses/compact",f.runtime.url),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(f.body("compact"))});
    expect(compact.status).toBe(503);expect((await compact.json()).error).toMatchObject({code:"server_draining",submission_state:"not_submitted",phase:"admission"});
    const models=await fetch(new URL("/v1/models",f.runtime.url));expect(models.status).toBe(503);expect((await models.json()).error.submission_state).toBeUndefined();expect(f.execution).toHaveLength(0);
  }finally{await f.close();}
});

for(const error of [
  {type:"server_error",message:"infrastructure failed after acceptance"},
  {type:"server_error",message:"late failure",code:"server_draining",submission_state:"accepted",phase:"admission"},
  {type:"server_error",message:"not the trusted code",code:"other_failure",submission_state:"not_submitted",phase:"admission"},
])test(`accepted 503 is not retried blindly: ${error.code??"generic"}`,async()=>{
  const f=fixture({afterAcceptedError:error});try{
    const body=f.body("accepted","DO_ONCE","stable-user-id");
    const first=await f.request(body);expect(first.status).toBe(503);await first.text();expect(f.starts).toHaveLength(1);
    f.restart();const retry=await f.request(body);await retry.text();const next=await f.request(f.body("next"));await next.text();
    observe({case:"accepted-503-blocked",code:error.code??"generic",retry:retry.status,next:next.status,workerStarts:f.starts.length});
    expect(retry.status).toBe(409);expect(next.status).toBe(409);expect(f.starts).toHaveLength(1);expect(f.execution).toHaveLength(1);
  }finally{await f.close();}
});

const trusted={type:"server_error",code:"server_draining",retryable:true,submission_state:"not_submitted",phase:"admission"};
for(const [field,value,status] of [
 ["type","other_error",503], ["code","other_failure",503],
 ["retryable",false,503], ["submission_state","accepted",503],
 ["phase","execution",503], ["status",undefined,500],
] as const) test(`independent late-error single-field mismatch: ${field}`,async()=>{
 const error=field==="status"?trusted:{...trusted,[field]:value};
 const f=fixture({afterAcceptedError:error,afterAcceptedStatus:status});
 try {
  const body=f.body("already-accepted","EXECUTE_ONCE","caller-id");
  const first=await f.request(body);expect(first.status).toBe(status);await first.text();
  expect(f.starts).toHaveLength(1);f.restart();
  const retry=await f.request(body);await retry.text();
  const next=await f.request(f.body("next"));await next.text();
  expect(retry.status).toBe(409);expect(next.status).toBe(409);
  expect(f.starts).toHaveLength(1);expect(f.execution).toHaveLength(1);
  observe({case:"independent-proof-field-mismatch",field,status,retry:retry.status,next:next.status,workerStarts:f.starts.length});
 } finally {await f.close();}
});



for (const stream of [false, true]) test(`direct pool rejects ambiguous same-turn delta before adapter, stream=${stream}`, async () => {
  const f = fixture({ directPool: true });
  const identify = (body: any, requestId: string) => {
    const native = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ ...native, request_id: requestId });
    return body;
  };
  const completed = async (response: Response): Promise<any> => {
    const text = await response.text();
    if (!stream) return JSON.parse(text);
    return text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.completed").response;
  };
  try {
    const firstBody = identify(f.body("same-turn", "SAME", undefined, stream), "request-one");
    const first = await f.request(firstBody); expect(first.status).toBe(200); const result = await completed(first);
    const nextBody = identify(f.body("same-turn", "SAME", undefined, stream), "request-two"); nextBody.previous_response_id = result.id;
    const second = await f.request(nextBody); expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("instruction_identity_required");
    expect(f.starts).toHaveLength(1); expect(f.execution).toHaveLength(1); expect(f.input).toHaveLength(1);
    f.restart();
    const retry = await f.request(firstBody); expect(retry.status).toBe(200); expect((await completed(retry)).id).toBe(result.id);
    nextBody.input[0].id = "new-instruction";
    const resumed = await f.request(nextBody); expect(resumed.status).toBe(200); await completed(resumed);
    expect(f.starts).toHaveLength(2); expect(f.execution).toHaveLength(2); expect(f.execution[0]).not.toBe(f.execution[1]);
    observe({ case: "ambiguous-delta-rejected", stream, workerStarts: f.starts.length, adapterCalls: f.execution.length });
  } finally { await f.close(); }
});
