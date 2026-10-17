// One explicitly authorized, inert real-route request. Never retries or changes setup.
// Credentials are read only from the existing process environment and never printed.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

async function main() {
  if (process.env.MOL185_LIVE_AUTHORIZED !== 'yes') {
    throw new Error('Blocked: dot must verify existing authorization and remaining call budget before setting MOL185_LIVE_AUTHORIZED=yes.');
  }
  const expected = required('MOL185_EXPECTED_SHA');
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('Expected SHA must be an exact 40-character commit.');
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (checkout !== expected) throw new Error('Checkout does not match the authorized candidate SHA.');
  // This declaration is not remote attestation: executor must independently check deployment.
  if (required('MOL185_VERIFIED_DEPLOYED_SHA') !== expected) throw new Error('Verified deployment SHA must match candidate.');
  const base = new URL(required('MOL185_BASE_URL'));
  if (base.username || base.password || base.search || base.hash) throw new Error('Base URL must not contain credentials, query or fragment.');
  if (!/\/v1\/?$/.test(base.pathname)) throw new Error('Base URL must end with /v1.');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) throw new Error('Use HTTPS or an approved loopback HTTP route.');
  const token = required('MOL185_EXISTING_TOKEN');
  const model = required('MOL185_MODEL');
  const route = required('MOL185_ROUTE_KIND');
  if (!['qa', 'full'].includes(route)) throw new Error('Route kind must be qa or full.');
  if (model.endsWith('-tools') !== (route === 'full')) throw new Error('Public model alias does not match route kind.');
  const mode = process.argv[2];
  if (!['json', 'sse', 'sse-disconnect'].includes(mode)) throw new Error('Usage: node docs/mol185-evidence/live-canary.mjs json|sse|sse-disconnect');
  const id = `mol185-${randomUUID()}`;
  const request = {
    model,
    stream: mode !== 'json',
    input: [{ type: 'message', role: 'user', id: `${id}-message`, content: [{ type: 'input_text', text: 'Do not call any tools. Reply with exactly: MOL185 READY' }] }],
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: `${id}-thread`, turn_id: `${id}-turn` }) },
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const started = performance.now();
  const report = { run_id: id, class: 'real-authenticated-route-canary', expected_sha: expected, route, mode, submissions: 0, retries: 0, first_event_ms: null, elapsed_ms: null, status: 'unknown', http_status: null, tool_execution_proven: false };
  let reader;
  try {
    report.submissions = 1;
    const response = await fetch(new URL(`${base.pathname.replace(/\/$/, '')}/responses`, base.origin), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': id },
      body: JSON.stringify(request),
    });
    report.http_status = response.status;
    if (!response.ok) { report.status = 'http_failure'; await response.body?.cancel(); return; }
    if (!response.body) { report.status = 'missing_body'; return; }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', bytes = 0, terminal = null, answer = '';
    let terminalCount = 0, framingFailure = null;
    const answerOf = result => (result.output ?? []).filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text ?? '').join('');
    const consumeSse = final => {
      const frames = text.split(/\r?\n\r?\n/);
      text = frames.pop();
      if (final && text.trim()) framingFailure = 'eof_partial_frame';
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        if (report.first_event_ms === null) report.first_event_ms = Math.round(performance.now() - started);
        let event;
        try { event = JSON.parse(data); } catch { framingFailure = 'invalid_sse_event'; continue; }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') answer += event.delta;
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
          terminalCount += 1;
          terminal = event.type.slice('response.'.length);
          if (event.response?.status !== terminal) framingFailure = 'contradictory_terminal_status';
          if (Array.isArray(event.response?.output)) answer = answerOf(event.response);
        }
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8 * 1024 * 1024) { report.status = 'size_limit_unknown'; controller.abort(); return; }
      text += decoder.decode(value, { stream: true });
      if (mode !== 'json') consumeSse(false);
      if (mode === 'sse-disconnect' && report.first_event_ms !== null) {
        report.status = 'client_disconnected_upstream_state_unknown';
        await reader.cancel();
        controller.abort();
        return;
      }
    }
    text += decoder.decode();
    if (mode === 'json') {
      const result = JSON.parse(text);
      report.status = ['completed', 'failed', 'incomplete'].includes(result.status) ? result.status : 'missing_terminal';
      answer = answerOf(result);
    } else {
      consumeSse(true);
      report.status = framingFailure ?? (terminalCount === 1 ? terminal : terminalCount > 1 ? 'multiple_terminal_events' : 'eof_without_terminal');
    }
    if (report.status === 'completed' && answer.trim() !== 'MOL185 READY') report.status = 'completed_but_marker_mismatch';
  } catch {
    // Never dump server bodies, raw exceptions, URLs, credentials, or model reasoning.
    report.status = controller.signal.aborted ? 'timeout_or_abort_upstream_state_unknown' : 'transport_or_parse_failure_upstream_state_unknown';
  } finally {
    clearTimeout(timeout);
    try { await reader?.cancel(); } catch {}
    report.elapsed_ms = Math.round(performance.now() - started);
    console.log(JSON.stringify(report));
    if (report.status !== 'completed') process.exitCode = 1;
  }
}

main().catch(error => {
  // Only local preflight errors reach here. No external response content is printed.
  console.error(error.message);
  process.exitCode = 2;
});
