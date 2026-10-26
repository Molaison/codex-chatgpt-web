import { tmpdir } from "node:os";
import { afterAll, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DurableOperation, OperationJournal, operationDigest, nativeOperationReleased, retainedOperationError, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";
import { ChatGptTurnSession, ChatGptTurnSessions, ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptPartialReceiptRound } from "../src/adapters/chatgpt-web/turn-execution";
import { nativeSubmissionDigest, parseNativeSubmission, submissionIdentityUnproven, type NativeSubmissionRecord } from "../src/adapters/chatgpt-web/submission-identity";
import type { NativeOperationScope, NativeResultReady, NativeReleaseReceipt, NativeCancelRequest, NativeCancelTerminal } from "../src/adapters/chatgpt-web/native-execution";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";
import { buildResponseJSON } from "../src/bridge";
import { restoreNativeFinalRuntime as restore, reconcileNativeHostRelease, nativeScopeForOperation, acknowledgeNativeResultReady,
 restoreChatGptObserverRound, chatGptWebExecutionNamespace, chatGptWebTraceId } from "../src/adapters/chatgpt-web/index";

const evidence = process.env.Q39_TEST_ROOT ?? mkdtempSync(join(tmpdir(), "native-evidence-"));
afterAll(() => { if (!process.env.Q39_TEST_ROOT) rmSync(evidence, { recursive: true, force: true }); });
mkdirSync(evidence, { recursive: true });
function deferred<T>() { let resolve!: (v:T)=>void, reject!: (e:Error)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("private fixture timeout")),800);})]);}finally{clearTimeout(timer);}}
function parsed():CodexParsedRequest {return {modelId:"chatgpt-web/gpt-5.6",stream:true,options:{},context:{messages:[{role:"user",content:"Same exact question",timestamp:0}]},_rawBody:{client_metadata:{"x-codex-turn-metadata":JSON.stringify({thread_id:"thread-original",turn_id:"turn-original"})},input:[{type:"message",id:"user-original",role:"user",content:"Same exact question",internal_chat_message_metadata_passthrough:{turn_id:"turn-original"}}]}};}
function fixture(phase:"watch_ready"|"post_observed"|"accepted"|"completed"="completed") {
 const input=parsed(), roundKey=chatGptTurnRoundKey(input), executionKey=chatGptTurnExecutionKey(input), t=Date.now()-100;
 const scope:NativeOperationScope={operationId:"operation-original",executionKey,roundKey,threadId:"thread-original",turnId:"turn-original",traceId:"trace-original"};
 const record:OperationRecord={version:1,...scope,ownerKey:"owner-original",nativeScope:scope,requestIds:[],submission:"prepared",generation:"not_started",delivery:"attached",recovery:"none",seq:0,attempt:1,startedAt:t,updatedAt:t,rounds:{[roundKey]:{events:[],reasoning:[],completed:false}}};
 const journal=new OperationJournal(mkdtempSync(join(evidence!,"case-"))),op=new DurableOperation(journal,record);
 const binding:any={roundKey,stage:{kind:"final"},documentEpoch:null,host:{pid:11,instanceId:"h".repeat(32),profile:"production",partition:"persist:codex-web-gpt-chatgpt"},lease:{helperPid:22,surfaceId:"s".repeat(32),targetId:"original-target"}};
 let slot:NativeSubmissionRecord={version:1,sendId:randomUUID(),revision:1,phase:"send_activated",initialTurnIdentities:[],binding};
 op.beforeSend();op.nativeSubmission(slot);
 const watch:any={version:1,traceId:scope.traceId,sendId:slot.sendId,currentSendId:slot.sendId,binding:{...binding,documentEpoch:"original-document"},segmentState:"watching",totalPostCount:0,segments:[],latePosts:[],host:binding.host,lease:binding.lease,sessionEpoch:randomUUID(),documentEpoch:"original-document",mainFrame:{frameId:"frame",loaderId:"loader"},seq:1,active:true,gap:false,gapReasons:[],conflict:false,conflictReasons:[],postCount:0,identities:[],startedAt:t,readAt:t,initialConversationId:null,boundConversationId:null,flush:{stable:true,pending:0,throughSeq:1}};
 slot={...slot,revision:2,phase:"watch_ready",binding:watch.binding,hostWatch:watch};op.nativeSubmission(slot);
 const id=randomUUID(), pair=[`group:user:${id}`,`group:assistant:${id}`];
 if(phase!=="watch_ready"){
  const post:any={userMessageId:id,payloadSha256:operationDigest("same actual user bytes"),action:{presence:"value",value:"next"},parentMessageId:{presence:"value",value:"client-created-root"},conversationId:{presence:"absent"},observedAt:t+1};
  const postWatch={...watch,seq:2,postCount:1,totalPostCount:1,identities:[{...post,ordinal:1,watchOrdinal:1,endpoint:"/backend-api/f/conversation",requestId:"request-original",frameId:"frame",loaderId:"loader"}],flush:{stable:true,pending:0,throughSeq:2}};
  slot={...slot,revision:3,phase:"post_observed",post,hostWatch:postWatch};op.nativeSubmission(slot);
 }
 const accept=()=>{slot={...slot,revision:4,phase:"accepted",dom:{acceptedUserIdentity:pair[0],assistantIdentity:pair[1],acceptedTurnIdentities:pair,proof:"same-bound-assistant-progress",observedAt:t+2}};op.nativeSubmission(slot);op.accepted();};
 if(phase==="accepted"||phase==="completed")accept();
 const complete=()=>{slot={...slot,revision:5,phase:"completed",completion:{proof:"same-bound-assistant-completed",assistantIdentity:pair[1],userMessageId:id,payloadSha256:slot.post!.payloadSha256,watchSeq:2,observedAt:t+3}};op.nativeSubmission(slot);};
 if(phase==="completed")complete();
 const ready=(answer="Original answer"):NativeResultReady=>({version:1,scope,sendId:slot.sendId,completedDigest:nativeSubmissionDigest(slot),answer,answerSha256:operationDigest(answer),readyAt:t+4});
 const release=(outcome:"completed"|"cancelled"="completed"):NativeReleaseReceipt=>({version:1,releaseId:randomUUID(),sendId:slot.sendId,roundKey,sessionEpoch:watch.sessionEpoch,host:binding.host,lease:binding.lease,documentEpoch:watch.documentEpoch,outcome,terminalDigest:outcome==="completed"?nativeSubmissionDigest(slot):operationDigest(JSON.stringify(record.nativeCancelTerminal))});
 const request=():NativeCancelRequest=>({version:1,cancelId:randomUUID(),source:"native_interrupt",threadId:scope.threadId!,turnId:scope.turnId,requestedAt:Date.now()});
 const terminal=(proof:NativeCancelTerminal["proof"]="same-bound-generation-stopped"):NativeCancelTerminal=>({cancelId:record.nativeCancelIntent!.cancelId,sendId:slot.sendId,sessionEpoch:watch.sessionEpoch,watchSeq:slot.hostWatch!.seq,proof,dispatchAttempted:proof!=="not_dispatched",...(proof!=="not_dispatched"?{assistantIdentity:pair[1]}:{}),observedAt:Date.now()+1});
 return {op,record,journal,input,scope,ready,release,request,terminal,accept,complete,slot:()=>slot};
}
function runtime(f:ReturnType<typeof fixture>,browser:Promise<string>,physicalSettlement:Promise<void> = browser.then(()=>{})) {return {mode:"read-only" as const,operation:f.op,browser,physicalSettlement,trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),submission:{phase:"accepted" as const},conversationKey:"conversation",cancel(){}};}

