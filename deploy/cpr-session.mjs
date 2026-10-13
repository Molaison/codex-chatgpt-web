import {createHash, randomUUID} from 'node:crypto';

const nonempty = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
export function normalizeCprRequest(payload, headers, requestId = randomUUID()) {
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
    return message.type === 'message' && message.role === 'user' && !message.id
      ? {...message,id:'cpr-message-'+requestId+'-'+index} : message;
  });
  return normalized;
}
