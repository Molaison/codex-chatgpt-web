import { tmpdir } from "node:os";
import { NativeMetadataAcknowledgement } from "../src/adapters/chatgpt-web/native-metadata-ack";
import { ExplicitNativeCancellation, nativeExecutionDigest, type NativeCancelTerminal, type NativeResultReady } from "../src/adapters/chatgpt-web/native-execution";
import { ChatGptTurnSessions, ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { NativeSubmissionCollector, nativeSubmissionDigest, parseNativeSubmission, submissionIdentityUnproven, type NativeSubmissionRecord } from "../src/adapters/chatgpt-web/submission-identity";
import { DurableOperation, OperationJournal, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import { ChatGptBrowserWorker, resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { parseBrowserObservation } from "../src/adapters/chatgpt-web/observation-recovery";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

function owner() {
  mkdirSync((process.env.Q39_TEST_ROOT ?? tmpdir()), {recursive:true});
  const root = mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()), "native-submission-"));
  const record: OperationRecord = {version:1, operationId:"original-op", executionKey:"original", traceId:"trace", requestIds:[],
    submission:"prepared", generation:"not_started", delivery:"attached", recovery:"none", seq:0, attempt:1, startedAt:Date.now(), updatedAt:Date.now(), rounds:{}};
  const journal = new OperationJournal(root), operation = new DurableOperation(journal, record);
  return {root, record, journal, operation};
}
function pageFixture() {
  const frame = {};
  const page = Object.assign(new EventEmitter(), {mainFrame:()=>frame});
  const emitRequest = (id: string = randomUUID(), extra: Record<string, unknown> = {}, requestExtra: Record<string, unknown> = {}) => {
    const body = {action:"next", parent_message_id:"client-created-root", messages:[{id, author:{role:"user"}, content:{parts:["identical user question"]}}], ...extra};
    const request = {method:()=>"POST", url:()=>"https://chatgpt.com/backend-api/f/conversation", frame:()=>frame,
      postData:()=>JSON.stringify(body), ...requestExtra};
    page.emit("request", request);
    return {id, request};
  };
  const emit = (id: string = randomUUID(), extra: Record<string, unknown> = {}, requestExtra: Record<string, unknown> = {}) =>
    emitRequest(id, extra, requestExtra).id;
  const respond = (request: unknown, status = 200, contentType = "text/event-stream; charset=utf-8") =>
    page.emit("response", {request:()=>request, status:()=>status, headers:()=>({"content-type":contentType})});
  return {page, emit, emitRequest, respond};
}
function pair(id:string) { return [`group:user:${id}`, `group:assistant:${id}`]; }

test("owned POST and exact DOM persist; equal-text independent operations each execute once", async()=>{
  const all: NativeSubmissionRecord[]=[];
  const userIds: string[]=[];
  for(let i=0;i<2;i++) {
    const f=owner();
    f.record.operationId=randomUUID();
    try {
      const {page,emit}=pageFixture();
      f.operation.beforeSend();
      const c=new NativeSubmissionCollector(r=>{f.operation.nativeSubmission(r);all.push(r);});
      await c.activate(page as any, []); c.arm();
      const id=emit(); userIds.push(id);
      expect((await c.observed())?.phase).toBe("post_observed");
      const accepted=await c.accept(pair(id),"same-bound-assistant-progress");
      expect(accepted.post?.conversationId).toEqual({presence:"absent"});
      expect(accepted.post?.parentMessageId).toEqual({presence:"value",value:"client-created-root"});
      expect(f.journal.read<OperationRecord>("original")?.nativeSubmissions).toEqual([accepted]);
      expect(JSON.stringify(f.record)).not.toContain("identical user question");
      // Merely accepting the first Send cannot authorize another physical Send in that operation.
      f.operation.beforeSend();
      expect(()=>f.operation.nativeSubmission({version:1,sendId:randomUUID(),revision:1,phase:"send_activated",initialTurnIdentities:[]})).toThrow("unresolved");
      c.dispose();
    } finally {rmSync(f.root,{recursive:true,force:true});}
  }
  expect(all.map(r=>r.phase)).toEqual(["send_activated","post_observed","accepted","send_activated","post_observed","accepted"]);
  expect(userIds[0]).not.toBe(userIds[1]);
});

test("unacknowledged POST cannot grant acceptance and failed durable ACK remains retained", async()=>{
  const {page,emit}=pageFixture(); let release!:()=>void, accepted=false;
  const gate=new Promise<void>(r=>release=r);
  const c=new NativeSubmissionCollector(async r=>{if(r.phase==="post_observed")await gate;if(r.phase==="accepted")accepted=true;});
  await c.activate(page as any,[]); c.arm();const id=emit();const pending=c.accept(pair(id),"same-bound-assistant-progress");
  await new Promise(r=>setTimeout(r,10));expect(accepted).toBe(false);release();await pending;expect(accepted).toBe(true);c.dispose();
  const second=pageFixture();const failing=new NativeSubmissionCollector(r=>{if(r.phase==="post_observed")throw new Error("private storage content");});
  await failing.activate(second.page as any,[]); failing.arm();const id2=second.emit();
  await expect(failing.accept(pair(id2),"same-bound-assistant-completed")).rejects.toThrow("durable identity acknowledgement failed");
  failing.dispose();
});

test("response acceptance requires the owned conversation POST to return 200 SSE", async()=>{
  const rejected=pageFixture(),ok=pageFixture();
  const wrongType=new NativeSubmissionCollector(()=>{}),accepted=new NativeSubmissionCollector(()=>{});
  await wrongType.activate(rejected.page as any,[]);wrongType.arm();wrongType.dispatching();
  await accepted.activate(ok.page as any,[]);accepted.arm();accepted.dispatching();
  let wrongAccepted=false,acceptedResponse=false;
  void wrongType.waitForResponseAccepted().then(()=>{wrongAccepted=true;});
  const waiting=accepted.waitForResponseAccepted().then(()=>{acceptedResponse=true;});
  rejected.respond(rejected.emitRequest().request,200,"application/json");
  await new Promise(resolve=>setTimeout(resolve,10));
  expect(wrongAccepted).toBe(false);
  ok.respond(ok.emitRequest().request);
  await waiting;
  expect(acceptedResponse).toBe(true);
  expect((await accepted.observed())?.phase).toBe("post_observed");
  wrongType.dispose();accepted.dispose();
});

