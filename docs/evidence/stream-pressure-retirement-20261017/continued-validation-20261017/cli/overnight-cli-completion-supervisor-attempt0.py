"""Task-owned Linux supervisor. Preparation/verification mode never starts Codex or the fixture."""
import hashlib,json,os,pathlib,signal,subprocess,sys,time

ROOT=pathlib.Path('<YWL_TASK>/overnight-pressure')
EVIDENCE=ROOT.parent/'windows-ci-evidence'
NAME='overnight-cli-completion-cb12-1'
PREFIX=EVIDENCE/NAME
LEDGER=EVIDENCE/'overnight-cli-completion-cb12-ledger.json'
MANIFEST=EVIDENCE/(NAME+'-manifest.json')
HEAD='cb12f370feb558002c7416ffe0087a9814e1b091'
BUN='<YWL_HOME>/.local/lib/codex-chatgpt-web/cpr-native-retry-20261017-qa-1/runtime/runtime/bun'
CODEX='<YWL_HOME>/.local/lib/codex-official-v0.162.0/bin/codex'
SCRIPT=ROOT/'overnight-cli-completion-suite.ts'
GUARD=ROOT/'overnight-cli-completion-supervisor.py'
CATALOG=ROOT/'windows-ci-evidence/overnight-cli-candidate-last-data/models.json'
LIMITS={'proxyRssBytes':512*1024**2,'treeRssBytes':2*1024**3,'diskBytes':2*1024**3,
        'perLogicalMs':45000,'suiteMs':900000,'logicalTurns':30,'responsesHttp':40}
def sha(path):
 h=hashlib.sha256()
 with open(str(path),'rb') as f:
  for part in iter(lambda:f.read(1024*1024),b''):h.update(part)
 return h.hexdigest()
def git(*args):return subprocess.check_output(['git']+list(args),cwd=str(ROOT)).decode().strip()
def files():
 paths=[str(ROOT/x) for x in git('ls-files','src','package.json','bun.lock').splitlines()]
 paths += [str(SCRIPT),str(GUARD),BUN,CODEX,str(CATALOG)]
 package=json.loads((ROOT/'package.json').read_text())
 direct=dict(package.get('dependencies',{}),**package.get('devDependencies',{}))
 paths += [str(ROOT/'node_modules'/name/'package.json') for name in direct]
 return sorted(set(paths))
def freeze():
 assert not MANIFEST.exists(),'Do not overwrite frozen preparation evidence'
 assert git('rev-parse','HEAD')==HEAD
 assert not git('diff','HEAD','--','src','package.json','bun.lock'),'production must be clean'
 doc={'head':HEAD,'tree':git('rev-parse','HEAD^{tree}'),'createdAtUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
      'status':'prepared_not_executed','limits':LIMITS,'hashes':{p:sha(p) for p in files()},
      'directDependencyVersions':{name:json.loads((ROOT/'node_modules'/name/'package.json').read_text())['version'] for name in direct_versions()},
      'codex':{'path':CODEX,'version':'0.162.0; existing installation, SHA bound; no version invocation during preparation'},
      'bun':{'path':BUN,'version':'1.4.0+34cbb9a40'},'dependencyOverlay':os.path.realpath(str(ROOT/'node_modules')),
      'model':{'slug':'chatgpt-web/gpt-5.6-luna','backend':'gpt-5.6-luna','solAvailable':False,'proAvailable':False,
               'upstream':'hard reject; no real model calls','key':'dummy new local key, never user auth'},
      'expected':{'logicalTurns':25,'responsesHttp':27,'execChildren':23,'appServerChildren':1,
                  'normalExec':1,'sameHomeResume':1,'reconnect':{'http':3,'worker':1,'send':1,'cuts':2},
                  'interrupt':{'sameAppServerThreads':2,'stubWorkerPeak':2,'hook':'production install + native trusted-hash verification'},
                  'cleanupCycles':20,'nativeProcessConcurrency':1,'models':0},
      'command':['python3',str(GUARD),'--execute-reviewed-suite','--phase','all','--run','1'],
      'phaseOptions':['all','exec-resume','reconnect','interrupt-peer','cleanup'],
      'cumulativeLedger':str(LEDGER),
      'preserves':['old monitor-aborted/resume-cancelled evidence','old 3HTTP plus new 2HTTP pair evidence'],
      'notes':['All children use new empty CODEX_HOME/HOME/SQLite/tmp/app; no credential copy or user config read.',
               'Read-only sandbox and normal trusted production Interrupt hook; no dangerous bypass.',
               'First unexpected failure stops without retry; 20 cycles retained as a denominator, not an absolute leak claim.',
               'Parent review required before this command is invoked.']}
 MANIFEST.write_text(json.dumps(doc,indent=2)+'\n')
 print(json.dumps({'status':doc['status'],'manifest':str(MANIFEST),'scriptSha256':doc['hashes'][str(SCRIPT)],'guardSha256':doc['hashes'][str(GUARD)]}))
