// Synthetic loopback only: never reads or uses a live endpoint or credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const output = text => [{ type: 'message', content: [{ type: 'output_text', text }] }];
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const delta = frame({ type: 'response.output_text.delta', delta: 'MOL185 READY' });
const completed = { type: 'response.completed', response: { status: 'completed', output: output('MOL185 READY') } };
const cases = [
  ['json', JSON.stringify({ status: 'completed', output: output('MOL185 READY') }), 'completed'],
  ['sse', delta + frame(completed), 'completed'],
  ['sse', delta + `data: ${JSON.stringify(completed)}`, 'eof_partial_frame'],
  ['sse', delta + frame({ ...completed, response: { status: 'failed', output: output('MOL185 READY') } }), 'contradictory_terminal_status'],
  ['sse', delta + frame({ ...completed, response: { status: 'completed', output: output('different terminal answer') } }), 'completed_but_marker_mismatch'],
  ['sse-disconnect', frame({ type: 'response.created' }), 'client_disconnected_upstream_state_unknown'],
];

for (const [mode, body, expected] of cases) {
  test(`mock-only canary ${mode}: ${expected}`, { timeout: 10_000 }, async () => {
    let requests = 0;
    const server = http.createServer(async (req, res) => {
      for await (const _ of req) {}
      requests += 1;
      res.writeHead(200, { 'content-type': mode === 'json' ? 'application/json' : 'text/event-stream' });
      res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const child = spawn(process.execPath, ['docs/mol185-evidence/live-canary.mjs', mode], {
        env: {
          ...process.env,
          MOL185_LIVE_AUTHORIZED: 'yes', MOL185_EXPECTED_SHA: sha, MOL185_VERIFIED_DEPLOYED_SHA: sha,
          MOL185_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
          MOL185_EXISTING_TOKEN: 'synthetic-local-fixture-only', MOL185_MODEL: 'test-model', MOL185_ROUTE_KIND: 'qa',
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      const exit = await new Promise(resolve => child.on('close', resolve));
      assert.equal(requests, 1);
      assert.equal(exit, expected === 'completed' ? 0 : 1);
      assert.equal(JSON.parse(stdout).status, expected);
      assert.equal(`${stdout}${stderr}`.includes('synthetic-local-fixture-only'), false);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