for(const mode of ["duplicate-post","foreign-id","wrong-action","multi-user","missing-body","foreign-frame"] as const) {
  test(`native identity rejection: ${mode}`,async()=>{
    const {page,emit}=pageFixture();const saved:NativeSubmissionRecord[]=[];const c=new NativeSubmissionCollector(r=>{saved.push(r);});
    await c.activate(page as any,[]); c.arm();
    const id=randomUUID();
    if(mode==="foreign-frame") {emit(id,{}, {frame:()=>({})});expect(await c.observed()).toBeUndefined();c.dispose();return;}
    if(mode==="missing-body")emit(id,{}, {postData:()=>null});
    else if(mode==="multi-user")emit(id,{messages:[{id,author:{role:"user"}},{id:randomUUID(),author:{role:"user"}}]});
    else emit(id, mode==="wrong-action"?{action:"variant"}:{});
    if(mode==="duplicate-post") {await c.accept(pair(id),"same-bound-assistant-progress");emit(id);}
    await expect(c.accept(pair(mode==="foreign-id"?randomUUID():id),"same-bound-assistant-progress")).rejects.toThrow();
    if(mode!=="foreign-id")expect(saved.at(-1)?.phase).toBe("conflict");
    c.dispose();
  });
}

test("journal cannot downgrade accepted identity or admit a second Send while original is ambiguous",async()=>{
  const f=owner();const first=pageFixture();
  try{
    f.operation.beforeSend();const c=new NativeSubmissionCollector(r=>f.operation.nativeSubmission(r));await c.activate(first.page as any,[]); c.arm();
    const original=structuredClone(f.record.nativeSubmissions![0]!);
    expect(()=>f.operation.nativeSubmission({...original,sendId:randomUUID()})).toThrow("unresolved");
    const id=first.emit();await c.accept(pair(id),"same-bound-assistant-completed");
    expect(()=>f.operation.nativeSubmission(original)).toThrow("changed");
    const accepted=f.record.nativeSubmissions![0]!;
    const checkpoint:any={version:2,identity:{operationId:"op",executionKey:"key",roundKey:"round",threadId:"thread",turnId:"turn"},traceId:"trace",modelId:"model",accountId:"account2",appName:"app",
      host:{pid:1,instanceId:"h".repeat(32),profile:"production",partition:"persist:codex-web-gpt-chatgpt"},lease:{helperPid:2,surfaceId:"s".repeat(32),targetId:"target"},
      conversation:{key:"conversation",url:"https://chatgpt.com/c/6ade4bd9-0cc8-83ea-94ae-4c55112ec5a8",claim:"claim"},
      submission:{native:accepted,initialTurnIdentities:[],acceptedUserIdentity:pair(id)[0],assistantIdentity:pair(id)[1],acceptedTurnIdentities:pair(id)}};
    expect(parseBrowserObservation(checkpoint).version).toBe(2);
    expect(()=>parseBrowserObservation({...checkpoint,version:1})).toThrow();
    expect(()=>parseBrowserObservation({...checkpoint,submission:{...checkpoint.submission,receipt:"[codex-submission:fake]"}})).toThrow();
    expect(()=>parseNativeSubmission({...accepted,dom:{...accepted.dom,assistantIdentity:pair(randomUUID())[1]}})).toThrow();
    c.dispose();
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

const browserTest=test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);
browserTest("real local Chromium POST binds exact user group; old/new text never supplies ownership",async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true,args:["--no-sandbox"]});
  try{
    const page=await browser.newPage();await page.route("https://chatgpt.com/**",route=>route.fulfill({status:200,contentType:"text/html",body:"<main id='groups'></main>"}));await page.goto("https://chatgpt.com/");
    const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
    const baseline=await worker.captureSubmissionBaseline(page,"identical user question");
    baseline.nativeSubmission=new NativeSubmissionCollector(()=>{});await baseline.nativeSubmission.activate(page,[]); baseline.nativeSubmission.arm();
    const id=randomUUID();await page.evaluate(async id=>{await fetch("/backend-api/f/conversation",{method:"POST",body:JSON.stringify({action:"next",parent_message_id:"client-created-root",messages:[{id,author:{role:"user"}}]})});
      document.querySelector("#groups")!.innerHTML=`<section data-turn-key="${id}"><div data-user-message-bubble><div data-search-result-target>identical user question</div></div><div data-content-search-unit-key="bound:assistant"><h4 data-conversation-role="assistant"></h4><div class="markdown"><p>actual bound response</p></div></div></section>`;},id);
    await page.locator(".markdown").evaluate(root=>{root.innerHTML="";});
    await page.evaluate(()=>{const stop=document.createElement("button");stop.setAttribute("data-testid","stop-button");stop.textContent="Stop";document.body.append(stop);});
    expect(await worker.currentSubmissionEvidence(page,baseline)).toBeUndefined();
    await page.locator(".markdown").evaluate(root=>{root.innerHTML="<p>actual bound response</p>";});
    expect(await worker.currentSubmissionEvidence(page,baseline)).toBe("user_turn");
    const binding={identity:pair(id)[1],locator:page.locator(`[data-turn-key="${id}"]`),acceptedTurnIdentities:pair(id)};
    await page.locator(`[data-turn-key="${id}"]`).evaluate(root=>{root.innerHTML=root.innerHTML;});
    expect((await worker.reconcileAssistantTurnBinding(page,baseline,binding)).identity).toBe(pair(id)[1]);
    await page.locator(`[data-turn-key="${id}"]`).evaluate((root,next)=>root.setAttribute("data-turn-key",next),randomUUID());
    await expect(worker.reconcileAssistantTurnBinding(page,baseline,binding)).rejects.toThrow("original accepted group changed");
    baseline.nativeSubmission.dispose();
  }finally{await browser.close();}
},15000);

