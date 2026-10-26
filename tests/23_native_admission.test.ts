import { tmpdir } from "node:os";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createQaPool } from "../src/qa-pool";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { installReadyQaHealthFixture } from "./qa-pool-health-fixture";

const root = process.env.Q39_TEST_ROOT ?? mkdtempSync(join(tmpdir(), "native-admission-"));
afterAll(() => { if (!process.env.Q39_TEST_ROOT) rmSync(root, { recursive: true, force: true }); });
mkdirSync(root, {recursive: true});
const token = 'q39-synthetic-release-key-not-production';
const poolKey = 'q39-synthetic-pool-client-not-production';
function control(directory: string) {
  const tokenFile = join(directory, 'control.key'), stateFile = join(directory, 'fence.json');
  writeFileSync(tokenFile, token, {mode: 0o600});
  return {tokenFile, stateFile};
}
async function admin(origin: string, action = 'status') {
  const response = await fetch(origin+'/admin/release/'+action, {method: action === 'status' ? 'GET' : 'POST', headers: {authorization: 'Bearer '+token}});
  expect(response.status).toBe(200); return response.json();
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(10); }
  throw Error('Native lifecycle did not settle');
}

describe('pool native admission', () => {
  installReadyQaHealthFixture();

  test('fences dispatch but preserves receipt join, detached completion and current DB', async () => {
    const directory = mkdtempSync(join(root, 'pool-'));
    const keyFile = join(directory, 'client.key'); writeFileSync(keyFile, poolKey);
    const releaseControl = control(directory);
    let dispatches = 0;
    const pending: ReadableStreamDefaultController<Uint8Array>[] = [];
    const bytes = new TextEncoder();
    const backend = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: async request => {
      await request.json(); dispatches++;
      return new Response(new ReadableStream<Uint8Array>({start(controller) {
        pending.push(controller); controller.enqueue(bytes.encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
      }}), {headers: {'content-type': 'text/event-stream'}});
    }});
    const config = {host: '127.0.0.1', port: 0, databasePath: join(directory, 'sessions.sqlite'), releaseControl,
      clients: [{id: 'synthetic', keyFile}], accounts: [{id: 'qa2', origin: 'http://127.0.0.1:'+backend.port, models: ['synthetic'], sessionModes: true}]};
    let pool = createQaPool(config);
    let listener = Bun.serve({hostname: config.host, port: 0, fetch: pool.fetch});
    let origin = 'http://127.0.0.1:'+listener.port;
    const payload = (turn: string, input = 'fixture') => ({model: 'synthetic', input, stream: true, reasoning: {effort: 'high-temporary'},
      client_metadata: {'x-codex-turn-metadata': JSON.stringify({thread_id: 'fixture-'+turn, turn_id: turn})}});
    const post = (value: unknown, signal?: AbortSignal) => fetch(origin+'/v1/responses', {method: 'POST', headers: {authorization: 'Bearer '+poolKey, 'content-type': 'application/json'}, body: JSON.stringify(value), signal});
    const finish = (controller: ReadableStreamDefaultController<Uint8Array>, id: string) => {
      controller.enqueue(bytes.encode('event: response.completed\ndata: '+JSON.stringify({type: 'response.completed', response: {id, status: 'completed', output: []}})+'\n\n')); controller.close();
    };
    const first = post(payload('one')).then(r => r.text());
    await until(async () => dispatches === 1);
    const drained = await admin(origin, 'drain');
    expect(drained.accepting_new).toBe(false); expect(drained.pending_dispatches).toBe(1); expect(drained.safe_to_stop).toBe(false);
    expect(() => pool.close()).toThrow('not drained');
    expect((await fetch(origin+'/admin/release/seal',{method:'POST',headers:{authorization:'Bearer '+token}})).status).toBe(409);
    const blocked = await post(payload('new')); expect(blocked.status).toBe(503); await blocked.text();
    const duplicate = post(payload('one')).then(r => r.text());
    await Bun.sleep(30); expect(dispatches).toBe(1);
    finish(pending.shift()!, 'resp_one');
    expect(await first).toContain('resp_one'); expect(await duplicate).toContain('resp_one');
    const conflict = await post(payload('one', 'conflict')); expect(conflict.status).toBe(409); await conflict.text();
    await until(async () => (await admin(origin)).safe_to_stop);
    expect((await admin(origin, 'seal')).phase).toBe('sealed');
    expect((await post(payload('one'))).status).toBe(503);
    pool.close(); await listener.stop();
    // Same CURRENT SQLite, new listener owner; sticky admission survives replacement.
    pool = createQaPool(config); listener = Bun.serve({hostname: config.host, port: 0, fetch: pool.fetch}); origin = 'http://127.0.0.1:'+listener.port;
    expect((await admin(origin)).accepting_new).toBe(false);
    expect((await post(payload('one'))).status).toBe(503);
    await admin(origin, 'resume');
    expect(await (await post(payload('one'))).text()).toContain('resp_one'); expect(dispatches).toBe(1);
    const disconnected = new AbortController();
    const lost = post(payload('lost'), disconnected.signal).then(r => r.text()).catch(() => 'disconnected');
    await until(async () => dispatches === 2); disconnected.abort(); await lost;
    await admin(origin, 'drain');
    expect((await admin(origin)).safe_to_stop).toBe(false);
    finish(pending.shift()!, 'resp_lost');
    const recovered = await post(payload('lost')); expect(await recovered.text()).toContain('resp_lost'); expect(dispatches).toBe(2);
    await until(async () => (await admin(origin)).safe_to_stop);
    pool.close(); await listener.stop(); await backend.stop();
    writeFileSync(join(directory, 'result.json'), JSON.stringify({passed: true, dispatches, expectedInitialDispatches: 2, duplicateExtraDispatch: 0, currentDatabase: config.databasePath}));
  }, 15000);
});

