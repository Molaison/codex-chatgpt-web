// Offline CPU fault injection. Only loopback TCP, private Unix sockets, and synthetic keys.
// Run: node --test tests/cpr-provider-transport.test.mjs (Node 24, as deployed).
// Cloud transport substitute: CPR_PROVIDER_TEST_TCP=1 node --test tests/cpr-provider-transport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const script = fileURLToPath(new URL('../deploy/cpr-provider.mjs', import.meta.url));
const key = 'synthetic-offline-transport-test-key';
// Restricted cloud executors may deny AF_UNIX. This opt-in changes only listen transport;
// production request handling and stream forwarding remain unchanged. AF_UNIX is then unverified.
const tcpAdapter = process.env.CPR_PROVIDER_TEST_TCP === '1';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

function request(socketPath, model, name, onData = () => {}) {
  return new Promise(resolve => {
    const started = performance.now();
    let body = '', status, settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({outcome, status, body, elapsedMs: Math.round(performance.now() - started)});
    };
    const address = typeof socketPath === 'number' ? {hostname: '127.0.0.1', port: socketPath} : {socketPath};
    const req = http.request({...address, path: '/v1/responses', method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json',
    }}, res => {
      status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; onData(chunk); });
      res.on('aborted', () => finish('aborted'));
      res.on('error', () => finish('error'));
      res.on('end', () => finish('end'));
    });
    req.on('error', () => finish('error'));
    const timer = setTimeout(() => { finish('timeout'); req.destroy(); }, 2000);
    req.end(JSON.stringify({model, stream: true, input: name, metadata: {faultCase: name}}));
  });
}

for (const mode of ['qa', 'full']) {
  test(`${mode}: partial SSE upstream reset terminates only that response without replay`,
    {skip: process.platform === 'win32', timeout: 10000}, async () => {
      const root = mkdtempSync(join(tmpdir(), 'cpr-fault-'));
      const model = mode === 'full' ? 'test-model-tools' : 'test-model';
      const calls = [];
      const createdFrames = new Map();
      const eventMetadata = {model: 'test-model', note: 'literal test-model must stay unchanged'};
      const fault = deferred(), sibling = deferred(), firstFaultChunk = deferred();
      const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        const name = payload.metadata.faultCase;
        calls.push(name);
        res.writeHead(200, {'content-type': 'text/event-stream'});
        const createdFrame = `data: ${JSON.stringify({type: 'response.created', response: {id: name, model: payload.model, metadata: eventMetadata}})}\n\n`;
        createdFrames.set(name, createdFrame);
        res.write(createdFrame);
        if (name === 'fault') {
          // Include an incomplete event to exercise the Full alias Transform's buffered tail.
          res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial');
          fault.resolve(res);
        } else if (name === 'sibling') {
          sibling.resolve(res);
        } else {
          res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n');
        }
      });
      let child, stderr = '';
      try {
        upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
        mkdirSync(join(root, 'cpr'));
        writeFileSync(join(root, 'config.json'), JSON.stringify({mode, port: upstream.address().port, storageStatePath: join(root, 'state')}));
        writeFileSync(join(root, 'provider.key'), key);
        writeFileSync(join(root, 'models.json'), JSON.stringify({models: [{slug: 'test-model'}]}));
        writeFileSync(join(root, 'state.verified.json'), '{}');
        const socketPath = join(root, 'cpr', 'provider.sock');
        const portFile = join(root, 'listen-port.json');
        const preload = join(root, 'tcp-listener.mjs');
        if (tcpAdapter) writeFileSync(preload, `
          import http from 'node:http';
          import {writeFileSync} from 'node:fs';
          const original = http.Server.prototype.listen;
          http.Server.prototype.listen = function (...args) {
            if (args[0] !== ${JSON.stringify(socketPath)}) return original.apply(this, args);
            const callback = args[1];
            // chmod stays real and touches only this disposable synthetic file.
            writeFileSync(${JSON.stringify(socketPath)}, 'test listener placeholder');
            return original.call(this, 0, '127.0.0.1', () => {
              writeFileSync(${JSON.stringify(portFile)}, JSON.stringify(this.address().port));
              callback?.();
            });
          };
        `);
        child = spawn(process.env.CPR_PROVIDER_NODE || process.execPath,
          [...(tcpAdapter ? ['--import', preload] : []), script, root], {stdio: ['ignore', 'ignore', 'pipe']});
        child.stderr.on('data', chunk => { stderr += chunk; });
        for (let i = 0; !existsSync(tcpAdapter ? portFile : socketPath); i++) {
          assert.ok(i < 100 && child.exitCode === null, `provider startup failed: ${stderr}`);
          await sleep(20);
        }
        const address = tcpAdapter ? JSON.parse(readFileSync(portFile, 'utf8')) : socketPath;
        const failing = request(address, model, 'fault', () => firstFaultChunk.resolve());
        const peer = request(address, model, 'sibling');
        const [faultResponse, siblingResponse] = await Promise.all([fault.promise, sibling.promise]);
        await firstFaultChunk.promise; // Prove headers/partial bytes reached the downstream first.
        faultResponse.destroy();
        await sleep(30);
        siblingResponse.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n');
        const [failed, healthy] = await Promise.all([failing, peer]);
        const subsequent = await request(address, model, 'after');
        const evidence = {mode, listenerTransport: tcpAdapter ? 'test-only-loopback-tcp; AF_UNIX unverified' : 'AF_UNIX', failed, healthy, subsequent, calls, exitCode: child.exitCode, stderr};
        console.log(JSON.stringify(evidence));
        for (const [name, result] of [['fault', failed], ['sibling', healthy], ['after', subsequent]]) {
          const event = JSON.parse(result.body.split('\n')[0].slice('data: '.length));
          assert.equal(event.response.model, model, `${mode} public model identity for ${name}`);
          assert.deepEqual(event.response.metadata, eventMetadata, `${mode} metadata must not be aliased`);
          if (mode === 'qa') assert.ok(result.body.startsWith(createdFrames.get(name)), 'QA event bytes stay unchanged');
        }
        assert.deepEqual({
          providerAlive: child.exitCode === null && child.signalCode === null,
          failedClosed: ['aborted', 'error'].includes(failed.outcome),
          noFakeCompletion: !failed.body.includes('response.completed') && !failed.body.includes('[DONE]'),
          siblingCompleted: healthy.outcome === 'end' && healthy.body.includes('[DONE]'),
          subsequentCompleted: subsequent.outcome === 'end' && subsequent.body.includes('[DONE]'),
          exactlyOnce: calls.filter(name => name === 'fault').length === 1,
        }, {providerAlive: true, failedClosed: true, noFakeCompletion: true,
          siblingCompleted: true, subsequentCompleted: true, exactlyOnce: true}, JSON.stringify(evidence));
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
        rmSync(root, {recursive: true, force: true});
      }
    });
}