test("durable ready returns full answer before helper/end, while release alone unlocks successor",async()=>{
 const f=fixture(),generation=deferred<string>(),physical=deferred<void>(),registry=new ChatGptTurnSessions();let starts=0;
 const session=registry.getOrCreate("original",()=>runtime(f,generation.promise,physical.promise),f.scope.traceId,f.record.ownerKey);
 f.op.nativeResultReady(f.ready());expect(await bounded(session.browserOutcome)).toEqual({type:"final",answer:"Original answer"});
 expect(session.isPhysicallySettled()).toBe(false);expect(f.record.physicalSettled).toBe(false);expect(f.journal.unresolvedOwner(f.record.ownerKey!,"next")).toBeDefined();
 physical.reject(submissionIdentityUnproven("helper died after ready ACK"));
 await expect(bounded(registry.getOrCreateAfterOwnerRetirement("next",f.record.ownerKey!,()=>{starts++;return runtime(f,Promise.resolve("unexpected"));}))).rejects.toThrow("retained");expect(starts).toBe(0);
 const receipt=f.release();f.op.nativeRelease(receipt);await bounded(session.physicalSettlement);
 expect(nativeOperationReleased(f.record)).toBe(true);expect(f.journal.unresolvedOwner(f.record.ownerKey!,"next")).toBeUndefined();
 await bounded(registry.getOrCreateAfterOwnerRetirement("next",f.record.ownerKey!,()=>{starts++;return {mode:"read-only",browser:Promise.resolve("new intent"),physicalSettlement:Promise.resolve(),text:new ChatGptTextFeed(),trace:new ChatGptTraceFeed(),cancel(){}};}));expect(starts).toBe(1);
 const writes=f.journal.metrics.writes;f.op.nativeRelease(receipt);expect(f.journal.metrics.writes).toBe(writes);
});