test('native MCP fences new work, retains session/receipts, joins long-poll duplicates and retires only completed handles', async () => {
  const directory = mkdtempSync(join(root, 'mcp-'));
  const releaseControl = control(directory);
  const directoryFd = openSync(directory, 'r');
  const brokerSocketPath = `/proc/${process.pid}/fd/${directoryFd}/b.sock`;
  const broker = TurnBroker.forSocket(brokerSocketPath);
  const environment = {cwd: directory, roots: [directory], writableRoots: [], sandboxPolicy: {type: 'readOnly' as const, networkAccess: false},
    tools: [{name: 'exec_command', description: 'synthetic', parameters: {type: 'object' as const, properties: {cmd: {type: 'string'}}}},
            {name: 'write_stdin', description: 'synthetic continuation', parameters: {type: 'object' as const, properties: {session_id: {type: 'number'}}}}]};
  const turn = await broker.register(environment);
  let server = startChatGptMcpHttpServer({brokerSocketPath, releaseControl, port: 0});
  let origin = server.url.origin;
  const headers = {'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'};
  const rpc = (message: object, session?: string, signal?: AbortSignal) => fetch(origin+'/mcp', {method: 'POST', headers: {...headers, ...(session ? {'mcp-session-id': session} : {})}, body: JSON.stringify(message), signal});
  const initialize = {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'q39', version: '1'}}};
  const init = await rpc(initialize); const session = init.headers.get('mcp-session-id')!; expect(init.status).toBe(200); await init.text();
  const command = {jsonrpc: '2.0', id: 17, method: 'tools/call', params: {name: 'codex_exec', arguments: {turn_token: turn, cmd: 'synthetic-held'}}};
  const lost = new AbortController(); const initial = rpc(command, session, lost.signal).then(r => r.json()).catch(() => ({disconnected: true}));
  const [exec] = await broker.nextToolBatch(turn);
  expect(exec!.wireName).toBe('exec_command');
  const duplicate = rpc(command, session).then(r => r.json());
  await admin(origin, 'drain');
  expect((await admin(origin)).active_tool_calls).toBe(1);
  await expect(server.close()).rejects.toThrow('not drained');
  const rejected = await rpc({...command, id: 18}, session); expect(rejected.status).toBe(503); await rejected.text();
  // Protocol reconnection remains possible for accepted work; it grants no new command admission.
  const reconnect = await rpc(initialize); expect(reconnect.status).toBe(200);
  const reconnectSession = reconnect.headers.get('mcp-session-id')!; await reconnect.text();
  const rejectedNew = await rpc({...command, id: 18}, reconnectSession); expect(rejectedNew.status).toBe(503); await rejectedNew.text();
  const closeReconnect = await fetch(origin+'/mcp', {method: 'DELETE', headers: {...headers, 'mcp-session-id': reconnectSession}});
  expect(closeReconnect.status).toBe(200); await closeReconnect.text();
  lost.abort(); await initial;
  broker.completeTool(turn, exec!.callId, {content: [{type: 'text', text: JSON.stringify({session_id: 41, output: 'still running'})}]});
  expect((await duplicate).result.content[0].text).toContain('41');
  const replay = await rpc(command, session); expect((await replay.json()).result.content[0].text).toContain('41');
  expect((await admin(origin)).native_continuations).toBe(1);
  const earlyDelete = await fetch(origin+'/mcp', {method: 'DELETE', headers: {...headers, 'mcp-session-id': session}});
  expect(earlyDelete.status).toBe(409); await earlyDelete.text();
  const poll = {jsonrpc: '2.0', id: 19, method: 'tools/call', params: {name: 'codex_write_stdin', arguments: {turn_token: turn, session_id: 41, chars: '', yield_time_ms: 250}}};
  const waiting = rpc(poll, session).then(r => r.json());
  const [read] = await broker.nextToolBatch(turn); expect(read!.wireName).toBe('write_stdin');
  const pollDuplicate = rpc(poll, session).then(r => r.json());
  await Bun.sleep(40); expect((await admin(origin)).active_tool_calls).toBe(1);
  broker.completeTool(turn, read!.callId, {content: [{type: 'text', text: JSON.stringify({exit_code: 0, output: 'done'})}]});
  expect((await waiting).result.content[0].text).toContain('done'); expect((await pollDuplicate).result.content[0].text).toContain('done');
  const deleted = await fetch(origin+'/mcp', {method: 'DELETE', headers: {...headers, 'mcp-session-id': session}}); expect(deleted.status).toBe(200); await deleted.text();
  // Closing the MCP observer does not finish the accepted native turn. Its owner must
  // commit browser completion before the durable release inventory can be drained.
  expect((await admin(origin)).durable_live_turns).toBe(1);
  const completion = broker.beginCompletionFence(turn);
  expect(typeof completion).toBe('number');
  expect(broker.commitCompletionFence(turn, completion!)).toBe(true);
  broker.revoke(turn);
  await until(async () => (await admin(origin)).safe_to_stop);
  expect((await admin(origin, 'seal')).phase).toBe('sealed');
  await server.close();
  const fence = readFileSync(releaseControl.stateFile, 'utf8');
  server = startChatGptMcpHttpServer({brokerSocketPath, releaseControl, port: 0}); origin = server.url.origin;
  const stale = await rpc(command, session); expect(stale.status).toBe(503); await stale.text();
  expect(readFileSync(releaseControl.stateFile, 'utf8')).toBe(fence);
  await admin(origin, 'resume'); expect((await rpc(command, session)).status).toBe(404); const fresh = await rpc(initialize); expect(fresh.status).toBe(200); const freshSession = fresh.headers.get('mcp-session-id')!; expect(freshSession).not.toBe(session); await fresh.text();
  const closeFresh = await fetch(origin+'/mcp', {method: 'DELETE', headers: {...headers, 'mcp-session-id': freshSession}}); await closeFresh.text();
  await admin(origin, 'drain'); await until(async () => (await admin(origin)).safe_to_stop); await server.close();
  await broker.close(); closeSync(directoryFd);
  writeFileSync(join(directory, 'result.json'), JSON.stringify({passed: true, syntheticNativeCalls: 2, duplicateExtraDispatch: 0, staleSessionStatus: 404, freshSession: true}));
}, 15000);
