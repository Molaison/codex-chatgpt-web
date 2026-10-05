import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaPool, type QaPoolConfig } from "../src/qa-pool";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } from "../src/adapters/chatgpt-web/qa-conversation-key";
import { poolSessionHash } from "../src/paper-registry";

test("paper protocol persists reservations and saved identity, strips repeats, serializes turns and refuses unsafe migration", async () => {
  const root = mkdtempSync(join(tmpdir(),"paper-registry-"));
  const key = "a".repeat(32), projectId = "g-p-"+"a".repeat(32), accountId="a";
  writeFileSync(join(root,"key"),key);
  const store = new ChatGptConversationStore(join(root,"conversations"),accountId);
  const calls: any[]=[];
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let hold = false, incomplete = false;
  const backend = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const body = await request.json() as any; calls.push(body);
    const thread=JSON.parse(body.client_metadata["x-codex-turn-metadata"]).thread_id;
    const nativeKey=chatGptQuestionAnswerKey(thread,chatGptQuestionAnswerNamespace(accountId));
    if (!store.lookup(nativeKey)) store.bind(nativeKey,store.reserve(nativeKey),`https://chatgpt.com/g/${projectId}/c/paper-${calls.length}`);
    const completed = new TextEncoder().encode('data: '+JSON.stringify({type:"response.completed",response:{id:"response-"+calls.length,status:"completed",output:[]}})+'\n\n');
    return new Response(new ReadableStream({start(controller) {
      streamController=controller;
      controller.enqueue(new TextEncoder().encode(": opened\n\n"));
      if (!hold) { if (!incomplete) controller.enqueue(completed); controller.close(); }
    }}),{headers:{"content-type":"text/event-stream"}});
  }});
  const config:QaPoolConfig={host:"127.0.0.1",port:0,databasePath:join(root,"sessions.sqlite"),clients:[{id:"cpr",keyFile:join(root,"key")}],
    accounts:[{id:accountId,origin:backend.url.origin,models:["standard"],sessionModes:true,conversationStoreDirectory:join(root,"conversations")}],
    projectRoutes:[{name:"papers",sessionNamespace:"papers",accountId,projectId}]};
  let pool=createQaPool(config);
  const request=(metadata:object,input:unknown="paper registry lookup",stream=false) => pool.fetch(new Request("http://pool/project/papers/v1/responses",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model:"standard",input,stream,client_metadata:{"x-codex-turn-metadata":JSON.stringify(metadata)}})}));
  const resolve=async(id:string,extra:object={}) => {
    const response=await request({paper_id:id,paper_operation:"resolve",...extra});
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("application/json");
    return JSON.parse((await response.json() as any).output[0].content[0].text);
  };
  const pdf=Buffer.from("%PDF-1.4\nregistry test PDF\n%%EOF");
  const sha=createHash("sha256").update(pdf).digest("hex");
  const input=[{role:"user",content:[{type:"input_file",filename:"paper.pdf",file_data:"data:application/pdf;base64,"+pdf.toString("base64")},{type:"input_text",text:"new question"}]}];
  try {
    expect((await request({thread_id:"anonymous"},"question")).status).toBe(400);
    const id="doi:10.1234/test";
    const reservations=await Promise.all([resolve(id),resolve(id)]);
    expect(reservations.map(r=>r.status).sort()).toEqual(["missing","pending"]);
    const first=reservations.find(r=>r.status==="missing");
    const sse=await request({paper_id:id,paper_operation:"resolve",paper_upload_token:first.upload_token},"paper registry lookup",true);
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    const events=(await sse.text()).split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6)));
    expect(events.map(event=>event.type)).toEqual(["response.created","response.in_progress","response.output_item.added","response.content_part.added","response.output_text.delta","response.output_text.done","response.content_part.done","response.output_item.done","response.completed"]);
    expect(events.map(event=>event.sequence_number)).toEqual([0,1,2,3,4,5,6,7,8]);
    expect(JSON.parse(events[4].delta)).toEqual(first);
    expect(events[8].response.status).toBe("completed");
    expect(JSON.parse(events[8].response.output[0].content[0].text)).toEqual(first);
    expect(calls).toHaveLength(0);
    expect(await resolve("doi:https://doi.org/10.1234%2FTEST",{paper_upload_token:first.upload_token})).toEqual(first);
    pool.close();pool=createQaPool(config);
    expect(await resolve(id,{paper_upload_token:first.upload_token})).toEqual(first);
    const meta={paper_id:id,paper_operation:"chat",paper_upload_token:first.upload_token,paper_pdf_sha256:sha};
    expect((await request({...meta,paper_pdf_sha256:"0".repeat(64)},input)).status).toBe(400);
    expect(calls).toHaveLength(0);
    hold=true;
    const uploading=await request(meta,input);
    expect((await request(meta,input)).status).toBe(409);
    expect((await resolve(id,{paper_upload_token:first.upload_token})).status).toBe("pending");
    streamController!.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:"response.completed",response:{id:"response-1",status:"completed",output:[]}})+'\n\n'));
    streamController!.close(); await uploading.text(); hold=false;
    const ready=await resolve(id);
    expect(ready.status).toBe("ready");expect(ready.upload_required).toBe(false);expect(ready.conversation_url).toBe(`https://chatgpt.com/g/${projectId}/c/paper-1`);
    const hashAlias=await resolve("sha256:"+sha);
    expect(hashAlias.paper_id).toBe("sha256:"+sha);expect(hashAlias.thread_id).toBe(ready.thread_id);expect(hashAlias.conversation_url).toBe(ready.conversation_url);
    const newDoi=await resolve("doi:10.1234/alias-doi");
    const doiAlias=await resolve("doi:10.1234/alias-doi",{paper_upload_token:newDoi.upload_token,paper_pdf_sha256:sha});
    expect(doiAlias.paper_id).toBe("doi:10.1234/alias-doi");expect(doiAlias.thread_id).toBe(ready.thread_id);expect(doiAlias.status).toBe("ready");
    pool.close();pool=createQaPool(config);
    expect((await resolve("sha256:"+sha)).thread_id).toBe(ready.thread_id);
    const repeat=await request({paper_id:"sha256:"+sha,paper_operation:"chat",thread_id:"another-device"},[{role:"user",content:"old"},{role:"assistant",content:"old answer"},...input]);
    await repeat.text();
    expect(calls[1].input).toHaveLength(1);expect(calls[1].input[0].content).toEqual([{type:"input_text",text:"new question"}]);
    expect(JSON.parse(calls[1].client_metadata["x-codex-turn-metadata"]).thread_id).toBe(JSON.parse(calls[0].client_metadata["x-codex-turn-metadata"]).thread_id);
    const before=calls.length;
    expect((await request({paper_id:"doi:10.1234/legacy-missing",paper_operation:"resolve",paper_legacy_thread_id:"old",paper_legacy_uploaded:true})).status).toBe(409);
    const db=new Database(config.databasePath);
    expect(db.query("SELECT * FROM papers WHERE paper_id='doi:10.1234/legacy-missing'").get()).toBeNull();
    const legacy="legacy-known",hash=poolSessionHash(["cpr","papers"],legacy);
    db.query("INSERT INTO sessions(session_hash,account_id,created_at,project_id,project_name) VALUES(?,?,?,?,?)").run(hash,accountId,new Date().toISOString(),projectId,"papers");
    const nativeKey=chatGptQuestionAnswerKey("qa-pool-"+hash,chatGptQuestionAnswerNamespace(accountId));
    const url=`https://chatgpt.com/g/${projectId}/c/legacy-kept`;
    store.bind(nativeKey,store.reserve(nativeKey),url);
    const legacySha="b".repeat(64);
    expect((await resolve("sha256:"+legacySha,{paper_legacy_thread_id:legacy,paper_legacy_uploaded:true})).conversation_url).toBe(url);
    const laterDoi=await resolve("doi:10.1234/later-doi");
    const reverseAlias=await resolve("doi:10.1234/later-doi",{paper_pdf_sha256:legacySha,paper_upload_token:laterDoi.upload_token});
    expect(reverseAlias.paper_id).toBe("doi:10.1234/later-doi");expect(reverseAlias.thread_id).toBe(legacy);expect(reverseAlias.conversation_url).toBe(url);
    expect((await resolve("doi:10.1234/later-doi")).thread_id).toBe(legacy);
    expect(calls).toHaveLength(before);
    const exp=await resolve("doi:10.1234/expired");db.exec("UPDATE papers SET expires_at=0 WHERE paper_id='doi:10.1234/expired'");
    expect((await resolve("doi:10.1234/expired")).upload_token).not.toBe(exp.upload_token);
    const brokenPdf=Buffer.from("%PDF-1.4\nbroken other paper\n%%EOF"),brokenSha=createHash("sha256").update(brokenPdf).digest("hex");
    const brokenInput=[{role:"user",content:[{type:"input_text",text:"new"},{type:"input_file",file_data:"data:application/pdf;base64,"+brokenPdf.toString("base64")}]}];
    const interrupted=await resolve("sha256:"+brokenSha);incomplete=true;
    await (await request({paper_id:"sha256:"+brokenSha,paper_operation:"chat",paper_upload_token:interrupted.upload_token,paper_pdf_sha256:brokenSha},brokenInput)).text();
    expect((await resolve("sha256:"+brokenSha)).status).toBe("uncertain");
    pool.close();pool=createQaPool(config);expect((await resolve("sha256:"+brokenSha)).upload_required).toBe(false);
    expect((await request({paper_id:"doi:10.1234/uncertain-hash",paper_operation:"resolve",paper_pdf_sha256:brokenSha})).status).toBe(409);
    rmSync(store.directory,{recursive:true});
    expect((await request({paper_id:id,paper_operation:"chat"},"continue")).status).toBe(409);
    expect((await request({paper_id:id,paper_operation:"resolve"})).status).toBe(409);
    expect(calls).toHaveLength(before+1);
    expect((db.query("SELECT count(*) n FROM paper_events WHERE event='pre_upload_rejected' AND detail='paper_pdf_sha256_mismatch'").get() as any).n).toBe(1);
    db.close();
  } finally {pool.close();backend.stop(true);rmSync(root,{recursive:true,force:true});}
});