def verify():
 doc=json.loads(MANIFEST.read_text());assert git('rev-parse','HEAD')==doc['head']==HEAD
 bad=[p for p,h in doc['hashes'].items() if not pathlib.Path(p).is_file() or sha(p)!=h]
 assert not bad,'Frozen inputs changed: '+repr(bad)
 assert not git('diff','HEAD','--','src','package.json','bun.lock')
 return doc
def direct_versions():
 package=json.loads((ROOT/'package.json').read_text())
 return sorted(set(package.get('dependencies',{}))|set(package.get('devDependencies',{})))
def disk_size(path):
 total=0;skips=0
 try: entries=list(os.scandir(str(path)))
 except (FileNotFoundError,NotADirectoryError):return 0,1
 for ent in entries:
  try:
   if ent.is_symlink():continue
   if ent.is_dir(follow_symlinks=False):
    size,missing=disk_size(ent.path);total+=size;skips+=missing
   elif ent.is_file(follow_symlinks=False):total+=ent.stat(follow_symlinks=False).st_size
  except (FileNotFoundError,NotADirectoryError):skips+=1
 return total,skips
def process_table():
 table={}
 for path in pathlib.Path('/proc').iterdir():
  if not path.name.isdigit():continue
  try:
   # comm can contain spaces/parentheses; fields after final ')' start at state.
   fields=(path/'stat').read_text().rsplit(')',1)[1].split()
   table[int(path.name)]={'ppid':int(fields[1]),'pgrp':int(fields[2]),'start':int(fields[19]),'rss':int(fields[21])*os.sysconf('SC_PAGE_SIZE')}
  except (FileNotFoundError,ProcessLookupError):continue
 return table
def save_ledger(doc):
 tmp=pathlib.Path(str(LEDGER)+'.tmp-supervisor')
 tmp.write_text(json.dumps(doc,indent=2)+'\n');os.replace(str(tmp),str(LEDGER))
