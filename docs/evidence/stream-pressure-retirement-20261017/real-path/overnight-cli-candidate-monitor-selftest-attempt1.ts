import {mkdirSync,writeFileSync,readdirSync,statSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const root=resolve('windows-ci-evidence/overnight-cli-candidate-monitor-selftest-data');mkdirSync(root,{recursive:true});
const source=readFileSync('windows-ci-evidence/overnight-cli-candidate-fixture.ts','utf8');
const original=source.slice(source.indexOf('function size('),source.indexOf('\nconst samples:',source.indexOf('function size('))).replaceAll(':string','').replaceAll(':number','');
const oldSize=new Function('readdirSync','statSync','join',original+'; return size;')(readdirSync,statSync,join);
let optionalSkips=0;
function safeSize(path:string):number {let entries;try{entries=readdirSync(path,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT'||e.code==='ENOTDIR'){optionalSkips++;return 0;}throw e;}let n=0;for(const ent of entries){const p=join(path,ent.name);try{if(ent.isDirectory())n+=safeSize(p);else if(ent.isFile())n+=statSync(p).size;}catch(e:any){if(e.code==='ENOENT'||e.code==='ENOTDIR'){optionalSkips++;continue;}throw e;}}return n;}
const child=spawn('python3',['-c',`import os,shutil,sys,time
base=os.path.realpath(sys.argv[1]);p=os.path.join(base,'dynamic');assert os.path.commonpath([base,p])==base
end=time.time()+3
while time.time()<end:
 os.makedirs(p,exist_ok=True)
 for n in range(50):
  with open(os.path.join(p,str(n)),'w')as f:f.write('monitor fixture')
 shutil.rmtree(p)
`,root],{stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',x=>stderr+=x);const errors:any[]=[];let oldAttempts=0,newAttempts=0;
const end=Date.now()+3200;while(Date.now()<end){try{oldSize(root);}catch(e:any){if(errors.length<4)errors.push({name:e.name,code:e.code,message:e.message,stack:e.stack});}oldAttempts++;safeSize(root);newAttempts++;await Bun.sleep(1);}
const code=await new Promise<number|null>(r=>child.on('exit',r));
function guardParse(stdout:string,status:number|null){if(status!==0)throw Error('ps failed');const rows=stdout.trim().split('\n').map(x=>x.trim().split(/\s+/).map(Number));if(!rows.length||rows.some(x=>x.length!==3||x.some(y=>!Number.isFinite(y))))throw Error('invalid RSS snapshot');const own=rows.find(x=>x[0]===process.pid);if(!own)throw Error('proxy RSS unavailable');return own[2]*1024;}
const ps=spawnSync('ps',['-eo','pid=,ppid=,rss='],{encoding:'utf8',timeout:2000});const rss=guardParse(ps.stdout,ps.status);let unavailableStops=false;try{guardParse('',1);}catch{unavailableStops=true;}
const result={actualExceptionCaptured:errors.length>0,originalExceptions:errors,oldAttempts,newAttempts,optionalSkips,correctedDiskStatSurvivesDeletion:true,RssGuardAvailable:rss>0,RssGuardFailureStops:unavailableStops,proxyRssBytes:rss,childExit:code,childStderr:stderr,realModelCalls:0,cliInvocations:0,limitation:'Captured exception is from an isolated real filesystem churn self-test; the previous run catch discarded its exception, so its exact original cause remains unknown.'};
writeFileSync('windows-ci-evidence/overnight-cli-candidate-monitor-selftest.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,originalExceptions:errors.map(x=>({code:x.code,message:x.message}))}));if(!errors.length||!optionalSkips||!unavailableStops||code!==0)process.exitCode=1;
