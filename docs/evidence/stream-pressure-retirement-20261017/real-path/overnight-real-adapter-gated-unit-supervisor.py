import hashlib, json, pathlib, subprocess, time, psutil

root = pathlib.Path(__file__).resolve().parent
source = root / 'overnight-source-candidate'
bun = root / 'overnight-installer/payload/unpacked/resources/runtime/runtime/bun.exe'
prefix = root / 'overnight-windows-real-adapter-consumer-gated'
files = ['src/server.ts', 'tests/server-real-adapter-pressure.test.ts']
hashes = {f: hashlib.sha256((source/f).read_bytes()).hexdigest() for f in files}
assert hashes[files[0]] == 'c5c75ddc3a83702309f5204d5e729bf55df6bf8423117ae69ad2239415178455'
assert hashes[files[1]] == 'ec3151ccc9ca6f35952846a2e0311fdbbe9cdf63e8d9f7a10e005567f2465881'
assert not prefix.with_suffix('.json').exists(), 'Do not overwrite prior evidence'
started = time.monotonic()
samples = []
stop_reason = None
args = [str(bun), 'test', 'tests/server-real-adapter-pressure.test.ts']
with prefix.with_suffix('.log').open('w', encoding='utf-8') as log:
    child = subprocess.Popen(args, cwd=source, stdout=log, stderr=subprocess.STDOUT)
    process = psutil.Process(child.pid)
    while child.poll() is None:
        try:
            rss = process.memory_info().rss
            tree = rss + sum(p.memory_info().rss for p in process.children(recursive=True) if p.is_running())
            samples.append({'ms':round((time.monotonic()-started)*1000), 'rss':rss, 'treeRss':tree})
            if rss > 512*1024*1024 or tree > 2*1024**3:
                stop_reason = 'resource-aborted'
            if time.monotonic()-started > 60:
                stop_reason = 'deadline-aborted'
            if stop_reason:
                for p in process.children(recursive=True):
                    p.kill()
                child.kill()
                break
        except psutil.NoSuchProcess:
            pass
        time.sleep(.025)
    code = child.wait(timeout=5)
summary = {'timestampUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
           'platform':'win32','sourceHashes':hashes,'args':args,'pid':child.pid,
           'exitCode':code,'stopReason':stop_reason,'elapsedMs':round((time.monotonic()-started)*1000),
           'rssPeak':max((s['rss'] for s in samples),default=0),'samples':samples,
           'physicalModelSubmissions':0,'childExited':child.poll() is not None}
prefix.with_suffix('.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k not in ('samples','args')}))
raise SystemExit(0 if code == 0 and stop_reason is None else 1)
