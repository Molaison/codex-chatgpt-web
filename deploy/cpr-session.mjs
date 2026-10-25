import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

const nonempty = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
// Preserve supplied transport IDs exactly; a newly generated ID must also reach the runtime header.
export const cprRequestId = headers => typeof headers['x-request-id'] === 'string' ? headers['x-request-id'] : randomUUID();
export function normalizeCprRequest(payload, headers, requestId = randomUUID(), mode = "browser-only") {
  const existing = payload.client_metadata;
  const metadata = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const native = metadata['x-codex-turn-metadata'] ?? headers['x-codex-turn-metadata'];
  let turnMetadata = native;
  if (native === undefined) {
    const session = nonempty(headers['thread-id']) ?? nonempty(headers['session-id'])
      ?? nonempty(headers.session_id) ?? nonempty(payload.session_id)
      ?? nonempty(payload.conversation_id) ?? nonempty(payload.prompt_cache_key);
    const thread = session ? 'cpr-session-' + createHash('sha256').update(session).digest('hex') : 'cpr-request-' + requestId;
    turnMetadata = JSON.stringify({thread_id: thread, turn_id: 'cpr-turn-' + requestId});
  }
  const normalized = {...payload, client_metadata: {...metadata, 'x-codex-turn-metadata': turnMetadata}};
  if (typeof normalized.input === 'string') normalized.input = [{type:'message',role:'user',content:[{type:'input_text',text:normalized.input}]}];
  if (Array.isArray(normalized.input)) normalized.input = normalized.input.map((item,index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const message = !item.type && typeof item.role === 'string' ? {...item,type:'message'} : item;
    // Native callers must retain missing IDs so the QA pool can reconcile a retry
    // or reject an ambiguous new instruction. A transport ID would hide omission.
    // Anonymous requests remain independent one-offs, including within a session.
    // Full retains its deployed per-request IDs; its accepted-history proof normalizes only these IDs.
    return (mode === "full" || native === undefined) && message.type === 'message' && message.role === 'user' && !message.id
      ? {...message,id:'cpr-message-'+requestId+'-'+index} : message;
  });
  return normalized;
}

const ref=value=>typeof value==='string'?createHash('sha256').update(value).digest('hex').slice(0,24):null;
const label=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$/.test(value)?value:null;

/** Only the account's local config may name a release record. Request metadata is not authority. */
export function cprProviderEvidence(config) {
  let manifest={};
  let manifestStatus='not_configured';
  if(config.releaseManifestPath){
    try {
      const parsed=JSON.parse(readFileSync(config.releaseManifestPath,'utf8'));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid release record');
      manifest=parsed;manifestStatus='loaded';
    } catch {manifestStatus='read_failed';}
  }
  return {
    schema_version:1,
    provider_instance:randomUUID(),
    service_invocation_ref:ref(process.env.INVOCATION_ID),
    account_ref:ref(config.accountId),
    runtime_target_ref:ref(`127.0.0.1:${config.port}`),
    release:{
      source:'local_release_manifest',status:manifestStatus,
      manifest_id:label(manifest.release_id),route_name:label(manifest.route_name),
      cpr_version:label(manifest.cpr_version),build_sha:label(manifest.build_sha),
      provider_name:label(manifest.provider_name),account_pool:label(manifest.account_pool),
      runtime_ref:ref(manifest.runtime_path),
    },
  };
}

export function cprEvidenceHeaders(evidence) {
  return {
    'x-cpr-provider-instance':evidence.provider_instance,
    'x-cpr-release-id':evidence.release.manifest_id??'unknown',
    'x-cpr-account-ref':evidence.account_ref??'unknown',
    'x-cpr-runtime-target-ref':evidence.runtime_target_ref,
  };
}

/** This is what the local backend actually returned, separate from a deployer's manifest claim. */
export function cprRuntimeEvidence(headers) {
  return {
    source:'runtime_response_headers',
    version:label(headers['x-codex-web-version']),
    instance:label(headers['x-codex-web-instance']),
    service_invocation_ref:label(headers['x-codex-web-invocation-ref']),
  };
}

