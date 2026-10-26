const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// Exercise Host lease validation only; this local process creates no Electron window.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'electron' ? {} : originalLoad.call(this, id, ...args); };
const { BrowserHost } = require('../electron/browser-host.cjs');
Module._load = originalLoad;
function fixture() {
  const id=randomUUID(), pair=[`group:user:${id}`,`group:assistant:${id}`];
  const url='https://chatgpt.com/c/6ade4bd9-0cc8-83ea-94ae-4c55112ec5a8';
  const native={version:1,sendId:randomUUID(),revision:3,phase:'accepted',initialTurnIdentities:[],post:{userMessageId:id,payloadSha256:'a'.repeat(64),action:{presence:'value',value:'next'},conversationId:{presence:'absent'},parentMessageId:{presence:'value',value:'client-created-root'},observedAt:1000},dom:{acceptedUserIdentity:pair[0],assistantIdentity:pair[1],acceptedTurnIdentities:pair,proof:'same-bound-assistant-completed',observedAt:1001}};
  const c={version:2,identity:{operationId:'op',executionKey:'key',roundKey:'round',threadId:'thread',turnId:'turn'},traceId:'native_trace',modelId:'gpt-5.6-sol',accountId:'account2',appName:'app',host:{pid:process.pid,instanceId:'h'.repeat(32),profile:'production',partition:'persist:codex-web-gpt-chatgpt'},lease:{helperPid:process.pid+1,surfaceId:'s'.repeat(32),targetId:'original-target'},conversation:{key:'conversation',url,claim:'claim'},submission:{native,initialTurnIdentities:[],acceptedUserIdentity:pair[0],assistantIdentity:pair[1],acceptedTurnIdentities:pair}};
  const tab={traceId:c.traceId,status:'running',interactionMode:'automatic',surfaceId:c.lease.surfaceId,helperPid:c.lease.helperPid,conversationKey:c.conversation.key,view:{webContents:{isDestroyed:()=>false,getOrCreateDevToolsTargetId:()=>c.lease.targetId,getURL:()=>url}}};
  const host=Object.assign(Object.create(BrowserHost.prototype),{profile:c.host.profile,partition:c.host.partition,observationInstanceId:c.host.instanceId,turnTabs:new Map([['turn',tab]]),userCancelledTurnOwners:new Set()});
  return {host,c,tab};
}
test('native checkpoint registers exact original host/lease and cannot rotate the accepted digest',()=>{
  const {host,c,tab}=fixture();assert.deepEqual(host.observeTurn(c.traceId,c.lease.helperPid,c.lease.surfaceId,c,true),{ok:true});
  assert.deepEqual(host.observeTurn(c.traceId,c.lease.helperPid+100,c.lease.surfaceId,c),{ok:true});
  assert.equal(tab.helperPid,c.lease.helperPid);
  const foreign=structuredClone(c);foreign.submission.native.sendId=randomUUID();
  assert.throws(()=>host.observeTurn(c.traceId,c.lease.helperPid,c.lease.surfaceId,foreign,true));
});
for(const mutation of [c=>c.submission.receipt='[codex-submission:legacy]',c=>c.toolChannel={tokenHash:'a'.repeat(64)},c=>c.host.instanceId='foreign',c=>c.submission.native.post.userMessageId=randomUUID(),c=>c.submission.native.dom.proof='HTTP200']) {
  test('native checkpoint rejects an incompatible or foreign proof',()=>{const {host,c}=fixture();mutation(c);assert.throws(()=>host.observeTurn(c.traceId,c.lease.helperPid,c.lease.surfaceId,c,true));});
}
test('legacy checkpoint remains separately readable without native identity adoption',()=>{
  const {host,c}=fixture();c.version=1;delete c.submission.native;c.submission.receipt=`[codex-submission:${randomUUID()}]`;
  assert.deepEqual(host.observeTurn(c.traceId,c.lease.helperPid,c.lease.surfaceId,c,true),{ok:true});assert.equal(c.submission.native,undefined);
});
