import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Page, Route } from "playwright-core";
import { rememberChatGptDownloadSource } from "./adapters/chatgpt-web/downloads";
import { chatGptQuestionAnswerKey, chatGptQuestionAnswerNamespace } from "./adapters/chatgpt-web/qa-conversation-key";
import { PaperError } from "./paper-registry";
import {
  connectLauncherBrowserHost, notifyLauncherTurn, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  type LauncherBrowserConnection,
} from "./launcher-browser-host";

export interface PaperRecoveryRead {
  accountId: string;
  sessionHash: string;
  browserHostDescriptorPath: string;
  conversationUrl: string;
  signal: AbortSignal;
}
export type PaperRecoveryReader = (request: PaperRecoveryRead) => Promise<unknown>;
export interface PaperRecoveryOptions {
  browserHostDescriptorPath: string;
  signal: AbortSignal;
  reader?: PaperRecoveryReader;
}
export interface PaperRecoveryExpected {
  conversationUrl: string;
  projectId: string;
  dispatchStartedAt: string;
  firstUpload: boolean;
  pdfSha256: string | null;
}
export interface PaperRecoveryEvidence {
  conversation_id: string;
  user_id: string;
  terminal_id: string;
  request_id: string;
  file_id: string | null;
  body_chars: number;
}

function reject(code: string, message: string): never {
  throw new PaperError("paper_recovery_" + code, message + "; the paper remains uncertain and no message was sent");
}
export function paperRecoveryIdentity(url: string): { projectId: string; conversationId: string } {
  const match = /^https:\/\/chatgpt\.com\/g\/(g-p-[a-f0-9]{32})\/c\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(url);
  if (!match) return reject("mapping_invalid", "A canonical saved project conversation URL is required");
  return { projectId: match[1]!, conversationId: match[2]! };
}

const messageSchema = z.object({
  id: z.string().min(1),
  author: z.object({ role: z.string() }),
  content: z.unknown(),
  create_time: z.number().finite().nonnegative().nullish(),
  channel: z.string().nullish(),
  recipient: z.string().nullish(),
  status: z.string().optional(),
  end_turn: z.boolean().nullish(),
  hidden: z.boolean().optional(),
  metadata: z.object({
    request_id: z.string().optional(),
    attachments: z.array(z.unknown()).optional(),
    hidden: z.boolean().optional(),
    is_hidden: z.boolean().optional(),
    is_visually_hidden_from_conversation: z.boolean().optional(),
    is_user_system_message: z.boolean().optional(),
    is_redacted: z.boolean().optional(),
  }).optional(),
});
const envelopeSchema = z.object({
  conversation_id: z.string().min(1),
  gizmo_id: z.string().min(1),
  is_temporary_chat: z.boolean(),
  async_status: z.unknown().refine(value => value !== undefined),
  messages: z.array(messageSchema).min(1),
  current_node: z.string().min(1),
  page_info: z.object({
    start_cursor: z.string().min(1),
    end_cursor: z.string().min(1),
    has_previous_page: z.boolean(),
    has_next_page: z.boolean(),
  }),
  context_truncation_continuation: z.unknown().refine(value => value !== undefined),
});
const textSchema = z.object({ content_type: z.literal("text"), parts: z.array(z.string()).min(1) });
const attachmentSchema = z.object({
  id: z.string().min(1), mime_type: z.literal("application/pdf"), size: z.number().int().positive(),
});
type NativeMessage = z.infer<typeof messageSchema>;
function visible(message: NativeMessage): boolean {
  const metadata = message.metadata;
  return !message.hidden && !metadata?.hidden && !metadata?.is_hidden
    && !metadata?.is_visually_hidden_from_conversation && !metadata?.is_user_system_message
    && !metadata?.is_redacted && (message.recipient == null || message.recipient === "all")
    && (message.channel == null || message.channel === "final" || message.channel === "commentary");
}

/** The saved GET supplies ordered messages on its active branch, not the old mapping tree.
 * Only identifiers and final-body length leave this validator; hidden content is never returned.
 */
