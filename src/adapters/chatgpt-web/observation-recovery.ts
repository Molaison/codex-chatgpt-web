import { parseNativeSubmission, type NativeSubmissionRecord } from "./submission-identity";
import { ChatGptWebAdapterError } from "./adapter-error";
import { canonicalSavedChatUrl } from "./conversation-persistence";
import type { LauncherBrowserHostDescriptor } from "../../launcher-browser-host";

export interface BrowserObservationIdentity {
  operationId: string;
  executionKey: string;
  roundKey: string;
  threadId: string;
  turnId: string;
}

/** Private evidence for observing one accepted submission, never authority to dispatch. */
export interface BrowserObservationCheckpoint {
  version: 1 | 2;
  identity: BrowserObservationIdentity;
  traceId: string;
  modelId: string;
  accountId: string;
  appName: string;
  host: { pid: number; instanceId: string; profile: string; partition: string };
  lease: { helperPid: number; surfaceId: string; targetId: string };
  conversation: { key: string; url: string; claim: string };
  toolChannel?: { tokenHash: string };
  submission: {
    receipt?: string;
    native?: NativeSubmissionRecord;
    initialTurnIdentities: string[];
    acceptedUserIdentity: string;
    assistantIdentity: string;
    acceptedTurnIdentities: string[];
  };
}

export class BrowserObservationDetached extends Error {}

export function observationUnavailable(reason: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(`Read-only recovery is unavailable: ${reason}. The original execution remains retained; no message was sent.`, {
    status: 409, errorType: "server_error", code: "chatgpt_observation_unavailable", retryable: false,
  });
}

export function parseBrowserObservation(value: unknown): BrowserObservationCheckpoint {
  const c = value as BrowserObservationCheckpoint | undefined;
  const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 4096;
  const ids = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 10000 && x.every(text);
  if (!c || ![1, 2].includes(c.version) || !c.identity || !c.host || !c.lease || !c.conversation || !c.submission
    || !Object.values(c.identity).every(text) || Object.keys(c.identity).sort().join() !== "executionKey,operationId,roundKey,threadId,turnId"
    || ![c.traceId, c.modelId, c.accountId, c.appName, c.lease.targetId, c.conversation.key, c.conversation.claim].every(text)
    || !Number.isSafeInteger(c.host.pid) || c.host.pid < 1 || !Number.isSafeInteger(c.lease.helperPid) || c.lease.helperPid < 1
    || !/^[A-Za-z0-9_-]{32}$/.test(c.host.instanceId) || !/^[A-Za-z0-9_-]{32}$/.test(c.lease.surfaceId)
    || !["production", "development"].includes(c.host.profile)
    || c.host.partition !== (c.host.profile === "development" ? "persist:codex-web-gpt-dev-chatgpt" : "persist:codex-web-gpt-chatgpt")
    || (c.version === 1 ? !/^\[codex-submission:[0-9a-f-]{36}\]$/.test(c.submission.receipt ?? "") || c.submission.native !== undefined
      : c.submission.receipt !== undefined || !c.submission.native)
    || (c.toolChannel !== undefined && (!c.toolChannel || !/^[a-f0-9]{64}$/.test(c.toolChannel.tokenHash)))
    || !text(c.submission.acceptedUserIdentity) || !text(c.submission.assistantIdentity)
    || !ids(c.submission.initialTurnIdentities) || !ids(c.submission.acceptedTurnIdentities)
    || typeof c.conversation.url !== "string" || canonicalSavedChatUrl(c.conversation.url) !== c.conversation.url) {
    throw observationUnavailable("invalid checkpoint");
  }
  if (c.version === 2) {
    const native = parseNativeSubmission(c.submission.native);
    const conversationId = c.conversation.url.split("/c/")[1];
    if (native.phase !== "accepted" || !native.dom || c.toolChannel
      || native.binding && (native.binding.roundKey !== c.identity.roundKey || native.binding.stage.kind !== "final"
        || JSON.stringify(native.binding.host) !== JSON.stringify(c.host) || JSON.stringify(native.binding.lease) !== JSON.stringify(c.lease))
      || native.expectedConversationId !== undefined && native.expectedConversationId !== conversationId
      || native.post?.conversationId.presence === "value" && native.post.conversationId.value !== conversationId
      || native.dom.acceptedUserIdentity !== c.submission.acceptedUserIdentity
      || native.dom.assistantIdentity !== c.submission.assistantIdentity
      || JSON.stringify(native.initialTurnIdentities) !== JSON.stringify(c.submission.initialTurnIdentities)
      || JSON.stringify(native.dom.acceptedTurnIdentities) !== JSON.stringify(c.submission.acceptedTurnIdentities)) {
      throw observationUnavailable("native submission checkpoint identity differs from its durable witness");
    }
  }
  return c;
}

export function assertObservationHost(c: BrowserObservationCheckpoint, host: LauncherBrowserHostDescriptor): void {
  if (host.pid !== c.host.pid || host.observationInstanceId !== c.host.instanceId
    || host.profile !== c.host.profile || host.partition !== c.host.partition
    || host.surfaceTargets[c.lease.surfaceId] !== c.lease.targetId) {
    throw observationUnavailable("browser host, profile, partition or original lease changed");
  }
}

/** Consume the complete DOM stream, publishing only bytes beyond the durable response prefix. */
export function observationSuffix(prefix: string, publish: (delta: string) => void): { push(delta: string): void; finish(answer: string): void } {
  let consumed = 0;
  return {
    push(delta) {
      const overlap = Math.min(prefix.length - consumed, delta.length);
      if (delta.slice(0, overlap) !== prefix.slice(consumed, consumed + overlap)) {
        throw observationUnavailable("the accepted answer no longer matches its durable prefix");
      }
      consumed += overlap;
      if (delta.length > overlap) publish(delta.slice(overlap));
    },
    finish(answer) {
      if (consumed !== prefix.length || !answer.startsWith(prefix)) {
        throw observationUnavailable("the final answer does not contain its durable prefix");
      }
    },
  };
}
