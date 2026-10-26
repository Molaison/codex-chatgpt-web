const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
// Exercise Host lease validation only; this local process creates no Electron window.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'electron' ? {} : originalLoad.call(this, id, ...args); };
const { BrowserHost } = require('../electron/browser-host.cjs');
Module._load = originalLoad;
async function fixture(nativeWatch = true) {
  const id=randomUUID(), pair=[`group:user:${id}`,`group:assistant:${id}`];
  const url='https://chatgpt.com/c/6ade4bd9-0cc8-83ea-94ae-4c55112ec5a8';
  const native={version:1,sendId:randomUUID(),revision:4,phase:'accepted',initialTurnIdentities:[],post:{userMessageId:id,payloadSha256:'a'.repeat(64),action:{presence:'value',value:'next'},conversationId:{presence:'absent'},parentMessageId:{presence:'value',value:'client-created-root'},observedAt:1000},dom:{acceptedUserIdentity:pair[0],assistantIdentity:pair[1],acceptedTurnIdentities:pair,proof:'same-bound-assistant-completed',observedAt:1001}};
  const c={version:2,identity:{operationId:'op',executionKey:'key',roundKey:'round',threadId:'thread',turnId:'turn'},traceId:'native_trace',modelId:'gpt-5.6-sol',accountId:'account2',appName:'app',host:{pid:process.pid,instanceId:'h'.repeat(32),profile:'production',partition:'persist:codex-web-gpt-chatgpt'},lease:{helperPid:process.pid+1,surfaceId:'s'.repeat(32),targetId:'original-target'},conversation:{key:'conversation',url,claim:'claim'},submission:{native,initialTurnIdentities:[],acceptedUserIdentity:pair[0],assistantIdentity:pair[1],acceptedTurnIdentities:pair}};
  const contents=Object.assign(new EventEmitter(), {isDestroyed:()=>false,getOrCreateDevToolsTargetId:()=>c.lease.targetId,getURL:()=>url});
  const dbg=Object.assign(new EventEmitter(), {attached:false,isAttached(){return this.attached;},attach(){this.attached=true;},
    async sendCommand(method){return method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',loaderId:'document',url}}}:{};}});
  contents.debugger=dbg;
  const tab={id:'turn',traceId:c.traceId,status:'running',interactionMode:'automatic',bootstrapReady:true,leaseFencing:true,
    surfaceId:c.lease.surfaceId,helperPid:c.lease.helperPid,conversationKey:c.conversation.key,view:{webContents:contents}};
  const host=Object.assign(Object.create(BrowserHost.prototype),{profile:c.host.profile,partition:c.host.partition,observationInstanceId:c.host.instanceId,turnTabs:new Map([['turn',tab]]),userCancelledTurnOwners:new Set()});
  if(nativeWatch){
    const request={traceId:c.traceId,helperPid:c.lease.helperPid,surfaceId:c.lease.surfaceId,host:c.host,targetId:c.lease.targetId,sendId:native.sendId};
    await host.nativeSubmissionWatch({...request,action:'start',scope:{...c.identity,traceId:c.traceId},slot:{roundKey:c.identity.roundKey,stage:{kind:'final'}}});
    const raw=JSON.stringify({action:'next',parent_message_id:'client-created-root',conversation_id:url.split('/').at(-1),
      messages:[{id,author:{role:'user'},content:{parts:['original local fixture question']}}]});
    dbg.emit('message',{},'Network.requestWillBeSent',{requestId:randomUUID(),frameId:'main',loaderId:'document',request:{method:'POST',url:'https://chatgpt.com/backend-api/conversation',postData:raw}});
    const watched=await host.nativeSubmissionWatch({...request,action:'read'});
    const snapshot=watched;
    assert.ok(snapshot,'actual Host watch must supply the original snapshot');
    native.post=snapshot.identities[0];native.binding=snapshot.binding;native.hostWatch=snapshot;native.dom.observedAt=Date.now();
  }
  return {host,c,tab};
}
test('native checkpoint registers exact original host/lease and cannot rotate the accepted digest',async()=>{
  const {host,c,tab}=await fixture();assert.deepEqual(host.observeTurn(c.traceId,c.lease.helperPid,c.lease.surfaceId,c,true),{ok:true});
  assert.deepEqual(host.observeTurn(c.traceId,c.lease.helperPid+100,c.lease.surfaceId,c),{ok:true});
  assert.equal(tab.helperPid,c.lease.helperPid);
  const foreign=structuredClone(c);foreign.submission.native.sendId=randomUUID();
  assert.throws(()=>host.observeTurn(c.traceId,c.lease.helperPid,c.lease.surfaceId,foreign,true));
});
for(const mutation of [c=>c.submission.receipt='[codex-submission:legacy]',c=>c.toolChannel={tokenHash:'a'.repeat(64)},c=>c.host.instanceId='foreign',c=>c.submission.native.post.userMessageId=randomUUID(),c=>c.submission.native.dom.proof='HTTP200']) {
  test('native checkpoint rejects an incompatible or foreign proof',async()=>{const {host,c}=await fixture();mutation(c);assert.throws(()=>host.observeTurn(c.traceId,c.lease.helperPid,c.lease.surfaceId,c,true));});
}
test('legacy checkpoint remains separately readable without native identity adoption',async()=>{
  const {host,c}=await fixture(false);c.version=1;delete c.submission.native;c.submission.receipt=`[codex-submission:${randomUUID()}]`;
  assert.deepEqual(host.observeTurn(c.traceId,c.lease.helperPid,c.lease.surfaceId,c,true),{ok:true});assert.equal(c.submission.native,undefined);
});