test("paired real helper IPC persists each native revision before its exact ACK", async()=>{
  const f=owner();const helper=join(f.root,"helper.ts"),descriptor=join(f.root,"launcher.json");
  const workerModule=new URL("../src/adapters/chatgpt-web/browser-worker.ts",import.meta.url).href;
  const helperModule=new URL("../src/adapters/chatgpt-web/browser-helper-main.ts",import.meta.url).href;
  const id=randomUUID(),sendId=randomUUID();const phases:string[]=[];
  const records:NativeSubmissionRecord[]=[{version:1,sendId,revision:1,phase:"send_activated",initialTurnIdentities:[]}];
  records.push({...records[0]!,revision:2,phase:"post_observed",post:{userMessageId:id,parentMessageId:{presence:"value",value:"client-created-root"},conversationId:{presence:"absent"},action:{presence:"value",value:"next"},payloadSha256:"a".repeat(64),observedAt:Date.now()}});
  records.push({...records[1]!,revision:3,phase:"accepted",dom:{acceptedUserIdentity:pair(id)[0]!,assistantIdentity:pair(id)[1]!,acceptedTurnIdentities:pair(id),proof:"same-bound-assistant-completed",observedAt:Date.now()}});
  writeFileSync(helper,`
    import {writeFileSync} from "node:fs";
    import {ChatGptBrowserWorker} from ${JSON.stringify(workerModule)};
    ChatGptBrowserWorker.prototype.run=async function(turn){
      await turn.onPreparedSelected(false);await turn.prepare();await turn.onSendActivated();
      for(const record of ${JSON.stringify(records)}){
        await turn.onNativeSubmission(record);
        if(record.revision===2)writeFileSync(${JSON.stringify(join(f.root,"post-acked"))},"done");
      }
      return "original answer";
    };
    await import(${JSON.stringify(helperModule)});
  `);
  writeFileSync(descriptor,JSON.stringify({version:3,kind:LAUNCHER_BROWSER_HOST_KIND,profile:"production",pid:process.pid,
    endpoint:"http://127.0.0.1:39110",control:{endpoint:"http://127.0.0.1:39111",token:"t".repeat(64)},helper:{executable:process.execPath,script:helper},partition:"persist:codex-web-gpt-chatgpt",idleUrl:LAUNCHER_BROWSER_IDLE_URL,surfaceId:"s".repeat(32),surfaceTargets:{["s".repeat(32)]:"target"},createdAt:new Date().toISOString()}),{mode:0o600});
  const client=new LauncherBrowserHelperClient(resolveBrowserConfig({adapter:"chatgpt-web",baseUrl:"browser://native-fixture",chatgptWeb:{accountId:"account2",browserHost:"launcher",browserHostDescriptorPath:descriptor,browserHelperScriptPath:helper}}));
  const originalSend=(client as any).send.bind(client);let staleInjected=false;
  (client as any).send=async(message:any)=>{
    if(message.type==="native_submission_ack"&&message.revision===2&&!staleInjected){
      staleInjected=true;await originalSend({...message,revision:1});await new Promise(r=>setTimeout(r,20));
      expect(await Bun.file(join(f.root,"post-acked")).exists()).toBe(false);
    }
    return originalSend(message);
  };
  try{
    const result=client.run({traceId:"native_trace",modelId:"gpt-5.6-sol",nativeSubmissionIdentity:true,
      nativeOperationScope:{operationId:"op",executionKey:"key",roundKey:"round",threadId:"thread",turnId:"turn",traceId:"native_trace"},
      onNativeResultReady:async()=>{},onNativeRelease:async()=>{},onNativeCancelTerminal:async()=>{},onNativePreparationCancel:async()=>{throw new Error("No preparation cancellation in this ACK fixture");},onNativeCancelIntent:async()=>{throw new Error("No cancellation in this ACK fixture");},
      capabilities:{localToolsEnabled:false,solAvailable:true,extraHighAvailable:false,proAvailable:false},
      prepare:async()=>({text:"identical user question",images:[],release(){}}),onTextDelta(){},
      onSendActivated:()=>f.operation.beforeSend(),onNativeSubmission:r=>{f.operation.nativeSubmission(r);phases.push(r.phase);}});
    await expect(result).rejects.toMatchObject({code:"chatgpt_submission_identity_unproven"});expect(phases).toEqual(["send_activated","post_observed","accepted"]);expect(staleInjected).toBe(true);
  }finally{await client.close();rmSync(f.root,{recursive:true,force:true});}
},15000);

for(const failAck of [false,true])browserTest(`physical browser Send stays unique when native POST acknowledgement ${failAck?"fails":"succeeds"}`,async()=>{
  const f=owner();const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true,args:["--no-sandbox"]});
  try{
    const page=await browser.newPage();const posts:string[]=[];const question="The original user's exact question.";
    page.on("request",request=>{if(request.method()==="POST")posts.push(request.postData()!);});
    await page.route("https://chatgpt.com/**",route=>{
      return route.fulfill({status:200,contentType:"text/html",body:'<form><div contenteditable="true" id="composer" role="textbox"></div><button data-testid="send-button">Send</button></form><main id="groups"></main>'});
    });await page.goto("https://chatgpt.com/");
    await page.evaluate(question=>{
      (window as any).clicks=0;
      document.querySelector("button")!.addEventListener("click",async event=>{
        event.preventDefault();(window as any).clicks++;
        const id=crypto.randomUUID();await fetch("/backend-api/f/conversation",{method:"POST",body:JSON.stringify({action:"next",parent_message_id:"client-created-root",messages:[{id,author:{role:"user"},content:{parts:[question]}}]})});
        document.querySelector("#groups")!.innerHTML=`<section data-turn-key="${id}"><div data-user-message-bubble><div data-search-result-target></div></div><div data-content-search-unit-key="bound:assistant"><h4 data-conversation-role="assistant"></h4><div class="markdown"><p>Actual local response</p></div></div></section>`;
        document.querySelector("[data-search-result-target]")!.textContent=question;
      });
    },question);
    const worker=Object.create(ChatGptBrowserWorker.prototype) as any;worker.activeComposer=async()=>page.locator("#composer");
    const baseline=await worker.captureSubmissionBaseline(page,question);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
    try{
      const send=worker.sendAttachedPrompt(page,baseline,undefined,controller.signal,undefined,{nativeSubmissionIdentity:true,onSendActivated:()=>f.operation.beforeSend(),onNativeSubmission:(r:NativeSubmissionRecord)=>{
        if(failAck&&r.phase==="post_observed")throw new Error("controlled ACK failure");f.operation.nativeSubmission(r);
      }});
      let observedError:Error|undefined;
      try { expect(await send).toBe("user_turn"); } catch(error) { observedError=error as Error; }
      if(posts.length===0&&observedError)throw observedError;
      expect(await page.evaluate(()=>(window as any).clicks)).toBe(1);expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0]!).messages[0].content.parts).toEqual([question]);
      expect(posts[0]).not.toContain("codex-submission");
      if(failAck) expect(observedError?.message).toContain("durable identity acknowledgement failed");
      else expect(observedError).toBeUndefined();
    }finally{clearTimeout(timer);baseline.nativeSubmission?.dispose();}
  }finally{await browser.close();rmSync(f.root,{recursive:true,force:true});}
},15000);