test("readonly success and legacy generation final do not fabricate Native release",async()=>{
 const f=fixture("accepted");f.record.generation="final";f.record.final={answer:"unscoped legacy answer",events:[],reasoning:[]};f.record.physicalSettled=true;f.op.checkpoint();
 expect(nativeOperationReleased(f.record)).toBe(false);expect(f.journal.unresolvedOwner(f.record.ownerKey!,"next")).toBeDefined();
 const session=new ChatGptTurnSession(runtime(f,Promise.resolve("observed answer")));await bounded(session.browserOutcome);
 await expect(bounded(session.waitForPhysicalSettlement())).rejects.toThrow("retained");expect(session.isPhysicallySettled()).toBe(false);expect(f.record.final).toBeUndefined();
 expect(()=>restore(f.op,f.input)).toThrow("scoped final");
});

test("current final strictly requires original round and exact prefix; release missing is not answer loss",async()=>{
 const f=fixture();f.record.rounds[f.scope.roundKey].events=[{type:"text_delta",text:"Original",phase:"final_answer"}];f.op.nativeResultReady(f.ready());
 const r=restore(f.op,f.input);expect(await r.browser).toBe("Original answer");expect(r.text.drain()).toEqual([" answer"]);await expect(r.physicalSettlement).rejects.toThrow("retained");
 const changed=structuredClone(f.input);(changed._rawBody as any).input.unshift({type:"message",role:"assistant",id:"foreign-history",content:"Another history"});
 expect(chatGptTurnExecutionKey(changed)).toBe(chatGptTurnExecutionKey(f.input));expect(chatGptTurnRoundKey(changed)).not.toBe(f.scope.roundKey);
 expect(()=>restore(f.op,changed)).toThrow("scope");
 f.record.rounds[f.scope.roundKey].events=[{type:"text_delta",text:"Other",phase:"final_answer"}];expect(()=>restore(f.op,f.input)).toThrow("prefix");
});

test("cold durable Native final restores its chart projection without a new writer", async () => {
  const f = fixture();
  f.record.richWidgets = [{ version: 1, kind: "pie_chart", id: "chart-1", title: "Original chart",
    labelField: "label", valueField: "value", slices: [{ label: "original", value: 1 }] }];
  f.op.nativeResultReady(f.ready());
  f.op.nativeRelease(f.release());
  f.record.generation = "final";
  f.record.final = { answer: "Original answer", events: [], reasoning: [] };
  f.record.physicalSettled = true;
  f.op.checkpoint();
  const operation = new DurableOperation(f.journal, f.journal.read<OperationRecord>(f.scope.executionKey)!);
  const restored = restore(operation, f.input);
  expect(await restored.browser).toBe("Original answer");
  expect(restored.richWidgets).toEqual(f.record.richWidgets);
  await restored.physicalSettlement;
  expect(f.journal.unresolvedOwner(f.record.ownerKey!, "next")).toBeUndefined();
});

test("only the existing exact partial-item receipt proof aliases the original final round",async()=>{
 const f=fixture();const events:any[]=[{type:"text_delta",text:"Original",phase:"final_answer"}];f.record.rounds[f.scope.roundKey].events=events;f.op.nativeResultReady(f.ready());
 const identity=operationDigest(JSON.stringify([f.scope.traceId,f.scope.roundKey])).slice(0,32);
 const output=buildResponseJSON(events,f.input.modelId,{replayIdentity:identity}).output as any[];
 const retry=structuredClone(f.input);(retry._rawBody as any).input.push(output.find(v=>v.type==="message"));
 const alias=chatGptPartialReceiptRound(retry,f.scope.traceId,f.record.rounds);expect(alias).toBe(f.scope.roundKey);
 expect(()=>restore(f.op,retry)).toThrow();retry._chatgptObserverRoundKey=alias;expect(await restore(f.op,retry).browser).toBe("Original answer");
});

