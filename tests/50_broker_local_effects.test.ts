import {expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,openSync,closeSync,readFileSync,appendFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {TurnBroker,RemoteTurnBroker,callTurnBroker,type BrokerToolRequest,type BrokerToolResult} from "../src/adapters/chatgpt-web/turn-broker";
import {startChatGptMcpHttpServer} from "../src/adapters/chatgpt-web/mcp-http";
import {OperationJournal,operationDigest} from "../src/adapters/chatgpt-web/operation-journal";

const terminal=(exit:number,output:string):BrokerToolResult=>({content:[{type:"text",text:`Wall time: 0 seconds\nProcess exited with code ${exit}\nOutput:\n${output}`}]});
const running=(id:number):BrokerToolResult=>({content:[{type:"text",text:`Wall time: 0 seconds\nProcess running with session ID ${id}\nOutput:\n`}]});
async function eventually(check:()=>boolean) {
  for(let i=0;i<200&&!check();i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}
async function fixture() {
  const root=mkdtempSync(join(process.env.Q39_TEST_ROOT!,"real-local-effects-"));
  const fd=openSync(root,"r"),socket=`/proc/${process.pid}/fd/${fd}/b.sock`;
  const broker=TurnBroker.forSocket(socket);await broker.listen();
  const environment={cwd:root,roots:[root],writableRoots:[root],sandboxPolicy:{type:"workspaceWrite" as const,writableRoots:[root],networkAccess:false},
    tools:["exec_command","write_stdin","apply_patch","custom_sync"].map(name=>({name,description:"private local protocol owner",parameters:{type:"object"},...(name==="apply_patch"?{freeform:true}:{})}))};
  const token=await broker.register(environment),server=startChatGptMcpHttpServer({brokerSocketPath:socket,port:0});
  const remote=new RemoteTurnBroker(socket),journal=new OperationJournal(root,"tool-operations"),record=()=>journal.read<any>(operationDigest(token));
  let sequence=0,ingress=token,session="";
  const proof:Record<string,string>={};
  const rpc=(body:object,signal?:AbortSignal)=>fetch(server.url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-11-25",...(session?{"mcp-session-id":session}:{})},body:JSON.stringify(body),signal});
  const initialize=async()=>{session="";const response=await rpc({jsonrpc:"2.0",id:++sequence,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"broker-local-effects",version:"1"}}});await response.text();session=response.headers.get("mcp-session-id")!;expect(session).toBeTruthy();};
  await initialize();
  async function step(name:string,args:object,effect:(call:BrokerToolRequest)=>Promise<BrokerToolResult>,lose=false) {
    const id=++sequence,abort=new AbortController();
    const body={jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:{turn_token:ingress,...args}}};
    const response=rpc(body,abort.signal).then(r=>r.text()).catch(error=>{if(abort.signal.aborted)return "aborted";throw error;});
    const nextAbort=new AbortController();
    let calls:BrokerToolRequest[];
    try {calls=await Promise.race([broker.nextToolBatch(token,nextAbort.signal),response.then(value=>{throw Error("request did not dispatch "+value);})]);}
    finally {nextAbort.abort();}
    expect(calls!).toHaveLength(1);const call=calls![0]!;
    const result=await effect(call);
    if(lose){abort.abort();await response;await eventually(()=>record().calls[call.callId].publicDeliveryLost===true);}
    await remote.completeTool(token,call.callId,result);
    const wire=await response;
    if(!lose){expect(wire).not.toContain('"isError":true');}
    proof[call.callId]=operationDigest(JSON.stringify(result));
    await eventually(()=>record().observationState.activeActivityRefs.length===0);
    return {body,call,result,wire,session};
  }
  async function recover() {
    const recovery=await remote.recoverCompletedReceipts(token,proof);
    expect(recovery).toBeDefined();
    expect(recovery!.receipts.map(value=>value.request.callId).sort()).toEqual(Object.keys(proof).sort());
    expect(await remote.resumeAfterReceiptRecovery(token,recovery!.token,proof)).toBe(true);
    ingress=recovery!.token;await initialize();return recovery!;
  }
  const snapshot=(label:string,extra:object)=>{const evidence={boundary:"real loopback HTTP MCP and real local effects; no ChatGPT or Native client",root,label,receipts:record(),...extra};writeFileSync(join(root,"evidence.json"),JSON.stringify(evidence,null,2)+"\n");console.log("BROKER_LOCAL_EVIDENCE "+JSON.stringify({root,label,...extra}));};
  return {root,broker,token,remote,proof,record,rpc,step,recover,snapshot,
    newIntent:async()=>{ingress=await broker.register(environment);return ingress;},
    close:async()=>{await server.close();await broker.close();closeSync(fd);}};
}
async function command(root:string,cmd:string):Promise<BrokerToolResult> {
  const child=Bun.spawn(["bash","-c",cmd],{cwd:root,stdout:"pipe",stderr:"pipe"});
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  return terminal(exit,out+err);
}

