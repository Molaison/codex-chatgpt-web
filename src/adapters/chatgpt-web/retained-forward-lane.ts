import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import { extractChatGptTurnIdentity } from "./environment";
import { chatGptConversationKey, chatGptQuestionAnswerNamespace } from "./conversation-key";

/** Private, inherited by the new daemon's helper; never read from HTTP metadata. */
export const RETAINED_FORWARD_POLICY_ENV = "CODEX_CHATGPT_WEB_RETAINED_FORWARD_POLICY";
export interface RetainedForwardPolicy {
  version: 1;
  accountId: string;
  descriptorPath: string;
  host: { pid: number; instanceId: string; profile: "production"; partition: "persist:codex-web-gpt-chatgpt" };
  allow: { threadId: string; turnId: string; intentSha256: string };
  deny: { threadIds: string[]; turnIds: string[]; traceIds: string[]; conversationKeys: string[];
    conversationUrls: string[]; surfaceIds: string[]; targetIds: string[] };
  /** Separate opt-in; a policy may restrict ingress without allowing any navigation. */
  navigateNewEmptySurface: boolean;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{64}$/;
export function retainedForwardRejected(): never {
  throw new ChatGptWebAdapterError("Private retained-forward policy rejected this request or surface; original executions remain retained.", {
    status: 409, errorType: "invalid_request_error", code: "chatgpt_retained_forward_rejected", retryable: false,
  });
}
function record(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function exact(v: unknown, keys: string[]): v is Record<string, any> {
  return record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
function strings(v: unknown, min = 1): v is string[] {
  return Array.isArray(v) && v.length >= min && v.length <= 4096
    && v.every(s => typeof s === "string" && s.length > 0 && s.length <= 4096)
    && new Set(v).size === v.length;
}
export function parseRetainedForwardPolicy(v: unknown): RetainedForwardPolicy {
  if (!exact(v, ["version", "accountId", "descriptorPath", "host", "allow", "deny", "navigateNewEmptySurface"])
    || v.version !== 1 || typeof v.accountId !== "string" || !v.accountId.trim()
    || typeof v.descriptorPath !== "string" || !isAbsolute(v.descriptorPath)
    || typeof v.navigateNewEmptySurface !== "boolean"
    || !exact(v.host, ["pid", "instanceId", "profile", "partition"])
    || !Number.isSafeInteger(v.host.pid) || v.host.pid < 1
    || typeof v.host.instanceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(v.host.instanceId)
    || v.host.profile !== "production" || v.host.partition !== "persist:codex-web-gpt-chatgpt"
    || !exact(v.allow, ["threadId", "turnId", "intentSha256"])
    || !uuid.test(v.allow.threadId) || !uuid.test(v.allow.turnId) || !sha.test(v.allow.intentSha256)
    || !exact(v.deny, ["threadIds", "turnIds", "traceIds", "conversationKeys", "conversationUrls", "surfaceIds", "targetIds"])
    || !["threadIds", "turnIds", "traceIds", "conversationKeys", "surfaceIds", "targetIds"].every(k => strings(v.deny[k]))
    || !strings(v.deny.conversationUrls, 0)
    || !v.deny.threadIds.every((s: string) => uuid.test(s)) || !v.deny.turnIds.every((s: string) => uuid.test(s))
    || !v.deny.conversationKeys.every((s: string) => sha.test(s))
    || v.deny.threadIds.includes(v.allow.threadId) || v.deny.turnIds.includes(v.allow.turnId)) return retainedForwardRejected();
  return structuredClone(v) as RetainedForwardPolicy;
}

// Freeze each process's admitted policy bytes. Reconfiguration requires a new isolated process.
const policyBytes = new Map<string, string>();
export function readRetainedForwardPolicy(): RetainedForwardPolicy | undefined {
  const path = process.env[RETAINED_FORWARD_POLICY_ENV];
  if (path === undefined) return undefined;
  if (!path || !isAbsolute(path)) return retainedForwardRejected();
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid?.() || st.size > 65536) return retainedForwardRejected();
    const bytes = readFileSync(fd, "utf8"), prior = policyBytes.get(path);
    if (prior !== undefined && prior !== bytes) return retainedForwardRejected();
    const policy = parseRetainedForwardPolicy(JSON.parse(bytes));
    policyBytes.set(path, bytes);
    return policy;
  } catch { return retainedForwardRejected(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** SHA-256 of the complete JSON wire body, sorted object keys; array order is significant. */
export function retainedForwardIntentDigest(body: unknown): string {
  function canonical(v: unknown): unknown {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(canonical);
    if (!record(v)) return retainedForwardRejected();
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  }
  if (!record(body)) return retainedForwardRejected();
  return createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
}

export function assertRetainedForwardRequest(provider: CodexProviderConfig, parsed: CodexParsedRequest,
  traceId?: string, policy = readRetainedForwardPolicy()): void {
  if (!policy) return;
  const cfg = provider.chatgptWeb;
  const raw = parsed._rawBody;
  const identity = extractChatGptTurnIdentity(parsed);
  if (!record(raw) || !cfg || cfg.browserHost !== "launcher" || cfg.browserInteractionMode === "manual"
    || cfg.accountId !== policy.accountId || !cfg.browserHostDescriptorPath
    || resolve(cfg.browserHostDescriptorPath) !== resolve(policy.descriptorPath)
    || identity.threadId !== policy.allow.threadId || identity.turnId !== policy.allow.turnId
    || policy.deny.threadIds.includes(identity.threadId) || policy.deny.turnIds.includes(identity.turnId)
    || traceId !== undefined && policy.deny.traceIds.includes(traceId)
    || parsed._chatgptLocalTools !== false || parsed._compactionRequest || parsed.previousResponseId
    || parsed._chatgptSavedConversationContinuation || parsed._chatgptObserverRoundKey
    || parsed.context.tools?.length || parsed.context.messages.some(m => !["user", "developer"].includes(m.role))
    || retainedForwardIntentDigest(raw) !== policy.allow.intentSha256) return retainedForwardRejected();
  const key = chatGptConversationKey(parsed, chatGptQuestionAnswerNamespace(cfg.accountId), { questionAnswer: true });
  if (!key || policy.deny.conversationKeys.includes(key)) return retainedForwardRejected();
  // Fresh canaries cannot smuggle a continuation through an otherwise digest-approved envelope.
  const metadata = raw.client_metadata;
  if (!record(metadata)) return retainedForwardRejected();
  let native: unknown;
  try { native = typeof metadata["x-codex-turn-metadata"] === "string"
    ? JSON.parse(metadata["x-codex-turn-metadata"]) : metadata["x-codex-turn-metadata"]; }
  catch { return retainedForwardRejected(); }
  if (!record(native) || native.thread_id !== identity.threadId || native.turn_id !== identity.turnId
    || identity.parentThreadId || native.forked_from_thread_id) return retainedForwardRejected();
  for (const envelope of [raw, metadata, native]) {
    if (Object.entries(envelope).some(([k, v]) => (/(?:conversation|previous_response|resume|observation)/i.test(k) && v != null)
      || typeof v === "string" && (policy.deny.conversationUrls.includes(v) || policy.deny.conversationKeys.includes(v)))) return retainedForwardRejected();
  }
}