def run(phase='all',run_id='1'):
 global PREFIX,NAME
 assert phase in ('all','exec-resume','reconnect','interrupt-peer','cleanup')
 assert run_id.isdigit() and int(run_id)>0
 NAME='overnight-cli-completion-cb12-'+run_id;PREFIX=EVIDENCE/NAME
 verify()
 assert not (pathlib.Path(str(PREFIX)+'-guard.json')).exists(),'Never repeat an execution under an old prefix'
 assert not (pathlib.Path(str(PREFIX)+'-data')).exists(),'Never reuse old home'
 assert not (pathlib.Path(str(PREFIX)+'-result.json')).exists()
 ledger=json.loads(LEDGER.read_text()) if LEDGER.exists() else {'head':HEAD,'logicalTurns':0,'responsesHttp':0,'runs':[],'turns':[],'physicalModelSubmissions':0}
 assert ledger['head']==HEAD and ledger['logicalTurns']<30 and ledger['responsesHttp']<40
 assert not any(run['prefix']==str(PREFIX) for run in ledger['runs'])
 ledger['runs'].append({'prefix':str(PREFIX),'phase':phase,'status':'launched','atUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})
 save_ledger(ledger)
 started=time.monotonic();samples=[];known={};stop=None;disk=0;optionalSkips=0
 args=[BUN,'run',str(SCRIPT),'--execute-reviewed-suite',str(PREFIX),phase]
 with open(str(PREFIX)+'-harness.log','x') as out:
  child=subprocess.Popen(args,cwd=str(ROOT),stdout=out,stderr=subprocess.STDOUT,preexec_fn=os.setsid,
       env={'PATH':os.environ.get('PATH',''),'LANG':'C.UTF-8','HOME':str(PREFIX)+'-data/codex-home',
            'CODEX_HOME':str(PREFIX)+'-data/codex-home','CODEX_CHATGPT_WEB_HOME':str(PREFIX)+'-data/app-home'})
  missing_proxy=0
  try:
   while child.poll() is None:
    table=process_table()
    owned={child.pid}
    # Retain previously observed descendants even if their parent exits first; identity guards PID reuse.
    owned.update(pid for pid,stamp in known.items() if pid in table and table[pid]['start']==stamp)
    changed=True
    while changed:
     changed=False
     for pid,row in table.items():
      if row['ppid'] in owned and pid not in owned:owned.add(pid);changed=True
    for pid in owned:
     if pid in table:known[pid]=table[pid]['start']
    tree=[dict(pid=pid,**table[pid]) for pid in owned if pid in table]
    proxy=table.get(child.pid)
    if proxy is None:
     missing_proxy+=1
     if child.poll() is None and missing_proxy>2:raise RuntimeError('RSS guard unavailable for live proxy')
    else:missing_proxy=0
    proxy_rss=proxy['rss'] if proxy else 0;tree_rss=sum(row['rss'] for row in tree)
    ms=round((time.monotonic()-started)*1000)
    if len(samples)%10==0:
     disk,skips=disk_size(str(PREFIX)+'-data');optionalSkips+=skips
     for artifact in EVIDENCE.glob(NAME+'*'):
      try:
       if artifact.is_file():disk+=artifact.stat().st_size
      except FileNotFoundError:optionalSkips+=1
    samples.append({'ms':ms,'proxyRssBytes':proxy_rss,'treeRssBytes':tree_rss,'diskBytes':disk,'processes':tree})
    if proxy_rss>LIMITS['proxyRssBytes']:stop='proxy RSS 512MiB exceeded'
    elif tree_rss>LIMITS['treeRssBytes']:stop='tree RSS 2GiB exceeded'
    elif disk>LIMITS['diskBytes']:stop='task disk 2GiB exceeded'
    elif ms>LIMITS['suiteMs']:stop='suite 15min deadline exceeded'
    if stop:break
    time.sleep(.1)
  except Exception as error:stop='resource guard failure: '+repr(error)
  finally:
   def owned_alive():
    table=process_table()
    return [pid for pid,stamp in known.items() if pid in table and table[pid]['start']==stamp]
   # Stop only own captured identities, never name-match global users or services.
   live=owned_alive();lingering_before_cleanup=list(live) if child.poll() is not None else []
   if stop or child.poll() is None:
    for pid in reversed(live):
     try:os.kill(pid,signal.SIGTERM)
     except ProcessLookupError:pass
    try:os.killpg(child.pid,signal.SIGTERM)
    except ProcessLookupError:pass
    until=time.monotonic()+2
    while time.monotonic()<until and child.poll() is None:time.sleep(.05)
   for pid in owned_alive():
    try:os.kill(pid,signal.SIGKILL)
    except ProcessLookupError:pass
   try:code=child.wait(timeout=3)
   except subprocess.TimeoutExpired:child.kill();code=child.wait(timeout=3)
   alive=owned_alive()
 doc={'exitCode':code,'stopReason':stop,'pid':child.pid,'elapsedMs':round((time.monotonic()-started)*1000),
      'samples':samples,'proxyPeakRssBytes':max([s['proxyRssBytes'] for s in samples] or [0]),
      'treePeakRssBytes':max([s['treeRssBytes'] for s in samples] or [0]),'taskDiskBytes':disk,
      'optionalMissingDiskSkips':optionalSkips,'ownedPidsObserved':known,'ownedPidsStillPresent':alive,
      'lingeringBeforeSupervisorCleanup':lingering_before_cleanup,
      'physicalModelSubmissions':0,'frozenManifestVerifiedAfter':False}
 ledger=json.loads(LEDGER.read_text());run=next(run for run in ledger['runs'] if run['prefix']==str(PREFIX))
 if run['status']=='launched':run['status']='setup-failed-or-monitor-aborted'
 run['supervisorExit']=code;run['stopReason']=stop
 for turn in ledger['turns']:
  if turn['prefix']==str(PREFIX) and turn['status']=='started':turn['status']='failed-or-monitor-aborted'
 save_ledger(ledger);doc['cumulativeLedger']={'logicalTurns':ledger['logicalTurns'],'responsesHttp':ledger['responsesHttp'],'runs':len(ledger['runs'])}
 try:verify();doc['frozenManifestVerifiedAfter']=True
 except Exception as error:doc['postVerificationError']=str(error)
 pathlib.Path(str(PREFIX)+'-guard.json').write_text(json.dumps(doc,indent=2)+'\n')
 print(json.dumps({k:v for k,v in doc.items() if k not in ('samples','ownedPidsObserved')}))
 if stop or code or alive or lingering_before_cleanup or not doc['frozenManifestVerifiedAfter']:sys.exit(1)
if __name__=='__main__':
 mode=sys.argv[1] if len(sys.argv)>1 else ''
 if mode=='--freeze':freeze()
 elif mode=='--verify-only':verify();print('FROZEN_INPUTS_OK; no CLI/HTTP/process started')
 elif mode=='--monitor-selftest':
  table=process_table();assert table[os.getpid()]['rss']>0
  size,skips=disk_size(str(ROOT/'__absent_completion_fixture_selftest__'));assert size==0 and skips==1
  print(json.dumps({'rssGuardAvailable':True,'ownRssBytes':table[os.getpid()]['rss'],'optionalMissingDiskSkip':True,
                    'cliInvocations':0,'httpRequests':0,'childProcessesStarted':0,'physicalModelSubmissions':0}))
 elif mode=='--execute-reviewed-suite':
  args=sys.argv[2:];assert all(arg in ('--phase','--run') for arg in args[::2]) and len(args)%2==0
  options=dict(zip(args[::2],args[1::2]));run(options.get('--phase','all'),options.get('--run','1'))
 else:raise SystemExit('Choose --freeze / --verify-only / --execute-reviewed-suite after parent review')