for(const mutation of ["scope","sendId","answerHash","completedDigest"]){test(`result-ready rejects ${mutation} mismatch`,()=>{const f=fixture(),r=f.ready();if(mutation==="scope")r.scope={...r.scope,roundKey:"other"};if(mutation==="sendId")r.sendId=randomUUID();if(mutation==="answerHash")r.answer+="tampered";if(mutation==="completedDigest")r.completedDigest="f".repeat(64);expect(()=>f.op.nativeResultReady(r)).toThrow();expect(f.record.nativeFinal).toBeUndefined();});}
for(const mutation of ["sessionEpoch","documentEpoch","roundKey","sendId","host","lease","terminalDigest"]){test(`release rejects ${mutation} mismatch`,()=>{const f=fixture();f.op.nativeResultReady(f.ready());const r=f.release();if(mutation==="host")r.host={...r.host,pid:99};else if(mutation==="lease")r.lease={...r.lease,helperPid:99};else (r as any)[mutation]="foreign";expect(()=>f.op.nativeRelease(r)).toThrow();expect(f.op.hasNativeRelease()).toBe(false);});}

test("failed result-ready write rolls back, poisons ACK and never opens result/release",()=>{
 const f=fixture();f.journal.write=()=>{throw Error("injected durable write failure");};expect(()=>f.op.nativeResultReady(f.ready())).toThrow("checkpoint");expect(f.record.nativeFinal).toBeUndefined();expect(f.op.hasNativeRelease()).toBe(false);expect(()=>f.op.nativeResultReady(f.ready())).toThrow("persistence");
});
test("failed release persistence leaves ready readable on disk and the physical owner fenced",async()=>{
 const f=fixture();f.op.nativeResultReady(f.ready());const disk=f.journal.read<OperationRecord>(f.scope.executionKey)!;f.journal.write=()=>{throw Error("release fsync failure");};expect(()=>f.op.nativeRelease(f.release())).toThrow("checkpoint");expect(f.record.nativeRelease).toBeUndefined();expect(f.record.physicalSettled).toBe(false);expect(f.op.hasNativeRelease()).toBe(false);
 const reloaded=new DurableOperation(new OperationJournal(f.journal.directory.replace(/\/operations$/,"")),disk);expect(reloaded.nativeFinalFor(f.scope).answer).toBe("Original answer");expect(reloaded.hasNativeRelease()).toBe(false);
});

test("cancel intent, terminal and actual release are three separate durable gates",async()=>{
 const f=fixture("accepted"),request=f.request();const intent=f.op.nativeCancelIntent(request);expect(intent.binding.documentEpoch).toBe("original-document");expect(f.record.nativeCancelTerminal).toBeUndefined();expect(f.op.hasNativeRelease()).toBe(false);expect(f.op.nativeCancelIntent(request)).toEqual(intent);
 expect(()=>f.op.nativeCancelIntent({...request,cancelId:randomUUID()})).toThrow();expect(()=>f.op.nativeCancelTerminal({...f.terminal(),cancelId:randomUUID()})).toThrow();
 f.op.nativeCancelTerminal(f.terminal());expect(f.op.hasNativeRelease()).toBe(false);const release=f.release("cancelled");f.op.nativeRelease(release);expect(f.op.hasNativeRelease()).toBe(true);expect(f.record.nativeFinal).toBeUndefined();
});
test("cancel not-dispatched is refused after POST and cannot turn completion into cancellation",()=>{
 const f=fixture("accepted");f.op.nativeCancelIntent(f.request());expect(()=>f.op.nativeCancelTerminal(f.terminal("not_dispatched"))).toThrow();
 const complete=fixture();complete.op.nativeCancelIntent(complete.request());expect(()=>complete.op.nativeCancelTerminal(complete.terminal())).toThrow();complete.op.nativeCancelTerminal(complete.terminal("same-bound-generation-completed"));expect(()=>complete.op.nativeRelease(complete.release("cancelled"))).toThrow();
 complete.op.nativeResultReady(complete.ready());complete.op.nativeRelease(complete.release());expect(complete.op.hasNativeRelease()).toBe(true);
});
test("not-dispatched requires original registered document and absent POST, without authorizing Send",()=>{
 const f=fixture("watch_ready");f.op.nativeCancelIntent(f.request());f.op.nativeCancelTerminal(f.terminal("not_dispatched"));f.op.nativeRelease(f.release("cancelled"));expect(f.op.hasNativeRelease()).toBe(true);
 const missing=fixture("watch_ready");missing.record.nativeSubmissions![0].binding!.documentEpoch=null;expect(()=>missing.op.nativeCancelIntent(missing.request())).toThrow();
});
test("retired Native owner can be reconciled after helper death without permanently rejected retirement",async()=>{
 const f=fixture(),registry=new ChatGptTurnSessions();f.op.nativeResultReady(f.ready());const session=registry.getOrCreate("original",()=>runtime(f,Promise.reject(submissionIdentityUnproven("helper died"))),f.scope.traceId,f.record.ownerKey,f.scope.turnId,f.scope.threadId);
 await bounded(session.browserOutcome);const cancellation=registry.cancelNativeTurn(f.scope.threadId!,f.scope.turnId,Error("retire fixture"));await expect(bounded(cancellation.settlement)).rejects.toThrow("retained");
 expect(registry.findPhysicalOwner("original")).toBe(session);f.op.nativeRelease(f.release());await bounded(session.physicalSettlement);
 let starts=0;await bounded(registry.getOrCreateAfterOwnerRetirement("next",f.record.ownerKey!,()=>{starts++;return {mode:"read-only",browser:Promise.resolve("new"),physicalSettlement:Promise.resolve(),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),cancel(){}};}));expect(starts).toBe(1);
});

