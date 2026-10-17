import json,pathlib,subprocess,time,sys,psutil

root=pathlib.Path(__file__).resolve().parent
scenario=sys.argv[1]
cpu='--cpu' in sys.argv[2:]
candidate='--candidate' in sys.argv[2:]
name='overnight-windows-'+scenario+('-cpu' if cpu else '')+('-candidate-1' if candidate else '-baseline-1')
bun=root/'overnight-installer/payload/unpacked/resources/runtime/runtime/bun.exe'
source=root/('overnight-source-candidate' if candidate else 'overnight-source')
script='overnight-retirement-probe.ts' if scenario=='retirement' else 'overnight-queue-probe.ts'
args=[str(bun),'run',script]+([] if scenario=='retirement' else [scenario])+[str(root/(name+'.json'))]
samples=[]
stop_reason=None
stress=None
stress_cpu_seconds=0
stress_wall_seconds=0
started=time.monotonic()
with (root/(name+'.log')).open('w',encoding='utf-8') as log:
    try:
        if cpu:
            stress=subprocess.Popen([r'C:\Program Files\nodejs\node.exe','-e','const end=Date.now()+30000;let x=0;while(Date.now()<end){x=Math.sqrt(x+Math.random())}console.log(x)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        child=subprocess.Popen(args,cwd=source,stdout=log,stderr=subprocess.STDOUT)
        process=psutil.Process(child.pid)
        while child.poll() is None:
            try:
                rss=process.memory_info().rss
                tree=rss+sum(p.memory_info().rss for p in process.children(recursive=True) if p.is_running())
                samples.append({'ms':round((time.monotonic()-started)*1000),'rss':rss,'treeRss':tree})
                if rss>512*1024*1024 or tree>2*1024**3:stop_reason='resource-aborted'
                if time.monotonic()-started>20:stop_reason='deadline-aborted'
                if stop_reason:
                    for p in process.children(recursive=True):p.kill()
                    child.kill()
                    break
            except (psutil.NoSuchProcess,psutil.AccessDenied):pass
            time.sleep(.025)
        code=child.wait(timeout=5)
    finally:
        if stress is not None:
            stress_wall_seconds=time.monotonic()-started
            try:
                timing=psutil.Process(stress.pid).cpu_times()
                stress_cpu_seconds=timing.user+timing.system
            except (psutil.NoSuchProcess,psutil.AccessDenied):pass
            if stress.poll() is None:stress.terminate()
            stress.wait(timeout=5)
summary={'scenario':scenario,'platform':'win32','variant':'candidate' if candidate else 'baseline','pid':child.pid,'timestampUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'exitCode':code,'stopReason':stop_reason,
         'elapsedMs':round((time.monotonic()-started)*1000),'samples':samples,
         'rssPeak':max((x['rss'] for x in samples),default=0),'cpuBusyThreads':1 if cpu else 0,
         'cpuBurstUpperSeconds':30 if cpu else 0,'physicalModelSubmissions':0,
         'stressCpuSeconds':stress_cpu_seconds,'stressWallSeconds':stress_wall_seconds,
         'childExited':child.poll() is not None,'stressExited':stress is None or stress.poll() is not None}
(root/(name+'-supervisor.json')).write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k!='samples'}))
sys.exit(0 if code==0 and stop_reason is None else 1)
