import { tmpdir } from "node:os";
import {expect,test} from "bun:test";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {TurnBroker} from "../src/adapters/chatgpt-web/turn-broker";
import {startChatGptMcpHttpServer} from "../src/adapters/chatgpt-web/mcp-http";

const rootPath=()=>{mkdirSync((process.env.Q39_TEST_ROOT ?? tmpdir()),{recursive:true});return mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()),"release-"));};
test("broker and MCP replacement retain durable unknown; zero process-local counters cannot seal or close",async()=>{
  const root=rootPath();
  const brokerModule=new URL("../src/adapters/chatgpt-web/turn-broker.ts",import.meta.url).href;
  const mcpModule=new URL("../src/adapters/chatgpt-web/mcp-http.ts",import.meta.url).href;
  const script=`import {TurnBroker,callTurnBroker} from ${JSON.stringify(brokerModule)};
    import {startChatGptMcpHttpServer} from ${JSON.stringify(mcpModule)};
    import {openSync,writeFileSync} from 'node:fs';
    const root=${JSON.stringify(root)}, fd=openSync(root,'r'), socket='/proc/'+process.pid+'/fd/'+fd+'/b.sock';
    let broker=TurnBroker.forSocket(socket);await broker.listen();
    const token=await broker.register({cwd:root,roots:[root],writableRoots:[],tools:[],sandboxPolicy:{type:'readOnly',networkAccess:false}});
    const activityId='activity_durable_unknown_test_01';
    const {bindingId}=await callTurnBroker(socket,{method:'claim',token,activityId});
    const pending=callTurnBroker(socket,{method:'invoke',bindingId,invocationId:'unknown-original',wireName:'exec_command',arguments:{cmd:'synthetic unknown'}},5000).catch(()=>undefined);
    await broker.nextToolBatch(token);
    await callTurnBroker(socket,{method:'activity_complete',token,activityId});
    await broker.close();await pending;broker=TurnBroker.forSocket(socket);await broker.listen();
    const key=root+'/key';writeFileSync(key,'durable-release-isolated-key-only',{mode:0o600});
    const server=startChatGptMcpHttpServer({brokerSocketPath:socket,port:0,releaseControl:{tokenFile:key,stateFile:root+'/fence'}});
    const control=async(action)=>{const r=await fetch(server.url.origin+'/admin/release/'+action,{method:'POST',headers:{authorization:'Bearer durable-release-isolated-key-only'}});return {status:r.status,body:await r.json()};};
    const drain=await control('drain'),seal=await control('seal');
    let closeBlocked=false;try{await server.close();}catch{closeBlocked=true;}
    const after=await callTurnBroker(socket,{method:'owner_invocation_receipt',bindingId,invocationId:'unknown-original',wireName:'exec_command',arguments:{cmd:'synthetic unknown'}});
    await broker.close();const unavailable=await control('seal');
    console.log('DURABLE_RESULT '+JSON.stringify({drain,seal,closeBlocked,afterState:after.state,unavailable}));
    process.exit(0);`;
  const child=Bun.spawn([process.execPath,...(process.env.BROKER_JOURNAL_PRELOAD ? ["--preload",process.env.BROKER_JOURNAL_PRELOAD] : []),"-e",script],{stdout:"pipe",stderr:"pipe"});
  try {
    const [output,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(code,errors).toBe(0);
    const result=JSON.parse(output.split("\n").find(line=>line.startsWith("DURABLE_RESULT "))!.slice(15));
    expect(result.drain.body.active_requests).toBe(0);expect(result.drain.body.open_sessions).toBe(0);
    expect(result.drain.body.durable_unknown_calls).toBe(1);expect(result.drain.body.safe_to_stop).toBe(false);
    expect(result.seal.status).toBe(409);expect(result.closeBlocked).toBe(true);expect(result.afterState).toBe("unknown");
    expect(result.unavailable.status).toBe(409);expect(result.unavailable.body.durable_inventory_errors).toBe(1);
  } finally {if(child.exitCode===null){child.kill();await child.exited;}rmSync(root,{recursive:true,force:true});}
},15000);

test("empty live broker permits drain/seal; malformed inventory fails closed",async()=>{
  const root=rootPath();
  // Use a short socket alias because the managed test root exceeds Unix socket limits.
  const {openSync,closeSync}=await import("node:fs");const fd=openSync(root,"r"),shortSocket=`/proc/${process.pid}/fd/${fd}/b.sock`;
  const broker=TurnBroker.forSocket(shortSocket);await broker.listen();
  const key=join(root,"key");writeFileSync(key,"durable-release-isolated-key-only",{mode:0o600});
  const server=startChatGptMcpHttpServer({brokerSocketPath:shortSocket,port:0,releaseControl:{tokenFile:key,stateFile:join(root,"fence")}});
  const control=(action:string)=>fetch(server.url.origin+"/admin/release/"+action,{method:"POST",headers:{authorization:"Bearer durable-release-isolated-key-only"}});
  try {
    expect((await control("drain")).status).toBe(200);expect((await control("seal")).status).toBe(200);
    await server.close();
    const journal=join(root,"tool-operations");mkdirSync(journal,{recursive:true});writeFileSync(join(journal,"corrupt.json"),"corrupt fixture");
    expect(broker.releaseStatus().durable_inventory_errors).toBe(1);
    expect(broker.releaseStatus().durable_unknown_calls).toBe(0);
  } finally {await broker.close();closeSync(fd);rmSync(root,{recursive:true,force:true});}
},10000);