test("turn-only scope preserves absence, returns final and metadata release, but cannot cancel",async()=>{
 const f=fixture();delete f.scope.threadId;delete f.record.threadId;
 const metadata=JSON.parse((f.input._rawBody as any).client_metadata["x-codex-turn-metadata"]);delete metadata.thread_id;(f.input._rawBody as any).client_metadata["x-codex-turn-metadata"]=JSON.stringify(metadata);
 // Rebind the fresh fixture's logical identity before publishing a result; no fake thread ID.
 const executionKey=chatGptTurnExecutionKey(f.input),roundKey=chatGptTurnRoundKey(f.input),oldRound=f.scope.roundKey;
 f.scope.executionKey=f.record.executionKey=executionKey;f.scope.roundKey=roundKey;f.record.rounds={[roundKey]:f.record.rounds[oldRound]};
 for(const slot of f.record.nativeSubmissions!){slot.binding!.roundKey=roundKey;slot.hostWatch!.binding!.roundKey=roundKey;}
 const local=f.slot();local.binding!.roundKey=roundKey;local.hostWatch!.binding!.roundKey=roundKey;
 const ready={...f.ready(),scope:f.scope,completedDigest:nativeSubmissionDigest(f.record.nativeSubmissions!.at(-1)!)};f.op.nativeResultReady(ready);
 expect(Object.hasOwn(nativeScopeForOperation(f.op,f.input),"threadId")).toBe(false);expect(await restore(f.op,f.input).browser).toBe("Original answer");
 expect(()=>f.op.nativeCancelIntent({...f.request(),threadId:"invented"})).toThrow();
 const release={...f.release(),roundKey,terminalDigest:ready.completedDigest};let reads=0;
 expect(await reconcileNativeHostRelease(f.op,"unused-private-descriptor",release,async(_path,q,timeout)=>{reads++;expect(q.helperPid).toBe(process.pid);expect(Object.hasOwn(q.scope,"threadId")).toBe(false);expect(q.phase).toBe("native-release-read");expect(timeout).toBe(2000);return {nativeRelease:release};})).toBe(true);
 expect(reads).toBe(1);expect(f.op.hasNativeRelease()).toBe(true);
});
test("no turn identity remains pre-Send rejection without inventing HTTP/native IDs",()=>{
 const f=fixture();delete (f.input._rawBody as any).client_metadata;expect(()=>nativeScopeForOperation(f.op,f.input)).toThrow();expect(()=>chatGptTurnExecutionKey(f.input)).toThrow("turn_id");
});
test("metadata-only release query uses ready digest, actual caller PID, and refuses null/conflicting receipt",async()=>{
 const f=fixture();f.op.nativeResultReady(f.ready());const receipt=f.release();
 await expect(reconcileNativeHostRelease(f.op,"unused",receipt,async()=>({nativeRelease:null}))).rejects.toThrow("retained");expect(f.op.hasNativeRelease()).toBe(false);
 expect(await reconcileNativeHostRelease(f.op,"unused",undefined,async()=>({nativeRelease:null}))).toBe(false);
 await expect(reconcileNativeHostRelease(f.op,"unused",receipt,async()=>({nativeRelease:{...receipt,releaseId:randomUUID()}}))).rejects.toThrow();expect(f.op.hasNativeRelease()).toBe(false);
 expect(await reconcileNativeHostRelease(f.op,"unused",receipt,async(_path,q)=>{expect(q.helperPid).not.toBe(q.binding.lease.helperPid);expect(q.authorization).toEqual({resultReadyDigest:operationDigest(JSON.stringify(f.record.nativeFinal))});return {nativeRelease:receipt};})).toBe(true);
});
test("32b cancel release query supplies all three durable digests without impersonating writer",async()=>{
 const f=fixture("accepted");f.op.nativeCancelIntent(f.request());f.op.nativeCancelTerminal(f.terminal());const receipt=f.release("cancelled");
 expect(await reconcileNativeHostRelease(f.op,"unused",receipt,async(_path,q)=>{expect(q.helperPid).toBe(process.pid);expect(q.binding.lease.helperPid).toBe(22);expect(q.authorization).toEqual({cancelId:f.record.nativeCancelIntent!.cancelId,terminalDigest:operationDigest(JSON.stringify(f.record.nativeCancelTerminal)),intentDigest:operationDigest(JSON.stringify(f.record.nativeCancelIntent))});return {nativeRelease:receipt};})).toBe(true);
});
test("early POST cancellation persists owned accepted group and stopped terminal without completed/resultReady",()=>{
 const f=fixture("post_observed");f.op.nativeCancelIntent(f.request());expect(()=>f.op.nativeCancelTerminal(f.terminal())).toThrow();
 f.accept();f.op.nativeCancelTerminal(f.terminal());expect(f.record.nativeSubmissions!.at(-1)!.phase).toBe("accepted");expect(f.record.nativeFinal).toBeUndefined();f.op.nativeRelease(f.release("cancelled"));expect(f.op.hasNativeRelease()).toBe(true);
});
test("dispatch-attempt flag is required and cannot contradict stopped/not-dispatched terminal",()=>{
 const stopped=fixture("accepted");stopped.op.nativeCancelIntent(stopped.request());expect(()=>stopped.op.nativeCancelTerminal({...stopped.terminal(),dispatchAttempted:false})).toThrow();
 const untouched=fixture("watch_ready");untouched.op.nativeCancelIntent(untouched.request());expect(()=>untouched.op.nativeCancelTerminal({...untouched.terminal("not_dispatched"),dispatchAttempted:true})).toThrow();
 const missing:any=untouched.terminal("not_dispatched");delete missing.dispatchAttempted;expect(()=>untouched.op.nativeCancelTerminal(missing)).toThrow();
});

