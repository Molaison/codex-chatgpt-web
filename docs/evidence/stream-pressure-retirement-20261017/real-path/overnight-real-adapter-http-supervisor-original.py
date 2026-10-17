import json,os,pathlib,signal,subprocess,time,sys
root=pathlib.Path.cwd();e=root.parent/'windows-ci-evidence'
scenario=sys.argv[1]
assert scenario in ('json','sse')
script='overnight-real-adapter-http-probe.ts'
name='overnight-real-adapter-http-'+scenario+'-1'
assert not (e/(name+'.log')).exists(), 'preserve existing evidence'
bun='<user-home>/.local/lib/codex-chatgpt-web/cpr-native-retry-20261017-qa-1/runtime/runtime/bun'
args=[bun,'run',script,scenario,str(e/(name+'.json'))]
started=time.monotonic();peak=0;stop=None;samples=[]
with (e/(name+'.log')).open('w') as out:
 p=subprocess.Popen(args,cwd=str(root),stdout=out,stderr=subprocess.STDOUT,preexec_fn=os.setsid)
 while p.poll() is None:
  try:
   status=pathlib.Path('/proc/'+str(p.pid)+'/status').read_text()
   rss=next(int(x.split()[1])*1024 for x in status.splitlines() if x.startswith('VmRSS:'))
   peak=max(peak,rss);samples.append({'ms':round((time.monotonic()-started)*1000),'rss':rss})
   if rss>512*1024*1024:stop='resource-aborted'
  except (FileNotFoundError,StopIteration):pass
  if time.monotonic()-started>20:stop='deadline-aborted'
  if stop:
   os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=2)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL)
   break
  time.sleep(.025)
 code=p.wait(timeout=5)
result={'scenario':scenario,'platform':'linux','pid':p.pid,'exitCode':code,'stopReason':stop,'rssPeak':peak,'samples':samples,'elapsedMs':round((time.monotonic()-started)*1000),'physicalModelSubmissions':0,'childExited':p.poll() is not None,'commit':subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()}
(e/(name+'-supervisor.json')).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='samples'}))
if code!=0 or stop:sys.exit(1)
