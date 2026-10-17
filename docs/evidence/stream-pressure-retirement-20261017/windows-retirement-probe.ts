import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const output = process.argv[2];
const root = mkdtempSync(join(tmpdir(), 'overnight-retirement-'));
console.error('PROBE_PHASE '+JSON.stringify({phase:'temporary-created',pid:process.pid,root}));
const oldHome = process.env.CODEX_CHATGPT_WEB_HOME;
process.env.CODEX_CHATGPT_WEB_HOME = root;
const beforeSignals = new Map(['SIGINT', 'SIGTERM'].map(s => [s, process.listeners(s)]));
const { defaultConfig } = await import('./src/config');
console.error('PROBE_PHASE config-imported');
const { startServer } = await import('./src/server');
console.error('PROBE_PHASE server-imported');
const { ChatGptTraceFeed, ChatGptTextFeed, chatGptTurnSessions } = await import('./src/adapters/chatgpt-web/turn-execution');
console.error('PROBE_PHASE adapters/chatgpt-web/turn-execution-imported');
const { flushResponseState } = await import('./src/responses/state');
console.error('PROBE_PHASE responses/state-imported');
let settlePhysical!: () => void, settleBrowser!: (value: string) => void;
const physicalSettlement = new Promise<void>(r => { settlePhysical = r; });
const browser = new Promise<string>(r => { settleBrowser = r; });
let settled = false;
physicalSettlement.then(() => { settled = true; });
const observations: any = { platform: process.platform, bun: Bun.version, revision: Bun.revision,
  physicalModelSubmissions: 0, cancelCalls: 0, upstreamCalls: 0, adapterCalls: 0, samples: [] };
const config = { ...defaultConfig('browser-only'), port: 0, host: '127.0.0.1', solAvailable: false,
  conversationStoreDirectory: join(root, 'conversations'), brokerSocketPath: join(root, 'unused.sock') };
const runtime = startServer(config, {
  fetchUpstream: async () => { observations.upstreamCalls++; return new Response('offline probe denies upstream', { status: 403 }); },
  adapterFactory: () => ({ name: 'forbidden-in-retirement-probe', async runTurn() { observations.adapterCalls++; throw new Error('adapter must not start'); } }),
});
const base = 'http://127.0.0.1:' + runtime.port;
console.error('PROBE_PHASE '+JSON.stringify({phase:'server-started',pid:process.pid,port:runtime.port}));
const headers = { authorization: 'Bearer ' + config.controlToken, 'content-type': 'application/json' };
const health = async (stage: string) => {
  console.error('PROBE_HEALTH_START '+stage);
  if(output) writeFileSync(output+'.phase.json', JSON.stringify({probePhase:'health-'+stage,observations}));
  const h = await (await fetch(base + '/healthz')).json() as any;
  observations.samples.push({ stage, activeHttp: h.active_http_turns, activeBrowser: h.active_browser_turns,
    accepting: h.accepting_turns, physicalSettled: settled, rss: process.memoryUsage().rss });
};
try {
  chatGptTurnSessions.getOrCreate('overnight-retirement', () => ({ mode: 'read-only', browser,
    physicalSettlement, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => { observations.cancelCalls++; settleBrowser('cancelled'); },
  }), 'overnight_retirement_trace', 'overnight_retirement_owner', 'overnight_turn_001', 'overnight_thread_001');
  await health('before-interrupt');
  console.error('PROBE_INTERRUPT_START');
  const interrupt = await fetch(base + '/admin/interrupt-turn', { method: 'POST', headers,
    body: JSON.stringify({ threadId: 'overnight_thread_001', turnId: 'overnight_turn_001' }) });
  observations.interrupt = { status: interrupt.status, body: await interrupt.json() };
  await health('interrupted-physical-pending');
  console.error('PROBE_DRAIN_START');
  const drain = await fetch(base + '/admin/drain', { method: 'POST', headers });
  observations.drain = { status: drain.status, body: await drain.json(), physicalSettled: settled };
  await health('draining-physical-pending');
  observations.registryFindAfterCancel = Boolean(chatGptTurnSessions.find('overnight-retirement'));
  // Directly observe the already tracked retirement; do not call shutdown while cleanup is pending.
  let retirementDone = false;
  const retirement = chatGptTurnSessions.waitForRetirement('overnight-retirement').then(() => { retirementDone = true; });
  await new Promise(r => setTimeout(r, 30)); observations.retirementResolvedBeforeRelease = retirementDone;
  settlePhysical(); await retirement;
  await health('after-physical-release');
  observations.retirementResolvedAfterRelease = retirementDone;
} catch (error) { observations.probeError = String(error); }
finally {
  settleBrowser('cleanup'); settlePhysical(); await physicalSettlement;
  chatGptTurnSessions.clear();
  console.error('PROBE_STOP_START');
  if(output) writeFileSync(output+'.phase.json', JSON.stringify({probePhase:'cleanup-before-stop',observations}));
  await runtime.stop(true);
  console.error('PROBE_STOP_DONE'); flushResponseState();
  for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal))
    if (!beforeSignals.get(signal)?.includes(listener)) process.removeListener(signal, listener);
  if (oldHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldHome;
  rmSync(root, { recursive: true, force: true }); observations.cleaned = true;
  if (output) writeFileSync(output, JSON.stringify(observations, null, 2) + '\n');
  console.log('OVERNIGHT_RETIREMENT ' + JSON.stringify(observations));
}
