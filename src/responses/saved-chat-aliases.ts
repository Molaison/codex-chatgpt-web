import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandUserPath, getConfigDir } from "../config";
import { CHATGPT_WEB_LUNA_BACKEND_MODEL } from "../chatgpt-web-models";
import type { CodexParsedRequest, CodexProviderConfig } from "../types";
import { ChatGptWebAdapterError } from "../adapters/chatgpt-web/adapter-error";
import { chatGptConversationKey, chatGptQuestionAnswerNamespace } from "../adapters/chatgpt-web/conversation-key";
import { ChatGptConversationStore } from "../adapters/chatgpt-web/conversation-persistence";
import { extractChatGptTurnIdentity } from "../adapters/chatgpt-web/environment";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface SavedResponseAlias {
  response: string; account: string; thread: string; conversation: string; savedChat: string; createdAt: number;
}
function failure(code: string, message: string, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, { status: 409, errorType: "invalid_request_error", code, retryable: false,
    ...(cause === undefined ? {} : { cause }) });
}
function validAlias(value: SavedResponseAlias): boolean {
  return [value.response, value.account, value.thread, value.conversation, value.savedChat]
    .every(field => typeof field === "string" && /^[a-f0-9]{64}$/.test(field))
    && Number.isSafeInteger(value.createdAt) && value.createdAt > 0;
}

/** Small durable metadata only: no prompts, answers, cookies or full Responses history. */
export class SavedChatResponseAliases {
  readonly path: string;
  constructor(directory: string, private readonly maxAliases?: number) {
    this.path = join(resolve(directory), "response-aliases.sqlite");
    if (maxAliases !== undefined && (!Number.isSafeInteger(maxAliases) || maxAliases < 1)) throw new Error("Invalid alias registry limit");
  }
  private use<T>(create: boolean, callback: (db: Database) => T): T | undefined {
    if (!create && !existsSync(this.path)) return undefined;
    let db: Database | undefined;
    try {
      if (create) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        try { closeSync(openSync(this.path, "wx", 0o600)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      db = new Database(this.path, create ? { create: true } : { readonly: true });
      if (create) {
        chmodSync(this.path, 0o600);
        db.exec("PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
        db.exec("CREATE TABLE IF NOT EXISTS saved_response_aliases (response TEXT PRIMARY KEY, account TEXT NOT NULL, thread TEXT NOT NULL, conversation TEXT NOT NULL, savedChat TEXT NOT NULL, createdAt INTEGER NOT NULL)");
      }
      return callback(db);
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      throw failure("saved_response_alias_store_unavailable", "The durable response alias registry is unavailable; continuation was not guessed.", error);
    } finally { db?.close(); }
  }
  lookup(responseId: string): SavedResponseAlias | undefined {
    return this.use(false, db => {
      const row = db.query<SavedResponseAlias, [string]>("SELECT * FROM saved_response_aliases WHERE response = ?").get(hash(responseId));
      if (!row) return undefined;
      if (!validAlias(row)) throw failure("saved_response_alias_invalid", "The saved response alias is invalid.");
      return row;
    });
  }
  remember(responseId: string, binding: Omit<SavedResponseAlias, "response" | "createdAt">): void {
    const row = { ...binding, response: hash(responseId), createdAt: Date.now() };
    if (!responseId || responseId.length > 512 || !validAlias(row)) throw failure("saved_response_alias_invalid", "Cannot persist an invalid response alias.");
    this.use(true, db => db.transaction(() => {
      const prior = db.query<SavedResponseAlias, [string]>("SELECT * FROM saved_response_aliases WHERE response = ?").get(row.response);
      if (prior) {
        if (!validAlias(prior) || ["account", "thread", "conversation", "savedChat"].some(key => prior[key as keyof SavedResponseAlias] !== row[key as keyof SavedResponseAlias])) {
          throw failure("saved_response_alias_conflict", "A response ID cannot be rebound to another account, thread or saved chat.");
        }
        return;
      }
      if (this.maxAliases !== undefined) {
        const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM saved_response_aliases").get()!.count;
        if (count >= this.maxAliases) throw failure("saved_response_alias_capacity", "The durable response alias registry is full; existing aliases were preserved.");
      }
      db.query("INSERT INTO saved_response_aliases (response, account, thread, conversation, savedChat, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.response, row.account, row.thread, row.conversation, row.savedChat, row.createdAt);
    }).immediate());
  }
}

export function supportsSavedChatAliases(provider: CodexProviderConfig, parsed: CodexParsedRequest): boolean {
  const config = provider.chatgptWeb;
  return config?.browserHost === "launcher" && !!config.browserHostDescriptorPath
    && config.browserInteractionMode !== "manual" && config.localToolsEnabled !== true
    && config.useSavedChats !== false && config.experimentalFreshConversationPerTurn !== true
    && !parsed._compactionRequest && parsed.modelId !== CHATGPT_WEB_LUNA_BACKEND_MODEL;
}
function context(provider: CodexProviderConfig, parsed: CodexParsedRequest) {
  const accountId = provider.chatgptWeb?.accountId ?? "default";
  const threadId = extractChatGptTurnIdentity(parsed).threadId;
  const conversation = chatGptConversationKey(parsed, chatGptQuestionAnswerNamespace(accountId), { questionAnswer: true });
  if (!threadId || !conversation) throw failure("saved_response_identity_missing", "Durable previous_response_id continuation requires the same native thread_id.");
  const directory = resolve(getConfigDir(), expandUserPath(provider.chatgptWeb?.conversationStoreDirectory ?? join("runtime", "conversations")));
  return { account: hash(accountId), thread: hash(threadId), conversation,
    store: new ChatGptConversationStore(directory, accountId), aliases: new SavedChatResponseAliases(directory) };
}

/** This proves a current saved-chat continuation, not a historical response snapshot. */
export function verifySavedChatResponseAlias(provider: CodexProviderConfig, parsed: CodexParsedRequest, responseId: string): void {
  const owner = context(provider, parsed);
  const alias = owner.aliases.lookup(responseId);
  if (!alias) throw failure("previous_response_unavailable", "The previous_response_id has no verified durable saved-chat alias; refusing partial Codex context.");
  if (alias.account !== owner.account || alias.thread !== owner.thread || alias.conversation !== owner.conversation) {
    throw failure("previous_response_identity_mismatch", "The previous_response_id belongs to a different account or thread; it cannot be rebound.");
  }
  const saved = owner.store.lookup(owner.conversation);
  if (!saved?.url || hash(saved.url) !== alias.savedChat) {
    throw failure("previous_response_saved_chat_unavailable", "The previous response's saved ChatGPT conversation is unavailable or no longer matches.");
  }
}

export function rememberSavedChatResponseAlias(provider: CodexProviderConfig, parsed: CodexParsedRequest, response: Record<string, unknown>): void {
  if (!supportsSavedChatAliases(provider, parsed) || response.status !== "completed"
    || typeof response.id !== "string" || !Array.isArray(response.output) || !extractChatGptTurnIdentity(parsed).threadId) return;
  const owner = context(provider, parsed);
  const saved = owner.store.lookup(owner.conversation);
  // No saved chat exists for anonymous/isolated adapter fixtures; never invent a binding.
  if (!saved?.url) return;
  owner.aliases.remember(response.id, { account: owner.account, thread: owner.thread,
    conversation: owner.conversation, savedChat: hash(saved.url) });
}
