import {readFileSync, existsSync, unlinkSync, chmodSync} from 'node:fs';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {zstdDecompressSync, gunzipSync} from 'node:zlib';
import http from 'node:http';
import {Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {normalizeCprRequest} from './cpr-session.mjs';
const home=process.argv[2];
const config=JSON.parse(readFileSync(home+'/config.json','utf8'));
const key=readFileSync(home+'/provider.key','utf8').trim();
const socketPath=home+'/cpr/provider.sock';
const reply=(res,status,message)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message,type:'local_provider_error'}}));};

// Full 模式（config.mode==='full'）把独立的 Full models.json 发布成 <slug>-tools 公开别名：
// /v1/models 只列别名，/v1/responses 与 /v1/responses/compact 只接受别名，转发前剥掉后缀，
// 响应里的 model 字段再改回别名。QA 模式（mode!=='full'）目录与请求/响应字节保持原样。
const TOOLS_SUFFIX='-tools';
const toolsMode=config.mode==='full';
const toolsSlug=slug=>slug+TOOLS_SUFFIX;
const publicCatalog=models=>toolsMode
  ? models.map(model=>({...model,slug:toolsSlug(model.slug),
      display_name:`${model.display_name??model.slug}${TOOLS_SUFFIX}`,
      description:`Local tools route for ${model.slug}: tools and local MCP run on the requesting client`}))
  : models;
const aliasTargets=models=>new Map(toolsMode?models.map(model=>[toolsSlug(model.slug),model.slug]):[]);

// Only Responses model identity fields are aliases. Structured user/tool metadata is unchanged.
const rewriteModelLine=(line,base,alias)=>{
  const framing=/^(\s*data:\s*)(.*)$/.exec(line);
  const text=framing?framing[2]:line;
  let parsed;
  try{parsed=JSON.parse(text);}catch{return line;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return line;
  let changed=false;
  if(parsed.model===base){parsed.model=alias;changed=true;}
  if(parsed.response&&typeof parsed.response==='object'&&parsed.response.model===base){
    parsed.response.model=alias;changed=true;
  }
  return changed?(framing?framing[1]:'')+JSON.stringify(parsed):line;
};
// 边读边改：只暂存跨块的半行，SSE 仍然增量转发。
const rewriteModelIdentity=(base,alias)=>{
  const decoder=new StringDecoder('utf8');let pending='';
  return new Transform({
    transform(chunk,encoding,callback){
      pending+=decoder.write(chunk);
      const end=pending.lastIndexOf('\n');
      if(end<0){callback();return;}
      const lines=pending.slice(0,end).split('\n');
      pending=pending.slice(end+1);
      callback(null,lines.map(line=>rewriteModelLine(line,base,alias)).join('\n')+'\n');
    },
    flush(callback){const rest=pending+decoder.end();callback(null,rest?rewriteModelLine(rest,base,alias):'');},
  });
};

const serve=async(req,res)=>{
  const supplied=Buffer.from(req.headers.authorization||'');
  const expected=Buffer.from('Bearer '+key);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){reply(res,401,'Unauthorized');return;}
  const path=new URL(req.url,'http://localhost').pathname;
  const ready=existsSync(config.storageStatePath+'.verified.json');
  if(path==='/healthz'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:ready?'authenticated':'login_required',port:config.port}));return;}
  if(!ready){reply(res,503,'Complete this account sign-in first');return;}
  const {models}=JSON.parse(readFileSync(home+'/models.json','utf8'));
  const catalog=publicCatalog(models);
  const aliases=aliasTargets(models);
  if(req.method==='GET'&&path==='/v1/models'){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({object:'list',data:catalog.map(m=>({id:m.slug,object:'model',created:0,owned_by:'chatgpt-web'})),models:catalog}));return;
  }
  if(req.method!=='POST'||!['/v1/responses','/v1/responses/compact'].includes(path)){reply(res,404,'Unknown route');return;}
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>67108864){reply(res,413,'Request too large');return;}chunks.push(chunk);}
  let body=Buffer.concat(chunks);let payload;
  try {
    const encoding=req.headers['content-encoding']||'identity';
    const decoded=encoding==='zstd'?zstdDecompressSync(body,{maxOutputLength:67108864}):encoding==='gzip'?gunzipSync(body,{maxOutputLength:67108864}):encoding==='identity'?body:null;
    if(!decoded){reply(res,415,'Unsupported content encoding');return;}
    payload=JSON.parse(decoded.toString('utf8'));
  } catch {reply(res,400,'Invalid request body');return;}
  // 访问检查保持在归一化与转发之前：QA 只认原目录，Full 只认公开别名（原未加后缀的名字在此被拒）。
  const requestedModel=payload.model;
  if(!catalog.some(m=>m.slug===requestedModel)){reply(res,400,'Model unavailable for this account');return;}
  const upstreamModel=aliases.get(requestedModel);
  if(upstreamModel!==undefined)payload.model=upstreamModel;
  const headers={...req.headers,host:'127.0.0.1:'+config.port,'content-length':body.length};
  delete headers.authorization;delete headers['transfer-encoding'];
  if(path==='/v1/responses'){
    // 显式 session/thread/cache identity 跨回合保持稳定；无会话标识的探测仍独立。
    const requestId=typeof req.headers['x-request-id']==='string'?req.headers['x-request-id']:randomUUID();
    payload=normalizeCprRequest(payload,req.headers,requestId);
    body=Buffer.from(JSON.stringify(payload));delete headers['content-encoding'];headers['content-length']=body.length;
  } else if(upstreamModel!==undefined){
    body=Buffer.from(JSON.stringify(payload));delete headers['content-encoding'];headers['content-length']=body.length;
  }
  if(upstreamModel!==undefined)delete headers['accept-encoding'];
  const upstream=http.request({hostname:'127.0.0.1',port:config.port,path:req.url,method:req.method,headers},response=>{
    if(upstreamModel===undefined){res.writeHead(response.statusCode,response.headers);response.pipe(res);return;}
    const responseHeaders={...response.headers};delete responseHeaders['content-length'];
    res.writeHead(response.statusCode,responseHeaders);
    response.pipe(rewriteModelIdentity(upstreamModel,requestedModel)).pipe(res);
  });
  upstream.on('error',()=>{if(res.headersSent)res.destroy();else reply(res,502,'Local browser runtime unavailable');});
  res.on('close',()=>upstream.destroy());upstream.end(body);
};
if(existsSync(socketPath))unlinkSync(socketPath);
const server=http.createServer((req,res)=>{serve(req,res).catch(()=>{if(res.headersSent)res.destroy();else reply(res,500,'Local provider error');});});
server.listen(socketPath,()=>chmodSync(socketPath,0o600));