test("retained browser observation never releases the next owner or marks physical settlement",async()=>{
  const f=owner();
  try{
    const failure=submissionIdentityUnproven("controlled original observer failure");
    const sessions=new ChatGptTurnSessions();let replacement=0;
    const original=sessions.getOrCreate("original",()=>({mode:"read-only",operation:f.operation,
      browser:Promise.reject(failure),physicalSettlement:Promise.reject(failure),
      trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),conversationKey:"same-conversation",cancel(){}}),"native_trace","same-owner");
    expect((await original.browserOutcome).type).toBe("error");
    await expect(original.physicalSettlement).rejects.toThrow("controlled original observer failure");
    expect(original.isPhysicallySettled()).toBe(false);expect(f.record.physicalSettled).not.toBe(true);
    await expect(sessions.getOrCreateAfterOwnerRetirement("new","same-owner",()=>{replacement++;throw new Error("unauthorized replacement");})).rejects.toThrow("controlled original observer failure");
    expect(replacement).toBe(0);expect(f.record.generation).toBe("unknown");expect(f.record.recovery).toBe("retained");
  }finally{rmSync(f.root,{recursive:true,force:true});}
});


/** Actual Host implementation + parent journal + collector; only CDP transport is a fixture. */
async function boundNativeFixture(deadlineAt?: () => number, traceId = "trace") {
  const require=createRequire(import.meta.url);
  const hostPath=require.resolve("../launcher/electron/browser-host.cjs");
  const hostModule={exports:{} as any}, hostRequire=createRequire(hostPath);
  const load=(id:string)=>id==="electron"?{}:hostRequire(id);
  new Function("require","module","exports","__dirname","__filename",readFileSync(hostPath,"utf8"))(
    load,hostModule,hostModule.exports,dirname(hostPath),hostPath);
  const {BrowserHost}=hostModule.exports;
  const f=owner(), oldPage=pageFixture();
  const contents:any=Object.assign(new EventEmitter(), {
    url:"https://chatgpt.com/?temporary-chat=true",loaderId:"loader-1",targetId:"original-target",
    destroyed:false,getURL(){return this.url;},getOrCreateDevToolsTargetId(){return this.targetId;},isDestroyed(){return this.destroyed;},
    close(){this.destroyed=true;},setBackgroundThrottling(){},
  });
  const dbg:any=Object.assign(new EventEmitter(),{
    attached:false,attachCount:0,detachCount:0,isAttached(){return this.attached;},
    attach(){expect(this.attached).toBe(false);this.attached=true;this.attachCount++;},
    detach(this:any){this.attached=false;this.detachCount++;this.emit("detach",{},"test");},
    async sendCommand(method:string){
      expect(["Network.enable","Page.enable","Page.getFrameTree"]).toContain(method);
      return method==="Page.getFrameTree"?{frameTree:{frame:{id:"main-frame",loaderId:contents.loaderId,url:contents.url}}}:{};
    },
  });contents.debugger=dbg;
  const binding={roundKey:"round",stage:{kind:"final" as const},documentEpoch:null,
    host:{pid:process.pid,instanceId:"h".repeat(32),profile:"production",partition:"persist:codex-web-gpt-chatgpt"},
    lease:{helperPid:process.pid,surfaceId:"s".repeat(32),targetId:contents.targetId}};
  const tab:any={id:"tab",traceId,surfaceId:binding.lease.surfaceId,helperPid:process.pid,status:"running",
    interactionMode:"automatic",leaseFencing:true,bootstrapReady:true,lastHeartbeatAt:0,conversationKey:"k".repeat(64),view:{webContents:contents},url:contents.url};
  const host:any=Object.assign(Object.create(BrowserHost.prototype),{
    profile:"production",partition:binding.host.partition,observationInstanceId:binding.host.instanceId,
    turnTabs:new Map([[tab.id,tab]]),userCancelledTurnOwners:new Map(),closedTurnOwners:new Map(),
    getBrowserInteractionMode:()=>"automatic",prepareStandbyView:async()=>{},syncPowerSaveBlocker(){},
    logger:{debug(){},info(){},warn(){},error(){}},snapshot(){return{};},writeDescriptor(){},syncViewVisibility(){},
  });
  f.record.threadId="thread";f.record.turnId="turn";f.record.traceId=traceId;
  const scope={operationId:f.record.operationId,executionKey:f.record.executionKey,roundKey:"round",threadId:"thread",turnId:"turn",traceId};
  f.record.nativeScope=scope;
  f.record.rounds.round={events:[],reasoning:[],completed:false};
  let releaseRequest:any, releaseOutcome:"completed"|"cancelled"="completed";
  const request=(record:NativeSubmissionRecord)=>({phase:"native-submission-watch",traceId,helperPid:process.pid,
    surfaceId:binding.lease.surfaceId,host:binding.host,targetId:contents.targetId,sendId:record.sendId});
  const collector=new NativeSubmissionCollector(record=>f.operation.nativeSubmission(record,scope),{binding,deadlineAt,
    watch:(action,record)=>host.nativeSubmissionWatch({...request(record),action,
      ...(action==="start"?{scope,slot:{roundKey:"round",stage:{kind:"final"}}}:{})}),
    readCleanup:(record)=>host.nativeSubmissionWatch({...request(record),action:"read"}),
    requestCancel:(record,intent,dispatchAttempted)=>host.nativeSubmissionWatch({...request(record),action:"cancel-request",intent,
      acknowledgement:{digest:nativeExecutionDigest(intent)},dispatchAttempted}),
    cancelTerminal:async(record,terminal)=>{
      await host.nativeSubmissionWatch({...request(record),action:"cancel-terminal",terminal,acknowledgement:{digest:nativeExecutionDigest(terminal)},
        ...(terminal.proof==="not_dispatched"?{notDispatchedReceipt:{record,acknowledgement:{sendId:record.sendId,revision:record.revision,digest:nativeSubmissionDigest(record)}}}:{})});
      releaseOutcome="cancelled";releaseRequest={sendId:record.sendId,binding:record.binding,sessionEpoch:record.hostWatch!.sessionEpoch,terminalDigest:nativeExecutionDigest(terminal)};
    },
    complete:async(record,ready)=>{
      await host.nativeSubmissionWatch({...request(record),action:"final-complete",
        receipt:{record,acknowledgement:{sendId:record.sendId,revision:record.revision,digest:nativeSubmissionDigest(record)}},
        resultReady:{version:1,scope,sendId:ready.sendId,completedDigest:ready.completedDigest,answerSha256:ready.answerSha256,readyAt:ready.readyAt,digest:nativeExecutionDigest(ready)}});
      releaseOutcome="completed";releaseRequest={sendId:record.sendId,binding:record.binding,sessionEpoch:record.hostWatch!.sessionEpoch,terminalDigest:ready.completedDigest};
    },
  });
  await collector.activate(oldPage.page as any,[]);collector.arm();
  function emit(id:string, helper=true) {
    const raw=JSON.stringify({action:"next",parent_message_id:"client-created-root",messages:[{id,author:{role:"user"},content:{parts:["identical user question"]}}]});
    dbg.emit("message",{},"Network.requestWillBeSent",{requestId:randomUUID(),frameId:"main-frame",loaderId:contents.loaderId,
      request:{method:"POST",url:"https://chatgpt.com/backend-api/f/conversation",postData:raw}});
    if(helper)oldPage.emit(id);
  }
  const complete=async()=>{
    const record=await collector.completed(),ready=collector.makeResultReady(scope,"original answer");
    f.operation.nativeResultReady(ready);await collector.publishResultReady(ready);return record;
  };
  const end=async()=>{
    const result=await host.endTurn(traceId,process.pid,releaseOutcome,false,undefined,true,false,binding.lease.surfaceId,releaseRequest);
    if(result.nativeRelease)f.operation.nativeRelease(result.nativeRelease);
    return result;
  };
  const cleanup=()=>{collector.dispose();dbg.removeAllListeners();contents.removeAllListeners();rmSync(f.root,{recursive:true,force:true});};
  return {...f,scope,collector,host,tab,dbg,oldPage,emit,complete,end,cleanup};
}

