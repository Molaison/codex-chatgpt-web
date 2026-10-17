"""Only copies source bytes and runs existing tsc; never imports/runs the fixture."""
from pathlib import Path
import hashlib, json, shlex, subprocess, sys, time

attempt = int(sys.argv[1])
evidence = Path(__file__).resolve().parent
base = evidence.parent
fixture = base / 'overnight-source-candidate/tests/pr13-local-chrome.fixture.test.ts'
data = fixture.read_bytes()
remote = '<YWL_TASK>/pr13-chrome-typecheck'
source = '<YWL_TASK>/overnight-pressure/src'
dependencies = '<YWL_TASK>/dependency-overlay'
prefix = evidence / ('attempt%d-typecheck' % attempt)
if prefix.with_suffix('.json').exists():
    raise SystemExit('Refusing to overwrite an earlier typecheck attempt')
config = {'compilerOptions': {'target':'ES2023','module':'ESNext','moduleResolution':'Bundler',
    'strict':True,'skipLibCheck':True,'noEmit':True,'types':['bun-types']},
    'files':['tests/pr13-local-chrome.fixture.test.ts','src/domino.d.ts','src/turndown-plugin-gfm.d.ts']}
setup = ('import os,sys,hashlib; root=' + repr(remote) + '; os.makedirs(root+"/tests",exist_ok=True); '
    + '[(os.symlink(t,root+"/"+n) if not os.path.lexists(root+"/"+n) else None) for n,t in '
    + repr([('src',source),('node_modules',dependencies)]) + ']; data=sys.stdin.buffer.read(); '
    + 'open(root+"/tests/pr13-local-chrome.fixture.test.ts","wb").write(data); '
    + 'open(root+"/tsconfig.json","w").write(' + repr(json.dumps(config)) + '); '
    + 'print(hashlib.sha256(data).hexdigest())')
ssh = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','ywl']
copy = subprocess.run(ssh+['python3 -c '+shlex.quote(setup)],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
Path(str(prefix)+'-copy.stdout.txt').write_bytes(copy.stdout)
Path(str(prefix)+'-copy.stderr.txt').write_bytes(copy.stderr)
if copy.returncode or copy.stdout.decode().strip() != hashlib.sha256(data).hexdigest():
    raise SystemExit('Exact-byte typecheck copy failed')
bun = '<YWL_HOME>/.local/lib/codex-chatgpt-web/cpr-native-retry-20261017-qa-1/runtime/runtime/bun'
command = 'cd '+shlex.quote(remote)+' && '+shlex.quote(bun)+' node_modules/typescript/bin/tsc --project tsconfig.json --pretty false'
Path(str(prefix)+'-command.txt').write_text(command+'\n',encoding='utf8')
started = time.monotonic()
result = subprocess.run(ssh+[command],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
Path(str(prefix)+'.stdout.txt').write_bytes(result.stdout)
Path(str(prefix)+'.stderr.txt').write_bytes(result.stderr)
metadata = {'kind':'TypeScript semantic typecheck; no fixture/test/browser execution','typescript':'5.9.3',
    'bunTypes':'1.4.0','fixtureSHA256':hashlib.sha256(data).hexdigest(),'command':command,'config':config,
    'exitCode':result.returncode,'seconds':time.monotonic()-started,'productionSource':source,'runtimeDependencies':dependencies}
Path(str(prefix)+'.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf8')
print(json.dumps(metadata))
print(result.stdout.decode(errors='replace')[:12000])
print(result.stderr.decode(errors='replace')[:4000])
raise SystemExit(result.returncode)