test("a confirmed pre-send attachment failure keeps the reservation retryable while ambiguous failures stay uncertain", async () => {
  const root=mkdtempSync(join(tmpdir(),"paper-presend-"));
  const key="b".repeat(32),projectId="g-p-"+"b".repeat(32),accountId="a";
  writeFileSync(join(root,"key"),key);
  const store=new ChatGptConversationStore(join(root,"conversations"),accountId);
  let mode:"ok"|"json"|"json200"|"sse"|"sse_error"|"generic"|"truncate"="ok";
  const calls:any[]=[];
  const sse=(events:unknown[]) => new Response(new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode(": opened\n\n"));
    for (const event of events) controller.enqueue(new TextEncoder().encode("data: "+JSON.stringify(event)+"\n\n"));
    controller.close();
  }}),{headers:{"content-type":"text/event-stream"}});
  // Bun's HTTP layer turns a server-side stream error into a clean end, so the reachable
  // pull-path failure after the explicit event is a corrupted continuation line.
  const sseGarbled=(event:unknown) => new Response(new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode(": opened\n\n"));
    controller.enqueue(new TextEncoder().encode("data: "+JSON.stringify(event)+"\n\n"));
    controller.enqueue(new TextEncoder().encode("data: {not json\n\n"));
    controller.close();
  }}),{headers:{"content-type":"text/event-stream"}});
  const backend=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const body=await request.json() as any; calls.push(body);
    const thread=JSON.parse(body.client_metadata["x-codex-turn-metadata"]).thread_id;
    if (mode==="json") return Response.json({error:{type:"invalid_request_error",code:"prompt_attachments_not_submitted",message:"PDF/file attachment failed before Send; no question was submitted",retryable:false}},{status:422});
    if (mode==="json200") return Response.json({status:"failed",error:{type:"invalid_request_error",code:"prompt_attachments_not_submitted",message:"PDF/file attachment failed before Send; no question was submitted"},last_error:{type:"invalid_request_error",code:"prompt_attachments_not_submitted",message:"PDF/file attachment failed before Send; no question was submitted"}});
    const nativeKey=chatGptQuestionAnswerKey(thread,chatGptQuestionAnswerNamespace(accountId));
    if (!store.lookup(nativeKey)) store.bind(nativeKey,store.reserve(nativeKey),`https://chatgpt.com/g/${projectId}/c/paper-${calls.length}`);
    if (mode==="sse") return sse([{type:"response.failed",response:{status:"failed",error:{type:"invalid_request_error",code:"prompt_attachments_not_submitted",message:"PDF/file attachment failed before Send; no question was submitted"}}}]);
    if (mode==="sse_error") return sseGarbled({type:"response.failed",response:{status:"failed",error:{type:"invalid_request_error",code:"prompt_attachments_not_submitted",message:"PDF/file attachment failed before Send; no question was submitted"}}});
    if (mode==="generic") return sse([{type:"response.failed",response:{status:"failed",error:{type:"server_error",code:"chatgpt_unavailable",message:"boom"}}}]);
    if (mode==="truncate") return sse([]);
    return sse([{type:"response.completed",response:{id:"response-"+calls.length,status:"completed",output:[]}}]);
  }});
  const config:QaPoolConfig={host:"127.0.0.1",port:0,databasePath:join(root,"sessions.sqlite"),clients:[{id:"cpr",keyFile:join(root,"key")}],
    accounts:[{id:accountId,origin:backend.url.origin,models:["standard"],sessionModes:true,conversationStoreDirectory:join(root,"conversations")}],
    projectRoutes:[{name:"papers",sessionNamespace:"papers",accountId,projectId}]};
  const pool=createQaPool(config);
  const request=(metadata:object,input:unknown="paper registry lookup",stream=false) => pool.fetch(new Request("http://pool/project/papers/v1/responses",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model:"standard",input,stream,client_metadata:{"x-codex-turn-metadata":JSON.stringify(metadata)}})}));
  const resolve=async(id:string,extra:object={}) => {
    const response=await request({paper_id:id,paper_operation:"resolve",...extra});
    expect(response.status).toBe(200);
    return JSON.parse((await response.json() as any).output[0].content[0].text);
  };
  const pdf=(label:string) => { const bytes=Buffer.from("%PDF-1.4\npre-send test PDF "+label+"\n%%EOF");
    return {sha:createHash("sha256").update(bytes).digest("hex"),
      input:[{role:"user",content:[{type:"input_file",filename:"paper.pdf",file_data:"data:application/pdf;base64,"+bytes.toString("base64")},{type:"input_text",text:"new question"}]}]}; };
  const chat=(id:string,token:string,stream=false,paper={} as ReturnType<typeof pdf>) => request({paper_id:id,paper_operation:"chat",paper_upload_token:token,paper_pdf_sha256:paper.sha},paper.input,stream);
  try {
    // Non-OK JSON: the client keeps the original upstream error, the reservation keeps its token.
    const id="doi:10.1234/pre-send",p=pdf("one");
    const first=await resolve(id);
    mode="json";
    const failure=await chat(id,first.upload_token,false,p);
    expect(failure.status).toBe(422);
    expect((await failure.json() as any).error).toMatchObject({type:"invalid_request_error",code:"prompt_attachments_not_submitted"});
    const kept=await resolve(id,{paper_upload_token:first.upload_token});
    expect(kept).toEqual(first);
    expect(kept.thread_id).toBe(first.thread_id);
    mode="ok";
    const retried=await chat(id,first.upload_token,false,p);
    expect(retried.status).toBe(200);
    await retried.text();
    const ready=await resolve(id);
    expect(ready.status).toBe("ready");
    expect(ready.thread_id).toBe(first.thread_id);
    expect(ready.conversation_url).toBe(`https://chatgpt.com/g/${projectId}/c/paper-${calls.length}`);
    // SSE response.failed with the same explicit code also releases the reservation for retry.
    const sseId="doi:10.1234/pre-send-sse",sp=pdf("two");
    const sseFirst=await resolve(sseId);
    mode="sse";
    const sseFailure=await chat(sseId,sseFirst.upload_token,true,sp);
    expect(sseFailure.status).toBe(200);
    expect(await sseFailure.text()).toContain("response.failed");
    expect((await resolve(sseId,{paper_upload_token:sseFirst.upload_token})).upload_token).toBe(sseFirst.upload_token);
    mode="ok";
    const sseRetry=await chat(sseId,sseFirst.upload_token,true,sp);
    expect(sseRetry.status).toBe(200);
    await sseRetry.text();
    const sseReady=await resolve(sseId);
    expect(sseReady.status).toBe("ready");
    expect(sseReady.thread_id).toBe(sseFirst.thread_id);
    // A 200 status:"failed" body is the runtime's non-stream serialization of the same failure.
    const okId="doi:10.1234/pre-send-ok",op=pdf("three");
    const okFirst=await resolve(okId);
    mode="json200";
    const okFailure=await chat(okId,okFirst.upload_token,false,op);
    expect(okFailure.status).toBe(200);
    expect((await okFailure.json() as any).error.code).toBe("prompt_attachments_not_submitted");
    expect((await resolve(okId,{paper_upload_token:okFirst.upload_token})).upload_token).toBe(okFirst.upload_token);
    mode="ok";
    const okRetry=await chat(okId,okFirst.upload_token,false,op); expect(okRetry.status).toBe(200); await okRetry.text();
    expect((await resolve(okId)).status).toBe("ready");
    // A stream corrupted after the explicit failure event must keep the confirmed pre-send release.
    const errId="doi:10.1234/pre-send-stream-error",ep=pdf("four");
    const errFirst=await resolve(errId);
    mode="sse_error";
    const errFailure=await chat(errId,errFirst.upload_token,true,ep);
    expect(errFailure.status).toBe(200);
    await expect(errFailure.text()).rejects.toThrow();
    expect((await resolve(errId,{paper_upload_token:errFirst.upload_token})).upload_token).toBe(errFirst.upload_token);
    mode="ok";
    const errRetry=await chat(errId,errFirst.upload_token,true,ep); expect(errRetry.status).toBe(200); await errRetry.text();
    expect((await resolve(errId)).status).toBe("ready");
    // A different upstream code and a truncated stream are ambiguous: the paper stays uncertain.
    for (const label of ["generic","truncate"] as const) {
      const nid=`doi:10.1234/${label}-failure`,np=pdf(label);
      const nfirst=await resolve(nid);
      mode=label;
      await (await chat(nid,nfirst.upload_token,true,np)).text();
      expect((await resolve(nid)).status).toBe("uncertain");
      expect((await chat(nid,nfirst.upload_token,false,np)).status).toBe(409);
      mode="ok";
    }
  } finally {pool.close();backend.stop(true);rmSync(root,{recursive:true,force:true});}
});