for(const helperGap of [false]) {
  test(`bound native original writer completes Temporary with durable Host proof (Page gap=${helperGap})`,async()=>{
    const f=await boundNativeFixture();
    try{
      expect(f.record.nativeSubmissions?.at(-1)?.phase).toBe("watch_ready");
      const id=randomUUID();f.emit(id,!helperGap);
      if(helperGap){const rebound=pageFixture();await f.collector.reattach(rebound.page as any);}
      const accepted=await f.collector.accept(pair(id),"same-bound-assistant-completed"), digest=nativeSubmissionDigest(accepted);
      const checkpoint:any={version:2,submission:{native:accepted}};
      f.operation.assertNativeObservation(checkpoint);
      const completed=await f.complete();
      expect(completed.phase).toBe("completed");expect(completed.revision).toBe(5);
      expect(f.tab.nativeSubmissionWatch.hasCompletion()).toBe(true);
      expect(f.tab.observationDigest).toBeUndefined();
      expect(nativeSubmissionDigest(accepted)).toBe(digest);
      f.operation.assertNativeObservation(checkpoint);
      expect(f.dbg.attachCount).toBe(1);
      await f.end();expect(f.dbg.detachCount).toBe(1);
      expect(f.record.nativeSubmissions).toHaveLength(1);
    }finally{f.cleanup();}
  });
}

test("late physical POST after acknowledged Native completion blocks Host release and retains unresolved physical state",async()=>{
  const f=await boundNativeFixture();
  try {
    const id=randomUUID();f.emit(id);const accepted=await f.collector.accept(pair(id),"same-bound-assistant-completed");
    await f.complete();
    f.emit(randomUUID(),false);
    await expect(f.end()).rejects.toThrow();
    expect(f.dbg.detachCount).toBe(0);expect(f.tab.nativeSubmissionWatch.active).toBe(true);
    const watch=await f.host.nativeSubmissionWatch({phase:"native-submission-watch",action:"read",traceId:"trace",helperPid:process.pid,
      surfaceId:f.tab.surfaceId,sendId:accepted.sendId,host:accepted.binding!.host,targetId:accepted.binding!.lease.targetId});
    expect(watch.conflict).toBe(true);expect(watch.postCount).toBe(2);
    expect(f.record.physicalSettled).not.toBe(true);
  }finally{f.cleanup();}
});


test("Page POST may precede original Host metadata without a duplicate Send",async()=>{
  const f=await boundNativeFixture();
  try {
    const id=randomUUID();
    f.oldPage.emit(id);
    const accepted=f.collector.accept(pair(id),"same-bound-assistant-completed");
    await new Promise(resolve=>setTimeout(resolve,20));
    f.emit(id,false);
    await accepted; await f.complete();await f.end();
    expect(f.record.nativeSubmissions).toHaveLength(1);expect(f.dbg.attachCount).toBe(1);
  } finally {f.cleanup();}
});


test("missing Host POST exhausts only the original handshake budget and stays retained",async()=>{
  const deadline=Date.now()+150;
  const f=await boundNativeFixture(()=>deadline);
  try {
    const id=randomUUID();f.oldPage.emit(id);
    await expect(f.collector.accept(pair(id),"same-bound-assistant-completed")).rejects.toThrow("acknowledgement failed");
    expect(f.record.nativeSubmissions?.at(-1)?.phase).toBe("watch_ready");
    await expect(f.end()).rejects.toThrow();expect(f.dbg.detachCount).toBe(0);
    expect(f.record.physicalSettled).not.toBe(true);expect(f.dbg.attachCount).toBe(1);
  } finally {f.cleanup();}
});


