export const SAVED_CONVERSATION_RESTORE_STAGES = [
  "navigation", "saved URL verification", "history", "composer", "authentication", "diagnostic capture",
] as const;
export const SAVED_CONVERSATION_RESTORE_CAUSES = [
  "unavailable", "timeout", "http_error", "canonical_mismatch", "authentication_required",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "ERR_TUNNEL_CONNECTION_FAILED", "ERR_PROXY_CONNECTION_FAILED", "ERR_NO_SUPPORTED_PROXIES",
  "ERR_CONNECTION_RESET", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_TIMED_OUT",
  "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT", "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED",
  "ERR_ABORTED", "ERR_FAILED", "ERR_HTTP_RESPONSE_CODE_FAILURE", "ERR_CERT_AUTHORITY_INVALID",
  "ERR_CERT_DATE_INVALID", "ERR_CERT_COMMON_NAME_INVALID", "ERR_SSL_PROTOCOL_ERROR",
] as const;

/** Only machine codes and observed facts may cross the helper/receipt boundary. */
export interface ChatGptSavedConversationDiagnostics extends Record<string, unknown> {
  stage: typeof SAVED_CONVERSATION_RESTORE_STAGES[number];
  cause_code: typeof SAVED_CONVERSATION_RESTORE_CAUSES[number];
  http_status: number | "unavailable";
  elapsed_ms: number;
  canonical_match: boolean | "unavailable";
  history: boolean | "unavailable";
  composer: boolean | "unavailable";
  auth: false | "composer_verified" | "unavailable";
}

export function parseChatGptSavedConversationDiagnostics(value: unknown): ChatGptSavedConversationDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Saved conversation diagnostics are invalid");
  }
  const facts = value as Record<string, unknown>;
  const keys = ["stage", "cause_code", "http_status", "elapsed_ms", "canonical_match", "history", "composer", "auth"];
  if (Object.keys(facts).length !== keys.length || keys.some(key => !Object.hasOwn(facts, key))
    || !SAVED_CONVERSATION_RESTORE_STAGES.includes(facts.stage as ChatGptSavedConversationDiagnostics["stage"])
    || !SAVED_CONVERSATION_RESTORE_CAUSES.includes(facts.cause_code as ChatGptSavedConversationDiagnostics["cause_code"])
    || !(facts.http_status === "unavailable" || (Number.isInteger(facts.http_status) && (facts.http_status as number) >= 100 && (facts.http_status as number) <= 599))
    || !Number.isSafeInteger(facts.elapsed_ms) || (facts.elapsed_ms as number) < 0
    || [facts.canonical_match, facts.history, facts.composer].some(fact => typeof fact !== "boolean" && fact !== "unavailable")
    || ![false, "composer_verified", "unavailable"].includes(facts.auth as false | string)) {
    throw new Error("Saved conversation diagnostics are invalid");
  }
  return { ...facts } as ChatGptSavedConversationDiagnostics;
}

export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
  diagnostics?: Record<string, unknown>;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly diagnostics?: Record<string, unknown>;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
    this.diagnostics = options.diagnostics;
  }
}

export function chatGptToolTimeoutError(tool: string, timeoutMs: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `Codex tool ${tool} did not return a result within ${timeoutMs / 1_000} seconds. `
    + "The turn was stopped. Check whether the command is still running or waiting for approval before retrying.",
    { status: 504, errorType: "server_error", code: "codex_tool_timeout", retryable: false },
  );
}

export function chatGptResponseIncompleteError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502, errorType: "server_error", code: "chatgpt_response_incomplete", retryable: false,
  });
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A newer Codex instruction superseded this ChatGPT response.",
    { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}