test("local HTTP A result recovery permits B once, real apply_patch/custom effects and new intent",async()=>{
  const f=await fixture();
  try {
    const cmd="printf 'A\\n' >> markers.txt";
    const a=await f.step("codex_exec",{cmd},call=>command(f.root,String(call.arguments!.cmd)),true);
    const aBefore=structuredClone(f.record().calls[a.call.callId]);
    const recovery=await f.recover();
    expect(recovery.receipts[0]!.result).toEqual(a.result);
    expect(recovery.receipts[0]!.request.callId).toBe(a.call.callId);
    const b=await f.step("codex_exec",{cmd:"test \"$(cat markers.txt)\" = A && printf 'B\\n' >> markers.txt"},call=>command(f.root,String(call.arguments!.cmd)));
    expect(b.call.callId).not.toBe(a.call.callId);
    expect(f.record().calls[a.call.callId]).toEqual(aBefore);
    const patch="*** Begin Patch\n*** Add File: patched.txt\n+patch-once\n*** End Patch";
    const p=await f.step("codex_apply_patch",{patch},async call=>{
      expect(call.freeform).toBe(true);expect(call.input).toBe(patch);
      const child=Bun.spawn([process.env.BROKER_APPLY_PATCH!,call.input!],{cwd:f.root,stdout:"pipe",stderr:"pipe"});
      const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(exit,err).toBe(0);return {content:[{type:"text",text:out}]};
    },true);
    await f.recover();expect(readFileSync(join(f.root,"patched.txt"),"utf8")).toBe("patch-once\n");
    const c=await f.step("codex_tool_call",{wire_name:"custom_sync",arguments:{value:"custom-once"}},async call=>{
      expect(call.arguments).toEqual({value:"custom-once"});appendFileSync(join(f.root,"custom.txt"),String(call.arguments!.value)+"\n");
      return {content:[{type:"text",text:"custom-once accepted"}]};
    },true);
    const last=await f.recover();expect(last.receipts.find(value=>value.request.callId===p.call.callId)!.result).toEqual(p.result);
    expect(readFileSync(join(f.root,"custom.txt"),"utf8")).toBe("custom-once\n");
    expect(last.receipts.find(value=>value.request.callId===c.call.callId)!.result).toEqual(c.result);
    const newToken=await f.newIntent();
    const response=f.rpc({jsonrpc:"2.0",id:900,method:"tools/call",params:{name:"codex_exec",arguments:{turn_token:newToken,cmd}}}).then(r=>r.text());
    const [again]=await f.broker.nextToolBatch(newToken);expect(again!.arguments).toEqual({cmd});
    await f.remote.completeTool(newToken,again!.callId,await command(f.root,cmd));expect(await response).not.toContain('"isError":true');
    expect(readFileSync(join(f.root,"markers.txt"),"utf8")).toBe("A\nB\nA\n");
    f.snapshot("A-B-patch-custom-new-intent",{markers:readFileSync(join(f.root,"markers.txt"),"utf8"),patch:readFileSync(join(f.root,"patched.txt"),"utf8"),custom:readFileSync(join(f.root,"custom.txt"),"utf8"),newIntentCallId:again!.callId});
  } finally {await f.close();}
},15000);