export function validatePaperRecovery(value: unknown, expected: PaperRecoveryExpected): PaperRecoveryEvidence {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return reject("format_invalid", "Saved conversation is missing required recovery fields");
  const history = parsed.data, identity = paperRecoveryIdentity(expected.conversationUrl);
  if (identity.projectId !== expected.projectId || history.gizmo_id !== expected.projectId
    || history.conversation_id !== identity.conversationId) return reject("identity_mismatch", "Saved conversation or project does not match the original mapping");
  if (history.is_temporary_chat) return reject("temporary", "The conversation is not persistent");
  if (history.async_status !== null) return reject("running", "The saved conversation has an unresolved async status");
  const messages = history.messages, terminal = messages.at(-1)!;
  if (history.page_info.has_next_page || history.page_info.end_cursor !== history.current_node
    || terminal.id !== history.current_node || history.page_info.start_cursor !== messages[0]!.id
    || new Set(messages.map(message => message.id)).size !== messages.length) return reject("head_unverified", "Saved messages do not establish the current conversation head");
  const users = messages.filter(message => message.author.role === "user" && visible(message));
  const user = users.at(-1), dispatchAt = Date.parse(expected.dispatchStartedAt);
  if (!Number.isFinite(dispatchAt) || !user || user.create_time == null
    || !Number.isSafeInteger(Math.round(user.create_time * 1000))
    || user.create_time * 1000 <= dispatchAt) return reject("user_unverified", "No new user question is saved after this dispatch");
  const requestId = user.metadata?.request_id;
  if (!requestId?.trim() || terminal.metadata?.request_id !== requestId) return reject("turn_mismatch", "The final answer does not belong to the latest saved user request");
  if (terminal.author.role !== "assistant" || !visible(terminal) || terminal.channel !== "final"
    || terminal.status !== "finished_successfully" || terminal.end_turn !== true) return reject("terminal_unverified", "The current head is not a completed visible final answer");
  const content = textSchema.safeParse(terminal.content);
  if (!content.success) return reject("body_unverified", "The final answer has no verified text body");
  const text = content.data.parts.join("\n");
  if (!text.trim()) return reject("body_unverified", "The final answer is empty");
  let fileId: string | null = null;
  if (expected.firstUpload) {
    if (history.page_info.has_previous_page || history.context_truncation_continuation !== null) return reject("page_incomplete", "The first upload requires the complete saved conversation");
    if (!expected.pdfSha256 || !/^[a-f0-9]{64}$/.test(expected.pdfSha256)) return reject("pdf_unverified", "The original upload has no locally verified PDF hash");
    const originalUser = users[0]!, attachments = originalUser.metadata?.attachments;
    if (originalUser.create_time == null || originalUser.create_time * 1000 <= dispatchAt
      || attachments?.length !== 1) return reject("pdf_unverified", "The original dispatched user message must retain exactly one PDF attachment");
    const attachment = attachmentSchema.safeParse(attachments[0]);
    if (!attachment.success) return reject("pdf_unverified", "The saved attachment is not a verified PDF file record");
    fileId = attachment.data.id;
  }
  return { conversation_id: history.conversation_id, user_id: user.id, terminal_id: terminal.id,
    request_id: requestId, file_id: fileId, body_chars: text.length };
}

/** Page routes block writes and known downloads during navigation. Service-worker traffic
 * is outside Playwright page routing; this reader itself only observes the native GET.
 */
export function paperRecoveryBlocksRequest(url: string, resourceType: string, method: string): boolean {
  if (method !== "GET" || resourceType === "image" || resourceType === "media") return true;
  const endpoint = new URL(url), downloads: string[] = [];
  if (/\.pdf$/i.test(endpoint.pathname) || endpoint.hostname === "oaiusercontent.com"
    || endpoint.hostname.endsWith(".oaiusercontent.com")) return true;
  rememberChatGptDownloadSource(downloads, url);
  return downloads.length > 0 || endpoint.origin === "https://chatgpt.com"
    && /^\/backend-api\/files(?:\/|$)/.test(endpoint.pathname);
}
async function installPaperRecoveryTextRequests(page: Pick<Page, "route">) {
  const handler = async (route: Route) => {
    const request = route.request();
    if (paperRecoveryBlocksRequest(request.url(), request.resourceType(), request.method())) await route.abort("blockedbyclient");
    else await route.fallback();
  };
  await page.route("**/*", handler);
  return handler;
}
export async function withPaperRecoveryTextRequests<T>(page: Pick<Page, "route" | "unroute">, read: () => Promise<T>): Promise<T> {
  const handler = await installPaperRecoveryTextRequests(page);
  try { return await read(); }
  finally { await page.unroute("**/*", handler); }
}