test("conversation retirement preserves original physical owner and later sealed release opens admission",async()=>{
 const f=fixture(),registry=new ChatGptTurnSessions();f.op.nativeResultReady(f.ready());let contextReleases=0;
 const session=registry.getOrCreate("original",()=>({...runtime(f,Promise.reject(submissionIdentityUnproven("helper died"))),
   releaseRetainedConversation:async()=>{contextReleases++;}}),f.scope.traceId,f.record.ownerKey);
 await bounded(session.browserOutcome);
 await expect(bounded(registry.retireConversationAndWait("conversation"))).rejects.toThrow("retained");
 expect(registry.findPhysicalOwner("original")).toBe(session);
 await expect(bounded(registry.waitForConversationRetirement("conversation"))).rejects.toThrow("retained");
 let starts=0;
 const start=()=>{starts++;return {mode:"read-only" as const,browser:Promise.resolve("next"),physicalSettlement:Promise.resolve(),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),cancel(){}};};
 await expect(bounded(registry.getOrCreateAfterOwnerRetirement("next",f.record.ownerKey!,start))).rejects.toThrow("retained");
 expect(starts).toBe(0);expect(contextReleases).toBe(0);
 f.op.nativeRelease(f.release());await bounded(registry.waitForConversationRetirement("conversation"));
 expect(contextReleases).toBe(1);
 await bounded(registry.getOrCreateAfterOwnerRetirement("next",f.record.ownerKey!,start));expect(starts).toBe(1);
});

