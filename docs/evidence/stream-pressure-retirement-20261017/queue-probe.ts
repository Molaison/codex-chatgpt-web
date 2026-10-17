import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const scenario = process.argv[2] ?? 'count';
if (!['count', 'count-json', 'bytes'].includes(scenario)) throw new Error('scenario must be count, count-json or bytes');
const stream = scenario !== 'count-json';
const output = process.argv[3];
const root = mkdtempSync(join(tmpdir(), 'overnight-queue-'));
const oldHome = process.env.CODEX_CHATGPT_WEB_HOME;
process.env.CODEX_CHATGPT_WEB_HOME = root;
const beforeSignals = new Map(['SIGINT', 'SIGTERM'].map(s => [s, process.listeners(s)]));
const { defaultConfig } = await import('./src/config');
const { startServer } = await import('./src/server');
const { flushResponseState } = await import('./src/responses/state');
const count = scenario === 'bytes' ? 256 : 10001;
const size = scenario === 'bytes' ? 32 * 1024 : 256;
const observations: any = { scenario, platform: process.platform, bun: Bun.version, revision: Bun.revision,
  inputs: { count, bytesPerMessage: size, stream }, physicalModelSubmissions: 0,
  emitted: 0, emitErrors: [], unhandledRejections: [], upstreamCalls: 0, adapterCalls: 0,
  receivedBytes: 0, paused: false, resumed: false, samples: [], rssSamples: [], rssStart: process.memoryUsage().rss };
const startedAt = performance.now();
let phase = 'startup';
let releasePaused!: () => void;
const clientPaused = new Promise<void>(r => { releasePaused = r; });
let adapterDone!: () => void;
const adapterFinished = new Promise<void>(r => { adapterDone = r; });
const rejection = (reason: unknown) => { observations.unhandledRejections.push(String(reason)); };
process.on('unhandledRejection', rejection);
const config = { ...defaultConfig('browser-only'), port: 0, host: '127.0.0.1', solAvailable: false,
  conversationStoreDirectory: join(root, 'conversations'), brokerSocketPath: join(root, 'unused.sock') };