/** Reopen the same saved URL under its existing account/session lease. No send, upload or model selection. */
export const readLauncherPaperRecovery: PaperRecoveryReader = async request => {
  const { conversationId } = paperRecoveryIdentity(request.conversationUrl);
  const descriptor = request.browserHostDescriptorPath;
  const owner = { traceId: "paper-recovery-" + randomUUID(), helperPid: process.pid };
  const conversationKey = chatGptQuestionAnswerKey("qa-pool-" + request.sessionHash, chatGptQuestionAnswerNamespace(request.accountId));
  const leaseFailure = new AbortController();
  const signal = AbortSignal.any([request.signal, leaseFailure.signal, AbortSignal.timeout(60_000)]);
  let connection: LauncherBrowserConnection | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined, heartbeat: Promise<void> | undefined;
  let terminal: "completed" | "failed" | "aborted" = "failed";
  let acquired = false, connectorBound = false;
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const lease = await notifyLauncherTurn(descriptor, { phase: "start", ...owner, conversationKey }, undefined, signal);
    acquired = true;
    connectorBound = lease.connectorBound === true;
    if (!lease.surfaceId) throw new PaperError("paper_recovery_unavailable", "Launcher did not lease a recovery surface", 503);
    heartbeatTimer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = notifyLauncherTurn(descriptor, { phase: "heartbeat", ...owner }, undefined, signal)
        .then(() => {}, () => { leaseFailure.abort(); }).finally(() => { heartbeat = undefined; });
    }, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
    connection = await connectLauncherBrowserHost(descriptor, 20_000, lease.surfaceId, signal);
    const page = connection.page;
    const aborted = new Promise<never>((_, rejectRead) => {
      onAbort = () => {
        // Disconnect only this reader's transport to cancel pending CDP operations.
        void connection!.browser.close().catch(() => {});
        rejectRead(new PaperError("paper_recovery_unavailable", "Recovery read was interrupted or its lease expired", 503));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const value = await Promise.race([(async () => {
      // This reader owns its CDP connection. Closing it in finally removes interception
      // without waiting for Fetch.disable on the retained document.
      await installPaperRecoveryTextRequests(page);
      const [response] = await Promise.all([
        page.waitForResponse(response => {
          const url = new URL(response.url());
          return response.request().method() === "GET" && url.origin === "https://chatgpt.com"
            && /^\/backend-api\/conversations?\//.test(url.pathname) && url.pathname.split("/").at(-1) === conversationId;
        }, { timeout: 30_000 }),
        page.goto(request.conversationUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }),
      ]);
      if (response.status() === 404) throw new PaperError("paper_recovery_not_found", "Saved conversation no longer exists", 404);
      if (!response.ok()) throw new PaperError("paper_recovery_unavailable", "Saved conversation GET failed", 503);
      if (!(response.headers()["content-type"] ?? "").includes("application/json")) return reject("format_invalid", "Saved conversation GET did not return JSON");
      try { return await response.json() as unknown; }
      catch { return reject("format_invalid", "Saved conversation GET returned invalid JSON"); }
    })(), aborted]);
    signal.throwIfAborted();
    terminal = "completed";
    return value;
  } catch (error) {
    if (signal.aborted) terminal = "aborted";
    if (error instanceof PaperError) throw error;
    throw new PaperError("paper_recovery_unavailable", "Native saved conversation could not be read; no message was sent", 503);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    await heartbeat;
    try { await connection?.browser.close(); }
    finally {
      if (acquired) {
        try {
          const release = await notifyLauncherTurn(descriptor, { phase: "end", ...owner, status: terminal, retain: true, connectorBound });
          if (release.cancelledByUser || release.authenticationRequired) throw new Error("Recovery lease was cancelled");
        } catch {
          throw new PaperError("paper_recovery_unavailable", "Recovery lease could not be released or was cancelled", 503);
        }
      }
    }
  }
};
