// Metadata-only freezer. Does not import fixture/production modules or start browsers/tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const evidence = __dirname;
const task = path.dirname(evidence);
const repo = path.join(task, 'overnight-source-candidate');
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const bun = path.join(task, 'overnight-current-runtime', 'runtime', 'bun.exe');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = file => ({ path: file, bytes: fs.statSync(file).size, sha256: hash(file) });
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:ts|tsx|js|cjs|mjs|json)$/.test(entry.name)) files.push(file);
  }
}
walk(path.join(repo, 'src'));
const optionalSourceRoots = ['launcher/electron'].map(name=>({path:name,present:fs.existsSync(path.join(repo,name))}));
for(const entry of optionalSourceRoots) if(entry.present) walk(path.join(repo,entry.path));
for (const name of ['package.json', 'bun.lock']) if(fs.existsSync(path.join(repo,name))) files.push(path.join(repo, name));
const sourceClosure = files.map(file => ({...record(file), path: path.relative(repo,file).replaceAll('\\','/')})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
const sourceAggregate = crypto.createHash('sha256').update(sourceClosure.map(x=>x.path+'\0'+x.sha256+'\n').join('')).digest('hex');
const dependencies = [];
const modules = path.join(repo, 'node_modules');
for (const entry of fs.readdirSync(modules, {withFileTypes:true})) {
  if (entry.name.startsWith('.')) continue;
  const roots = entry.name.startsWith('@') ? fs.readdirSync(path.join(modules,entry.name)).map(x=>path.join(modules,entry.name,x)) : [path.join(modules,entry.name)];
  for (const root of roots) {
    const metadata = path.join(root,'package.json');
    if (!fs.existsSync(metadata)) continue;
    const value = JSON.parse(fs.readFileSync(metadata,'utf8'));
    dependencies.push({name:value.name,version:value.version,...record(metadata)});
  }
}
dependencies.sort((a,b)=>a.name.localeCompare(b.name));
const fixture = path.join(repo,'tests','pr13-local-chrome.fixture.test.ts');
const inputs = ['tests/fixtures/chatgpt-dil-smoke.html','tests/qa-file-only-completion.test.ts','tests/browser-turn-binding.test.ts',
  'tests/server-real-adapter-pressure.test.ts','tests/server-physical-shutdown.test.ts','tests/turn-execution-retirement.test.ts']
  .map(name=>({...record(path.join(repo,name)),path:name}));
const manifest = {
  preparedAt:new Date().toISOString(),status:'frozen for read-only review; NO Chrome/test execution authorized by this file',
  sourceCommit:'cb12f370feb558002c7416ffe0087a9814e1b091',repo,
  boundary:'Real local Chrome, production server/adapter/journal/registry and DOM response loop; worker.run plus preparation/model-selection/submission/binding replaced. Controlled character relay is synthetic. No ChatGPT/helper/model acceptance.',
  fixture:record(fixture),freezer:record(__filename),
  readme:record(path.join(evidence,'README.zh-CN.md')),
  attempt0:['attempt0-pr13-local-chrome.fixture.test.ts','attempt0-freeze.json','attempt0-freeze-pr13-chrome.cjs','attempt0-README.zh-CN.md'].map(name=>record(path.join(evidence,name))),
  priorPreparations:['attempt1-before-detach-health-pr13-local-chrome.fixture.test.ts','attempt1-before-detach-health-freeze.json',
    'run1-pr13-local-chrome.fixture.test.ts','run1-freeze.json','run1-supervise-pr13-chrome.py','run1-README.zh-CN.md'].map(name=>record(path.join(evidence,name))),
  semanticTypecheck:JSON.parse(fs.readFileSync(path.join(evidence,'attempt4-typecheck.json'),'utf8')),
  staticCheckArtifacts:fs.readdirSync(evidence).filter(name=>/^attempt\d+-(?:typecheck|static-syntax)/.test(name)).sort().map(name=>record(path.join(evidence,name))),
  chrome:{versionFromReadOnlyWindowsPEMetadata:'155.0.8059.80',...record(chrome),
    engine:fs.existsSync(path.join(path.dirname(chrome),'155.0.8059.80','chrome.dll')) ? record(path.join(path.dirname(chrome),'155.0.8059.80','chrome.dll')) : null},
  node:{version:process.version,...record(process.execPath)},bun:{...record(bun)},
  sourceClosureMethod:'Conservative superset: every source file present under src plus optional launcher/electron and root package.json/bun.lock; dependency package metadata separately recorded. Optional missing roots are explicit.',
  optionalSourceRoots,sourceAggregate,sourceClosure,inputs,dependencies,
  safeguards:{chromiumSandbox:true,disabledGpu:true,freshTemporaryProfile:true,wsHost:'127.0.0.1',serverHost:'127.0.0.1',externalPageRequests:'abort all',modelSubmissions:0,installation:false,productionEdits:false},
  plannedResources:{concurrency:1,maxLiveOwnedChrome:1,caseTimeoutSeconds:30,suiteDeadlineSeconds:180,proxyRssMiB:512,treeMiB:2048,diskMiB:2048},
  previousRun:{name:'pr13-cb12-run1',status:'4 passed, 0 failed; shutdown listener-close proof requires targeted strengthening',
    fixtureSHA256:hash(path.join(evidence,'run1-pr13-local-chrome.fixture.test.ts')),
    preservedEvidence:['pr13-cb12-run1-guard.json','pr13-cb12-run1-owned/harness.log','../overnight-source-candidate/output/playwright/pr13-cb12-run1/observations.json']},
  notYetRun:['Only the strengthened shutdown test; three other passed scenarios must not be rerun by this preparation'],
};
fs.writeFileSync(path.join(evidence,'freeze.json'),JSON.stringify(manifest,null,2)+'\n');
process.stdout.write(JSON.stringify({fixtureSha256:manifest.fixture.sha256,chromeSha256:manifest.chrome.sha256,
  sourceAggregate,sourceFiles:sourceClosure.length,dependencies:dependencies.length,manifestSha256:hash(path.join(evidence,'freeze.json'))})+'\n');