test("Host-only POST cannot grant an original writer a missing durable Page identity",async()=>{
  const f=await boundNativeFixture();
  try {
    f.emit(randomUUID(),false);
    await expect(f.collector.reattach(pageFixture().page as any)).rejects.toThrow("Page POST identity was not durably witnessed");
    expect(f.record.nativeSubmissions?.at(-1)?.phase).toBe("watch_ready");
    expect(f.tab.nativeSubmissionWatch.snapshot().postCount).toBe(1);
    expect(f.dbg.attachCount).toBe(1);expect(f.dbg.detachCount).toBe(0);
    await expect(f.end()).rejects.toThrow();
  } finally {f.cleanup();}
});


browserTest("explicit cancellation uses one real Stop click and durable original terminal before release",async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true,args:["--no-sandbox"]});
  const f=await boundNativeFixture();
  try {
    const page=await browser.newPage(),id=randomUUID();
    await page.setContent(`<section data-turn-key="${id}"><div data-user-message-bubble><div data-search-result-target>controlled original question</div></div><div data-content-search-unit-key="bound:assistant"><h4 data-conversation-role="assistant"></h4><div class="markdown"><p>original partial body</p></div><div id="status"></div></div></section><button data-testid="stop-button" onclick="window.stopClicks=(window.stopClicks||0)+1;document.querySelector('#status').innerHTML='<div aria-label=&quot;Stopped thinking&quot;>Stopped thinking</div>';this.remove()">Stop</button>`);
    f.collector.dispatching();f.emit(id);await f.collector.accept(pair(id),"same-bound-assistant-progress");
    const request={version:1 as const,cancelId:randomUUID(),source:"native_interrupt" as const,threadId:"thread",turnId:"turn",requestedAt:Date.now()};
    const intent=f.operation.nativeCancelIntent(request);
    const worker=Object.create(ChatGptBrowserWorker.prototype) as any;worker.config={};
    await worker.cancelOriginalNativeGeneration(page,f.collector,{nativeOperationScope:f.scope,onNativeCancelTerminal:async(terminal:NativeCancelTerminal)=>{f.operation.nativeCancelTerminal(terminal);}},new ExplicitNativeCancellation(request,intent));
    expect(await page.evaluate(()=>(window as any).stopClicks)).toBe(1);
    expect(f.record.nativeCancelTerminal?.proof).toBe("same-bound-generation-stopped");
    expect(f.record.nativeFinal).toBeUndefined();expect(f.record.physicalSettled).not.toBe(true);
    await f.end();expect(f.record.nativeRelease?.outcome).toBe("cancelled");expect(f.record.physicalSettled).toBe(true);
  } finally {f.cleanup();await browser.close();}
},15000);

test("explicit never-dispatched cancellation retains exact durable watch proof and releases without Stop",async()=>{
  const f=await boundNativeFixture();
  try {
    const request={version:1 as const,cancelId:randomUUID(),source:"native_interrupt" as const,threadId:"thread",turnId:"turn",requestedAt:Date.now()};
    const intent=f.operation.nativeCancelIntent(request);
    const worker=Object.create(ChatGptBrowserWorker.prototype) as any;worker.config={};
    // No Page method is reachable: the original dispatcher has never attempted its physical click.
    await worker.cancelOriginalNativeGeneration({isClosed:()=>false},f.collector,{nativeOperationScope:f.scope,onNativeCancelTerminal:async(terminal:NativeCancelTerminal)=>{f.operation.nativeCancelTerminal(terminal);}},new ExplicitNativeCancellation(request,intent));
    expect(f.record.nativeCancelTerminal?.proof).toBe("not_dispatched");expect(f.record.nativeCancelTerminal?.dispatchAttempted).toBe(false);
    expect(f.tab.nativeSubmissionWatch.snapshot().postCount).toBe(0);
    await f.end();expect(f.record.nativeRelease?.outcome).toBe("cancelled");expect(f.record.physicalSettled).toBe(true);
  } finally {f.cleanup();}
});


test("metadata ACK retries one immutable frame and stops after acknowledgement",async()=>{
  const original={type:"event",id:"original",event:"native_release",payload:{nonce:randomUUID() as string}},expected=JSON.stringify(original),frames:string[]=[];
  const ack=new NativeMetadataAcknowledgement(original,frame=>{frames.push(JSON.stringify(frame));return true;},Date.now()+500,10);
  original.payload.nonce="mutated after construction";
  await new Promise(resolve=>setTimeout(resolve,35));expect(frames.length).toBeGreaterThan(1);expect(new Set(frames)).toEqual(new Set([expected]));
  ack.resolve();await ack.promise;const count=frames.length;await new Promise(resolve=>setTimeout(resolve,30));expect(frames.length).toBe(count);
});

test("metadata ACK exhaustion is retained and cannot leak a retry loop",async()=>{
  let frames=0;const ack=new NativeMetadataAcknowledgement({id:"original",digest:"d".repeat(64)},()=>{frames++;return true;},Date.now()+35,5);
  await expect(ack.promise).rejects.toMatchObject({code:"chatgpt_execution_retained",retryable:false});
  const count=frames;ack.resolve();await new Promise(resolve=>setTimeout(resolve,25));expect(frames).toBe(count);
});

test("metadata ACK at its absolute deadline cannot beat a delayed timeout callback",async()=>{
  const realNow=Date.now;let now=realNow(),frames=0;let ack!:NativeMetadataAcknowledgement;
  try {
    Date.now=()=>now;
    ack=new NativeMetadataAcknowledgement({id:"original",digest:"d".repeat(64)},()=>{frames++;return true;},now+100,80);
    now+=100;ack.resolve();
  }finally{Date.now=realNow;}
  await expect(ack.promise).rejects.toMatchObject({code:"chatgpt_execution_retained",retryable:false});
  const count=frames;await new Promise(resolve=>setTimeout(resolve,25));expect(frames).toBe(count);
});

