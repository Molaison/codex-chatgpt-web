import {readFileSync, existsSync, unlinkSync, chmodSync} from 'node:fs';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {zstdDecompressSync, gunzipSync} from 'node:zlib';
import http from 'node:http';
import {normalizeCprRequest} from './cpr-session.mjs';
const home=process.argv[2];
const config=JSON.parse(readFileSync(home+'/config.json','utf8'));
const key=readFileSync(home+'/provider.key','utf8').trim();
const socketPath=home+'/cpr/provider.sock';
const reply=(res,status,message)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message,type:'local_provider_error'}}));};
const serve=async(req,res)=>{
  const supplied=Buffer.from(req.headers.authorization||'');
  const expected=Buffer.from('Bearer '+key);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){reply(res,401,'Unauthorized');return;}
  const path=new URL(req.url,'http://localhost').pathname;
  const ready=existsSync(config.storageStatePath+'.verified.json');
  if(path==='/healthz'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:ready?'authenticated':'login_required',port:config.port}));return;}
  if(!ready){reply(res,503,'Complete this account sign-in first');return;}
  const {models}=JSON.parse(readFileSync(home+'/models.json','utf8'));
  if(req.method==='GET'&&path==='/v1/models'){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({object:'list',data:models.map(m=>({id:m.slug,object:'model',created:0,owned_by:'chatgpt-web'})),models}));return;
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
  if(!models.some(m=>m.slug===payload.model)){reply(res,400,'Model unavailable for this account');return;}
  const headers={...req.headers,host:'127.0.0.1:'+config.port,'content-length':body.length};
  delete headers.authorization;delete headers['transfer-encoding'];
  if(path==='/v1/responses'){
    // 显式 session/thread/cache identity 跨回合保持稳定；无会话标识的探测仍独立。
    const requestId=typeof req.headers['x-request-id']==='string'?req.headers['x-request-id']:randomUUID();
    payload=normalizeCprRequest(payload,req.headers,requestId);
    body=Buffer.from(JSON.stringify(payload));delete headers['content-encoding'];headers['content-length']=body.length;
  }
  const upstream=http.request({hostname:'127.0.0.1',port:config.port,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{if(res.headersSent)res.destroy();else reply(res,502,'Local browser runtime unavailable');});
  res.on('close',()=>upstream.destroy());upstream.end(body);
};
if(existsSync(socketPath))unlinkSync(socketPath);
const server=http.createServer((req,res)=>{serve(req,res).catch(()=>{if(res.headersSent)res.destroy();else reply(res,500,'Local provider error');});});
server.listen(socketPath,()=>chmodSync(socketPath,0o600));