let runtime: ReturnType<typeof startServer> | undefined;
let req: http.ClientRequest | undefined;
let res: http.IncomingMessage | undefined;
let rssPeak = observations.rssStart;
let throttleActive = false;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
const resumeRateBytesPerSecond = 8 * 1024 * 1024;
const sampleRss = () => {
  const rss = process.memoryUsage().rss;
  rssPeak = Math.max(rssPeak, rss);
  observations.rssSamples.push({ elapsedMs: Math.round(performance.now() - startedAt), phase, rss,
    receivedBytes: observations.receivedBytes });
};
const sampler = setInterval(sampleRss, 25);
const bounded = async <T>(promise: Promise<T>, ms = 12000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('probe deadline')), ms); })]); }
  finally { clearTimeout(timer!); }
};
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
try {
  runtime = startServer(config, {
    fetchUpstream: async () => { observations.upstreamCalls++; return new Response('offline probe denies upstream', { status: 403 }); },
    adapterFactory: () => ({ name: 'ordinary-http-queue-probe', async runTurn(_parsed, incoming, emit) {
      observations.adapterCalls++;
      try {
        // Count case intentionally bursts before bridge startup. Bytes case waits until the
        // real TCP client has paused its IncomingMessage after receiving HTTP headers.
        if (scenario === 'bytes') await clientPaused;
        for (let n = 0; n < count; n++) {
          if (incoming.abortSignal.aborted) { observations.adapterAborted = true; break; }
          try { emit({ type: 'text_delta', text: 'x'.repeat(size), phase: 'final_answer' }); observations.emitted++; }
          catch (error) { observations.emitErrors.push({ index: n, error: String(error) }); throw error; }
          if (scenario === 'bytes') await new Promise<void>(r => setImmediate(r));
        }
        emit({ type: 'done', stopReason: 'stop', endTurn: true,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true } });
        observations.doneEmitted = true;
      } finally { adapterDone(); }
    } }),
  });
  const base = 'http://127.0.0.1:' + runtime.port;
  const health = async (stage: string) => {
    const response = await fetch(base + '/healthz');
    const h = await response.json() as any;
    observations.samples.push({ stage, activeHttp: h.active_http_turns, activeBrowser: h.active_browser_turns,
      accepting: h.accepting_turns, rss: process.memoryUsage().rss, pid: h.pid });
  };
  await health('before');
  let text = '';
  phase = 'awaiting-headers';
  const completed = new Promise<void>((resolve, reject) => {
    req = http.request(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      res = response; observations.httpStatus = response.statusCode;
      response.on('data', chunk => {
        observations.receivedBytes += chunk.length; text += chunk.toString();
        if (throttleActive) {
          response.pause();
          observations.throttledChunks = (observations.throttledChunks ?? 0) + 1;
          resumeTimer = setTimeout(() => response.resume(), Math.max(1, Math.ceil(chunk.length / resumeRateBytesPerSecond * 1000)));
        }
      });
      response.once('end', resolve); response.once('error', reject);
      response.pause(); observations.paused = true;
      phase = 'paused';
      observations.pauseAt = Date.now(); observations.bytesAtPause = observations.receivedBytes;
      releasePaused();
    });
    req.once('error', reject);
    req.end(JSON.stringify({ model: 'chatgpt-web/gpt-5.6-luna', input: 'offline ordinary HTTP queue probe', stream }));
  });
  await bounded(clientPaused);
  await bounded(adapterFinished);
  const pauseDurationMs = scenario === 'bytes' ? 3000 : 250;
  // Measure pause from the actual IncomingMessage.pause() call, not from adapter completion.
  await delay(Math.max(0, observations.pauseAt + pauseDurationMs - Date.now()));
  observations.bytesWhilePaused = observations.receivedBytes - observations.bytesAtPause;
  observations.adapterFinishedWhilePaused = true;
  observations.responseReadableLengthWhilePaused = res!.readableLength;
  await health('paused-after-adapter');
  throttleActive = scenario === 'bytes';
  observations.resumeRateBytesPerSecond = throttleActive ? resumeRateBytesPerSecond : null;
  phase = 'reading';
  res!.resume(); observations.resumed = true; observations.resumeAt = Date.now();
  await bounded(completed);
  await delay(30);
  const frames = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => { try { return JSON.parse(line.slice(6)); } catch { return {}; } });
  observations.terminalTypes = frames.filter(e => ['response.completed', 'response.failed', 'response.incomplete'].includes(e.type)).map(e => e.type);
  observations.doneSentinels = text.split('data: [DONE]').length - 1;
  observations.errorFrames = frames.filter(e => e.type === 'error' || e.type === 'response.failed').map(e => ({ type: e.type, error: e.error ?? e.response?.error }));
  let finalResponse: any;
  if (stream) finalResponse = frames.findLast(e => ['response.completed', 'response.failed', 'response.incomplete'].includes(e.type))?.response;
  else {
    try {
      finalResponse = JSON.parse(text);
      observations.jsonResponse = { status: finalResponse.status, error: finalResponse.error };
      observations.terminalTypes = ['completed', 'failed', 'incomplete'].includes(finalResponse.status) ? ['response.' + finalResponse.status] : [];
    } catch { observations.nonJsonResponsePreview = text.slice(0, 300); }
  }
  observations.terminalCount = observations.terminalTypes.length;
  if (scenario === 'bytes') {
    const finalText = typeof finalResponse?.output_text === 'string' ? finalResponse.output_text
      : Array.isArray(finalResponse?.output) ? finalResponse.output.flatMap((item: any) =>
        Array.isArray(item.content) ? item.content.filter((part: any) => typeof part.text === 'string').map((part: any) => part.text) : []).join('') : undefined;
    const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const expectedSha256 = hash('x'.repeat(count * size));
    const actualSha256 = finalText === undefined ? null : hash(finalText);
    observations.finalText = { expectedBytes: count * size, actualBytes: finalText === undefined ? null : Buffer.byteLength(finalText),
      expectedSha256, actualSha256, matches: actualSha256 === expectedSha256 };
  }
  phase = 'parsed'; sampleRss();
  observations.processAlive = true;
  await health('after-read');
} catch (error) { observations.probeError = String(error); observations.processAlive = true; }
finally {
  phase = 'cleanup';
  if (resumeTimer) clearTimeout(resumeTimer);
  releasePaused(); req?.destroy(); res?.destroy();
  await runtime?.stop(true); flushResponseState(); clearInterval(sampler);
  for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal))
    if (!beforeSignals.get(signal)?.includes(listener)) process.removeListener(signal, listener);
  process.removeListener('unhandledRejection', rejection);
  sampleRss(); observations.rssPeak = Math.max(rssPeak, process.memoryUsage().rss); observations.cleaned = true;
  if (oldHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
  if (output) writeFileSync(output, JSON.stringify(observations, null, 2) + '\n');
  console.log('OVERNIGHT_QUEUE ' + JSON.stringify(observations));
}