for(const beforeBootstrap of [false,true])test(`explicit preparation cancellation is durable before helper dispatch (already aborted=${beforeBootstrap})`,async()=>{
  const f=owner(),traceId="bootstrap_cancel",scope={operationId:f.record.operationId,executionKey:f.record.executionKey,roundKey:"round",threadId:"thread",turnId:"turn",traceId};
  f.record.threadId="thread";f.record.turnId="turn";f.record.traceId=traceId;
  f.record.rounds.round={events:[],reasoning:[],completed:false};
  const client:any=new LauncherBrowserHelperClient({} as any),controller=new AbortController(),frames:any[]=[];
  let ready!:()=>void,bootstraps=0,callbacks=0;
  const bootstrap=new Promise<void>(resolve=>{ready=resolve;});
  client.ensureChild=async()=>{bootstraps++;await bootstrap;};
  client.helperFeatures=new Set(["native-submission-v1","native-execution-v1","send-activation-ack"]);
  client.send=async(frame:any)=>{frames.push(frame);};
  const request={version:1 as const,cancelId:randomUUID(),source:"native_interrupt" as const,threadId:"thread",turnId:"turn",requestedAt:Date.now()};
  if(beforeBootstrap)controller.abort(new ExplicitNativeCancellation(request));
  try {
    const result=client.run({traceId,modelId:"gpt-5.6-sol",nativeSubmissionIdentity:true,nativeOperationScope:scope,abortSignal:controller.signal,
      capabilities:{localToolsEnabled:false,proAvailable:false,solAvailable:true,extraHighAvailable:false},prepare:async()=>({text:"original",images:[],release(){}}),onTextDelta(){},
      onNativeSubmission:async()=>{},onNativeResultReady:async()=>{},onNativeRelease:async()=>{},onNativeCancelTerminal:async()=>{},onNativeCancelIntent:async()=>{throw Error("no original slot");},
      onNativePreparationCancel:async(request:any)=>{callbacks++;return f.operation.nativePreparationCancellation(request,scope);},
    }).then((answer:string)=>({answer,error:undefined}), (error:any)=>({error,answer:undefined}));
    await new Promise(resolve=>setTimeout(resolve,0));
    if(!beforeBootstrap)controller.abort(new ExplicitNativeCancellation(request));
    const outcome=await result;
    expect(outcome.error).toMatchObject({code:"client_cancelled",retryable:false});expect(callbacks).toBe(1);
    expect(f.record.nativePreparationCancel?.request).toEqual(request);expect(f.record.error).toEqual({code:"client_cancelled",retryable:false});
    expect(f.journal.read<OperationRecord>(f.record.executionKey)?.nativePreparationCancel?.request).toEqual(request);
    expect(frames).toHaveLength(0);expect(bootstraps).toBe(beforeBootstrap?0:1);
    ready();await new Promise(resolve=>setTimeout(resolve,10));expect(frames).toHaveLength(0);expect(client.pending.size).toBe(0);
  }finally{ready();await client.close();rmSync(f.root,{recursive:true,force:true});}
},3_000);

test("actual paired helper exits its failed result-ready ACK wait on retained abort",async()=>{
  const f=owner(),helper=join(f.root,"ack-failure-helper.ts"),descriptor=join(f.root,"ack-failure-launcher.json");
  const workerModule=new URL("../src/adapters/chatgpt-web/browser-worker.ts",import.meta.url).href;
  const helperModule=new URL("../src/adapters/chatgpt-web/browser-helper-main.ts",import.meta.url).href;
  const scope={operationId:"op",executionKey:"key",roundKey:"round",threadId:"thread",turnId:"turn",traceId:"ack_failure"},sendId=randomUUID();
  writeFileSync(helper,`
    import {ChatGptBrowserWorker} from ${JSON.stringify(workerModule)};
    ChatGptBrowserWorker.prototype.run=async function(turn){
      await turn.onPreparedSelected(false);await turn.prepare();await turn.onSendActivated();
      await turn.onNativeSubmission({version:1,sendId:${JSON.stringify(sendId)},revision:1,phase:"send_activated",initialTurnIdentities:[]});
      await turn.onNativeResultReady({version:1,scope:${JSON.stringify(scope)},sendId:${JSON.stringify(sendId)},completedDigest:"a".repeat(64),answer:"original",answerSha256:"b".repeat(64),readyAt:Date.now()});
      throw new Error("failed ACK must not permit this continuation");
    };
    await import(${JSON.stringify(helperModule)});
  `);
  writeFileSync(descriptor,JSON.stringify({version:3,kind:LAUNCHER_BROWSER_HOST_KIND,profile:"production",pid:process.pid,
    endpoint:"http://127.0.0.1:39110",control:{endpoint:"http://127.0.0.1:39111",token:"t".repeat(64)},helper:{executable:process.execPath,script:helper},partition:"persist:codex-web-gpt-chatgpt",idleUrl:LAUNCHER_BROWSER_IDLE_URL,surfaceId:"s".repeat(32),surfaceTargets:{["s".repeat(32)]:"target"},createdAt:new Date().toISOString()}),{mode:0o600});
  const client=new LauncherBrowserHelperClient(resolveBrowserConfig({adapter:"chatgpt-web",baseUrl:"browser://native-fixture",chatgptWeb:{accountId:"account2",browserHost:"launcher",browserHostDescriptorPath:descriptor,browserHelperScriptPath:helper}}));
  let callbacks=0;
  try {
    const began=Date.now();
    await expect(client.run({traceId:"ack_failure",modelId:"gpt-5.6-sol",nativeSubmissionIdentity:true,nativeOperationScope:scope,
      capabilities:{localToolsEnabled:false,proAvailable:false,solAvailable:true,extraHighAvailable:false},prepare:async()=>({text:"original",images:[],release(){}}),onTextDelta(){},onNativeSubmission:async()=>{},
      onNativeResultReady:async()=>{callbacks++;throw new Error("controlled durable result write failure");},onNativeRelease:async()=>{},onNativeCancelTerminal:async()=>{},onNativeCancelIntent:async()=>{throw new Error("not used");},onNativePreparationCancel:async()=>{throw new Error("not used");},
    })).rejects.toMatchObject({code:"chatgpt_submission_identity_unproven",retryable:false});
    expect(callbacks).toBe(1);expect(Date.now()-began).toBeLessThan(2_000);expect((client as any).pending.size).toBe(0);
  }finally{await client.close();rmSync(f.root,{recursive:true,force:true});}
},5_000);