test("result-ready refuses a foreign current-round prefix before ACK and does not borrow history",()=>{
 const f=fixture();
 f.record.rounds["historical-round"]={events:[{type:"text_delta",text:"irrelevant old answer",phase:"final_answer"}],reasoning:[],completed:true};
 f.record.rounds[f.scope.roundKey].events=[{type:"text_delta",text:"foreign prefix",phase:"final_answer"}];
 expect(()=>f.op.nativeResultReady(f.ready())).toThrow("prefix");expect(f.record.nativeFinal).toBeUndefined();
 f.record.rounds[f.scope.roundKey].events=[{type:"text_delta",text:"Original",phase:"final_answer"}];
 f.op.nativeResultReady(f.ready());expect(f.op.nativeFinalFor(f.scope).answer).toBe("Original answer");
});

test("completion race uses durable full answer to complete only the exact existing feed prefix",async()=>{
 const f=fixture(),pending=deferred<string>(),r=runtime(f,pending.promise);r.text.push("Original");
 const session=new ChatGptTurnSession(r);r.text.drain();
 f.op.nativeResultReady(f.ready());expect(await bounded(session.browserOutcome)).toEqual({type:"final",answer:"Original answer"});
 expect(r.text.value()).toBe("Original answer");expect(r.text.drain()).toEqual([" answer"]);expect(session.isPhysicallySettled()).toBe(false);
 const other=fixture(),bad=runtime(other,deferred<string>().promise);bad.text.push("foreign");const rejected=new ChatGptTurnSession(bad);
 other.op.nativeResultReady(other.ready());expect((await bounded(rejected.browserOutcome)).type).toBe("error");expect(bad.text.value()).toBe("foreign");
});

test("Temporary final reconnect permits only proven partial-item alias without a DOM observation",()=>{
 const f=fixture(),root=dirname(f.journal.directory);
 const provider:CodexProviderConfig={adapter:"chatgpt-web",baseUrl:"browser://private-result33",chatgptWeb:{
   localToolsEnabled:false,threadEnvironmentStatePath:join(root,"environment.json"),brokerSocketPath:join(root,"unused.sock")}};
 f.scope.executionKey=f.record.executionKey=chatGptWebExecutionNamespace(provider)+":"+chatGptTurnExecutionKey(f.input);
 f.scope.traceId=f.record.traceId=chatGptWebTraceId(provider,f.input);
 f.record.nativeSubmissions!.at(-1)!.hostWatch!.traceId=f.scope.traceId;f.slot().hostWatch!.traceId=f.scope.traceId;
 const events:any[]=[{type:"text_delta",text:"Original",phase:"final_answer"}];f.record.rounds[f.scope.roundKey].events=events;
 f.op.nativeResultReady(f.ready());expect(f.record.observation).toBeUndefined();
 const identity=operationDigest(JSON.stringify([f.scope.traceId,f.scope.roundKey])).slice(0,32);
 const item=(buildResponseJSON(events,f.input.modelId,{replayIdentity:identity}).output as any[]).find(v=>v.type==="message");
 const retry=structuredClone(f.input);(retry._rawBody as any).input.push(item);
 restoreChatGptObserverRound(provider,retry);expect(retry._chatgptObserverRoundKey).toBe(f.scope.roundKey);
 const foreign=structuredClone(f.input);(foreign._rawBody as any).input.push({...item,id:"foreign"});
 restoreChatGptObserverRound(provider,foreign);expect(foreign._chatgptObserverRoundKey).toBeUndefined();
});

test("Ready callback rejects inconsistent live feed before durable ACK even ahead of journal flush",()=>{
 const f=fixture(),text=new ChatGptTextFeed();text.push("uncheckpointed foreign bytes");
 expect(()=>acknowledgeNativeResultReady(f.op,text,f.ready())).toThrow("retained");
 expect(f.record.nativeFinal).toBeUndefined();expect(f.op.hasNativeRelease()).toBe(false);
 expect(f.journal.unresolvedOwner(f.record.ownerKey!,"next")).toBeDefined();
 const exact=new ChatGptTextFeed();exact.push("Original");
 acknowledgeNativeResultReady(f.op,exact,f.ready());expect(f.record.nativeFinal?.answer).toBe("Original answer");
});