test("local HTTP non-idempotent stdin recovers original result, short empty poll then EOF preserves exit 7",async()=>{
  const f=await fixture();let child:ReturnType<typeof Bun.spawn>|undefined;
  try {
    const id=501;
    await f.step("codex_exec",{cmd:"interactive-line-writer"},async()=>{
      child=Bun.spawn(["bash","-c","while IFS= read -r line; do printf '%s\\n' \"$line\" >> stdin.txt; done; exit 7"],{cwd:f.root,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
      return running(id);
    });
    const stdin=await f.step("codex_write_stdin",{session_id:id,chars:"one-line\n"},async call=>{
      (child!.stdin as any).write(call.arguments!.chars);await eventually(()=>{try{return readFileSync(join(f.root,"stdin.txt"),"utf8")==="one-line\n";}catch{return false;}});
      return running(id);
    },true);
    const recovery=await f.recover();expect(recovery.receipts.find(value=>value.request.callId===stdin.call.callId)!.result).toEqual(stdin.result);
    const rejected=await f.rpc({jsonrpc:"2.0",id:800,method:"tools/call",params:{name:"codex_write_stdin",arguments:{turn_token:recovery.token,session_id:id,chars:"one-line\n",max_output_tokens:111}}});
    expect(await rejected.text()).toContain("already accepted");
    await f.step("codex_write_stdin",{session_id:id,chars:"",yield_time_ms:250},async()=>{expect(child!.exitCode).toBeNull();await Bun.sleep(250);return running(id);});
    const eof=await f.step("codex_write_stdin",{session_id:id,chars:"\u0004"},async()=>{(child!.stdin as any).end();return terminal(await child!.exited,"");});
    expect(eof.result).toEqual(terminal(7,""));expect(readFileSync(join(f.root,"stdin.txt"),"utf8")).toBe("one-line\n");
    f.snapshot("stdin-once-poll-EOF-exit7",{stdin:readFileSync(join(f.root,"stdin.txt"),"utf8"),sessionId:id,exit:7});
  }finally{if(child&&child.exitCode===null){(child.stdin as any).end();await child.exited;}await f.close();}
},15000);

test("local HTTP 100-second process retains handle through lost running receipt and completes without restart",async()=>{
  const f=await fixture();let child:ReturnType<typeof Bun.spawn>|undefined;
  try {
    const started=Date.now(),id=502;
    const launch=await f.step("codex_exec",{cmd:"printf 'start\\n' >> long.txt; sleep 100; printf 'end\\n' >> long.txt; exit 7"},async call=>{
      child=Bun.spawn(["bash","-c",String(call.arguments!.cmd)],{cwd:f.root,stdout:"pipe",stderr:"pipe"});
      await eventually(()=>{try{return readFileSync(join(f.root,"long.txt"),"utf8")==="start\n";}catch{return false;}});return running(id);
    },true);
    const recovery=await f.recover();expect(recovery.receipts[0]!.request.callId).toBe(launch.call.callId);
    await f.step("codex_write_stdin",{session_id:id,chars:"",yield_time_ms:250},async()=>{expect(child!.exitCode).toBeNull();await Bun.sleep(250);return running(id);});
    const exit=await child!.exited;
    const final=await f.step("codex_write_stdin",{session_id:id,chars:"",yield_time_ms:250},async()=>terminal(exit,""));
    expect(exit).toBe(7);expect(final.result).toEqual(terminal(7,""));
    expect(readFileSync(join(f.root,"long.txt"),"utf8")).toBe("start\nend\n");
    expect(Object.values<any>(f.record().calls).filter(call=>call.request.wireName==="exec_command")).toHaveLength(1);
    f.snapshot("100-second-running-ACK-loss",{sessionId:id,exit,elapsedMs:Date.now()-started,markers:readFileSync(join(f.root,"long.txt"),"utf8")});
  }finally{if(child&&child.exitCode===null)await child.exited;await f.close();}
},115000);

test("local HTTP mixed owner batch restores completed, running and nonzero receipts independently",async()=>{
  const f=await fixture();let child:ReturnType<typeof Bun.spawn>|undefined;
  try {
    const abort=new AbortController();
    const inputs=[{id:910,cmd:"printf 'completed-once\\n' >> mixed.txt"},{id:911,cmd:"printf 'running-once\\n' >> mixed.txt; sleep 1; exit 7"},{id:912,cmd:"printf 'failed-once\\n' >> mixed.txt; exit 9"}];
    const responses=inputs.map((input,index)=>f.rpc({jsonrpc:"2.0",id:input.id,method:"tools/call",params:{name:"codex_exec",arguments:{turn_token:f.token,cmd:input.cmd}}},index===0?abort.signal:undefined).then(r=>r.text()).catch(error=>{if(index===0&&abort.signal.aborted)return "aborted";throw error;}));
    await eventually(()=>Object.keys(f.record().calls).length===3);
    const calls=await f.broker.nextToolBatch(f.token);expect(calls).toHaveLength(3);
    for(const call of calls){
      const cmd=String(call.arguments!.cmd);let result:BrokerToolResult;
      if(cmd===inputs[1]!.cmd){child=Bun.spawn(["bash","-c",cmd],{cwd:f.root,stdout:"pipe",stderr:"pipe"});result=running(503);}
      else result=await command(f.root,cmd);
      if(cmd===inputs[0]!.cmd){abort.abort();await responses[0];await eventually(()=>f.record().calls[call.callId].publicDeliveryLost===true);}
      await f.remote.completeTool(f.token,call.callId,result);f.proof[call.callId]=operationDigest(JSON.stringify(result));
    }
    await Promise.all(responses);await eventually(()=>f.record().observationState.activeActivityRefs.length===0);
    const accepted=structuredClone(f.record().calls),recovery=await f.recover();expect(recovery.receipts).toHaveLength(3);
    expect(f.record().calls).toEqual(accepted);
    await f.step("codex_write_stdin",{session_id:503,chars:"",yield_time_ms:250},async()=>{await Bun.sleep(250);return running(503);});
    const exit=await child!.exited;expect(exit).toBe(7);
    await f.step("codex_write_stdin",{session_id:503,chars:"",yield_time_ms:250},async()=>terminal(exit,""));
    const markers=readFileSync(join(f.root,"mixed.txt"),"utf8").trim().split("\n").sort();
    expect(markers).toEqual(["completed-once","failed-once","running-once"]);
    f.snapshot("mixed-completed-running-nonzero",{markers,exit,originalCalls:calls.map(call=>call.callId)});
  }finally{if(child&&child.exitCode===null)await child.exited;await f.close();}
},15000);