test("actual paired helper enters explicit cleanup during observation ACK and ignores its late exact ACK",async()=>{
  const f=await boundNativeFixture(undefined,"observation_cancel"),helper=join(f.root,"observation-cancel-helper.ts"),descriptor=join(f.root,"observation-cancel-launcher.json"),proof=join(f.root,"cleanup-entered.json");
  const workerModule=new URL("../src/adapters/chatgpt-web/browser-worker.ts",import.meta.url).href;
  const helperModule=new URL("../src/adapters/chatgpt-web/browser-helper-main.ts",import.meta.url).href;
  const executionModule=new URL("../src/adapters/chatgpt-web/native-execution.ts",import.meta.url).href;
  const id=randomUUID();f.collector.dispatching();f.emit(id);const accepted=await f.collector.accept(pair(id),"same-bound-assistant-progress");
  const {traceId,...identity}=f.scope;
  const checkpoint:any={version:2,identity,traceId,modelId:"gpt-5.6-sol",accountId:"account2",appName:"Codex",
    host:accepted.binding!.host,lease:accepted.binding!.lease,conversation:{key:"conversation",url:`https://chatgpt.com/c/${randomUUID()}`,claim:"claim"},
    submission:{native:accepted,initialTurnIdentities:[],acceptedUserIdentity:pair(id)[0],assistantIdentity:pair(id)[1],acceptedTurnIdentities:pair(id)}};
  parseBrowserObservation(checkpoint);
  writeFileSync(helper,`
    import {writeFileSync} from "node:fs";
    import {ChatGptBrowserWorker} from ${JSON.stringify(workerModule)};
    import {ExplicitNativeCancellation} from ${JSON.stringify(executionModule)};
    ChatGptBrowserWorker.prototype.run=async function(turn){
      await turn.onPreparedSelected(false);await turn.prepare();await turn.onSendActivated();
      await turn.onNativeSubmission(${JSON.stringify(accepted)});
      try{await turn.onObservationReady(${JSON.stringify(checkpoint)});throw Error("cancel must interrupt original observation ACK");}
      catch(error){
        writeFileSync(${JSON.stringify(proof)},JSON.stringify({explicit:turn.abortSignal.reason instanceof ExplicitNativeCancellation,name:error.name,scope:turn.abortSignal.reason.intent?.scope}));
        await new Promise(resolve=>setTimeout(resolve,100));
        throw turn.abortSignal.reason;
      }
    };
    await import(${JSON.stringify(helperModule)});
  `);
  writeFileSync(descriptor,JSON.stringify({version:3,kind:LAUNCHER_BROWSER_HOST_KIND,profile:"production",pid:process.pid,
    endpoint:"http://127.0.0.1:39110",control:{endpoint:"http://127.0.0.1:39111",token:"t".repeat(64)},helper:{executable:process.execPath,script:helper},partition:"persist:codex-web-gpt-chatgpt",idleUrl:LAUNCHER_BROWSER_IDLE_URL,surfaceId:"s".repeat(32),surfaceTargets:{["s".repeat(32)]:"target"},createdAt:new Date().toISOString()}),{mode:0o600});
  const client=new LauncherBrowserHelperClient(resolveBrowserConfig({adapter:"chatgpt-web",baseUrl:"browser://native-fixture",chatgptWeb:{accountId:"account2",appName:"Codex",browserHost:"launcher",browserHostDescriptorPath:descriptor,browserHelperScriptPath:helper}}));
  const controller=new AbortController(),frames:any[]=[];let releaseCallback!:()=>void,callbackStarted!:()=>void;
  const started=new Promise<void>(resolve=>{callbackStarted=resolve;}),gate=new Promise<void>(resolve=>{releaseCallback=resolve;});
  const originalSend=(client as any).send.bind(client);(client as any).send=async(message:any)=>{frames.push(message);return originalSend(message);};
  let settled:Promise<any>|undefined;
  try {
    settled=client.run({traceId,modelId:"gpt-5.6-sol",nativeSubmissionIdentity:true,nativeOperationScope:f.scope,observationIdentity:identity,
      capabilities:{localToolsEnabled:false,proAvailable:false,solAvailable:true,extraHighAvailable:false},abortSignal:controller.signal,
      prepare:async()=>({text:"original",images:[],release(){}}),onTextDelta(){},onNativeSubmission:async()=>{},
      onNativeResultReady:async()=>{},onNativeRelease:async()=>{},onNativeCancelTerminal:async()=>{},onNativePreparationCancel:async()=>{throw Error("not preparation");},
      onNativeCancelIntent:async(request)=>f.operation.nativeCancelIntent(request),onObservationReady:async()=>{callbackStarted();await gate;},
    }).then(answer=>({answer}),error=>({error}));
    await Promise.race([started,settled.then(result=>{throw new Error(`helper exited before observation: ${result.error?.message??result.answer}`);})]);const began=Date.now();
    controller.abort(new ExplicitNativeCancellation({version:1,cancelId:randomUUID(),source:"native_interrupt",threadId:"thread",turnId:"turn",requestedAt:Date.now()}));
    while(!(await Bun.file(proof).exists())&&Date.now()-began<2_000)await new Promise(resolve=>setTimeout(resolve,10));
    expect(await Bun.file(proof).exists()).toBe(true);
    expect(JSON.parse(readFileSync(proof,"utf8"))).toMatchObject({explicit:true,name:"AbortError",scope:f.scope});
    releaseCallback();const result=await settled;
    expect(result.error).toBeDefined();expect(Date.now()-began).toBeLessThan(2_000);
    expect(frames.filter(frame=>frame.type==="observation_ready_ack")).toHaveLength(1);
    expect(frames.find(frame=>frame.type==="observation_ready_ack").digest).toBe(nativeExecutionDigest(checkpoint));
    expect(frames.filter(frame=>frame.type==="abort"&&frame.reason==="native_interrupt")).toHaveLength(1);
    expect((client as any).pending.size).toBe(0);expect(f.record.physicalSettled).not.toBe(true);
  }finally{releaseCallback();await client.close();if(settled)await settled;f.cleanup();}
},5_000);