export function cprReadinessEvidence(evidence, verifiedMarker) {
  const observed_at=new Date().toISOString();
  const unknown=source=>({status:'unknown',source,reason:'not_observed'});
  return {
    schema_version:1,provider_instance:evidence.provider_instance,observed_at,
    release:evidence.release,
    levels:{
      L0:{status:'ready',source:'provider_process',reason:'responding',observed_at},
      L1:{status:'partial',source:'local_provider_socket',reason:'upstream_route_not_probed',observed_at},
      L2:unknown('provider_pool'),
      L3:{status:verifiedMarker?'partial':'not_ready',source:'storage_verification_marker',
        reason:verifiedMarker?'marker_is_not_a_live_browser_probe':'sign_in_gate_closed',observed_at},
      L4:unknown('dated_authenticated_turn_canary'),
      L5:unknown('connector_tool_canary'),
    },
  };
}

const ERROR_EVIDENCE_MAX_BYTES=8192;
const errorCode=value=>Number.isSafeInteger(value)||typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(value)?value:undefined;

/** Project only small original JSON errors. No raw messages, body snapshots or credentials. */
export function cprOriginalErrorEvidence(body) {
  if(body.length>ERROR_EVIDENCE_MAX_BYTES)return;
  let parsed;
  try {parsed=JSON.parse(body.toString('utf8'));} catch {return;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return;
  const code=errorCode(parsed.code??parsed.error?.code);
  const type=errorCode(parsed.extError?.code??parsed.error?.type??parsed.type);
  const status=parsed.extError?.StatusCode;
  const requestRef=ref(parsed.requestId??parsed.request_id);
  const message=parsed.error?.message??parsed.message??parsed.msg;
  const noProvider=typeof message==='string'&&/^no upstream provider is currently available[.!]?$/i.test(message.trim());
  const evidence={
    ...(code!==undefined?{code}:{}),...(type!==undefined?{type}:{}),
    ...(Number.isInteger(status)&&status>=100&&status<=599?{status}:{}),
    ...(requestRef?{request_ref:requestRef}:{}),...(noProvider?{cause:'no_upstream_provider'}:{}),
  };
  if(Object.keys(evidence).length)return {source:'bounded_original_json',...evidence};
}

/** Observe the existing stream, never consume/replay it or buffer an oversized error. */
export function observeCprUpstreamError(response, accept) {
  if(response.statusCode!==503)return;
  const type=String(response.headers['content-type']??'').split(';')[0].trim().toLowerCase();
  if(type!=='application/json'&&!type.endsWith('+json'))return;
  if(String(response.headers['content-encoding']??'identity').toLowerCase()!=='identity'
    ||Number(response.headers['content-length'])>ERROR_EVIDENCE_MAX_BYTES)return;
  let bytes=0,chunks=[];
  const observe=chunk=>{
    bytes+=chunk.length;
    if(bytes>ERROR_EVIDENCE_MAX_BYTES){chunks=[];response.off('data',observe);return;}
    chunks.push(Buffer.from(chunk));
  };
  response.on('data',observe);
  response.once('end',()=>{
    response.off('data',observe);
    if(response.complete&&bytes<=ERROR_EVIDENCE_MAX_BYTES){
      const evidence=cprOriginalErrorEvidence(Buffer.concat(chunks));
      if(evidence)accept(evidence);
    }
    chunks=[];
  });
  response.once('close',()=>{chunks=[];});
}

export function cprFailureEvidence(status, {forwarded=false,incomplete=false,upstreamError}={}) {
  const noProvider=status===503&&upstreamError?.source==='bounded_original_json'&&upstreamError.cause==='no_upstream_provider';
  return {
    category:status===520||incomplete?'transport_incomplete':status===503
      ?noProvider?'route_or_provider_unavailable':forwarded?'upstream_error':'local_admission_error'
      :status>=500?'runtime_transport_error':'http_error',
    ...(status===503?{classification:noProvider?'confirmed_original_error':'unclassified',
      cause:noProvider?'no_upstream_provider':'http_503'}:{}),
    ...(upstreamError?{upstream_error:upstreamError}:{}),
    downstream_dispatch:forwarded?'unknown':'not_dispatched',
    retryable:false,
    recovery:forwarded?'needs_reconcile':'none',
    route_fallback:'not_attempted',
  };
}

export function cprRequestEvidence(requestId, evidence) {
  return {schema_version:1,request_ref:ref(requestId),...evidence};
}
