import { tmpdir } from "node:os";
// Real local HTTP/SDK/broker boundary. Native completion values are fixtures, not ChatGPT E2E.
import {expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,openSync,closeSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {TurnBroker,type BrokerToolResult} from "../src/adapters/chatgpt-web/turn-broker";
import {startChatGptMcpHttpServer} from "../src/adapters/chatgpt-web/mcp-http";
import {McpAdmissionBook} from "../src/adapters/chatgpt-web/mcp-admission";
import {OperationJournal,operationDigest} from "../src/adapters/chatgpt-web/operation-journal";

test("public MCP lost A receipt resumes distinct B, patch/custom shape and rejects unauthorized tool without dispatch",async()=>{
  mkdirSync((process.env.Q39_TEST_ROOT ?? tmpdir()),{recursive:true});const root=mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()),"public-"));
  const fd=openSync(root,"r"),socket=`/proc/${process.pid}/fd/${fd}/b.sock`,broker=TurnBroker.forSocket(socket);await broker.listen();
  const token=await broker.register({cwd:root,roots:[root],writableRoots:[root],sandboxPolicy:{type:"workspaceWrite",writableRoots:[root],networkAccess:false},
    tools:[{name:"exec_command",description:"fixture",parameters:{type:"object"}},
      {name:"apply_patch",description:"fixture",parameters:{type:"object"},freeform:true},
      {name:"custom_sync",description:"fixture",parameters:{type:"object",properties:{value:{type:"string"}}}}]});
  const key=join(root,"key");writeFileSync(key,"core49-isolated-release-key-only",{mode:0o600});
  const server=startChatGptMcpHttpServer({brokerSocketPath:socket,port:0,releaseControl:{tokenFile:key,stateFile:join(root,"fence")}});
  const sessions:string[]=[];
  const journal=new OperationJournal(root,"tool-operations"),record=()=>journal.read<any>(operationDigest(token));
  let seq=0;
  const rpc=(body:object,session?:string,signal?:AbortSignal)=>fetch(server.url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-11-25",...(session?{"mcp-session-id":session}:{})},body:JSON.stringify(body),signal});
  const initialize=async()=>{const r=await rpc({jsonrpc:"2.0",id:++seq,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"core49",version:"1"}}});await r.text();const session=r.headers.get("mcp-session-id")!;sessions.push(session);return session;};
  const result:BrokerToolResult={content:[{type:"text",text:"Wall time: 0.001 seconds\nProcess exited with code 7\nOutput:\nA"}]};
  try{
    const old=await initialize(),abort=new AbortController();
    const a=rpc({jsonrpc:"2.0",id:++seq,method:"tools/call",params:{name:"codex_exec",arguments:{turn_token:token,cmd:"A"}}},old,abort.signal).then(r=>r.text()).catch(()=>"aborted");
    const [first]=await broker.nextToolBatch(token);abort.abort();await a;
    for(let i=0;i<100&&!record().calls[first!.callId].publicDeliveryLost;i++)await Bun.sleep(10);
    expect(record().calls[first!.callId].publicDeliveryLost).toBe(true);broker.completeTool(token,first!.callId,result);
    for(let i=0;i<100&&record().observationState.activeActivityRefs.length;i++)await Bun.sleep(10);
    const proof={[first!.callId]:operationDigest(JSON.stringify(result))};const recovery=broker.recoverCompletedReceipts(token,proof)!;expect(recovery).toBeDefined();
    expect(recovery.receipts[0]!.result).toEqual(result);expect(broker.resumeAfterReceiptRecovery(token,recovery.token,proof)).toBe(true);
    const session=await initialize();
    for(const [name,args,wire,expected] of [
      ["codex_exec",{cmd:"B"},"exec_command",{cmd:"B"}],
      ["codex_apply_patch",{patch:"*** Begin Patch\n*** End Patch"},"apply_patch","*** Begin Patch\n*** End Patch"],
      ["codex_tool_call",{wire_name:"custom_sync",arguments:{value:"C"}},"custom_sync",{value:"C"}],
    ] as const){
      const response=rpc({jsonrpc:"2.0",id:++seq,method:"tools/call",params:{name,arguments:{turn_token:recovery.token,...args}}},session).then(r=>r.text());
      const [call]=await broker.nextToolBatch(token);expect(call!.wireName).toBe(wire);
      expect(call!.freeform?call!.input:call!.arguments).toEqual(expected);
      broker.completeTool(token,call!.callId,wire==="exec_command"?result:{content:[{type:"text",text:"completed fixture"}]});
      expect(await response).not.toContain('"isError":true');
    }
    const before=Object.keys(record().calls).length;
    const denied=await rpc({jsonrpc:"2.0",id:++seq,method:"tools/call",params:{name:"codex_tool_call",arguments:{turn_token:recovery.token,wire_name:"unlisted",arguments:{}}}},session);
    expect(await denied.text()).toContain('"isError":true');expect(Object.keys(record().calls)).toHaveLength(before);expect(before).toBe(4);
  }finally{
    for(const session of sessions)await fetch(server.url,{method:"DELETE",headers:{"mcp-session-id":session,"MCP-Protocol-Version":"2025-11-25",accept:"application/json, text/event-stream"}});
    broker.revoke(token);
    const drain=await fetch(server.url.origin+"/admin/release/drain",{method:"POST",headers:{authorization:"Bearer core49-isolated-release-key-only"}});
    expect((await drain.json()).safe_to_stop).toBe(true);
    await server.close();await broker.close();closeSync(fd);rmSync(root,{recursive:true,force:true});
  }
},15000);

test("local non-dispatch evidence never clears a completed or transport-unknown receipt",async()=>{
  const book=new McpAdmissionBook();
  const message=(id:number)=>({jsonrpc:"2.0",id,method:"tools/call",params:{name:"codex_tool_call",arguments:{turn_token:"fixture",wire_name:"custom"}}});
  const error=(id:number)=>Response.json({jsonrpc:"2.0",id,result:{isError:true,content:[{type:"text",text:"rejected"}]}});
  book.begin(message(1));await book.complete(message(1),error(1));expect(book.uncertain).toBe(1);
  expect(book.noteLocalNotDispatched(1)).toBe(false);expect(book.uncertain).toBe(1);
  book.begin(message(2));expect(book.noteLocalNotDispatched(2)).toBe(true);await book.complete(message(2),error(2));
  expect(book.uncertain).toBe(1);expect(book.canClose).toBe(false);
  book.begin(message(3));expect(book.noteLocalNotDispatched(3)).toBe(true);await book.complete(message(3),error(3),true);
  expect(book.uncertain).toBe(2);
});
