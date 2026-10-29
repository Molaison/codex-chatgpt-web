import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ChatGptWebAdapterError } from "./adapter-error";

export interface SavedChatConversation {
  version: 1;
  account: string;
  conversation: string;
  createdAt: string;
  claim: string;
  state: "pending" | "bound";
  url?: string;
  pendingProject?: { id: string; name: string };
  /** Accepted canonical message fingerprints, not text or permission authority. */
  history?: string[];
  instructionFingerprint?: string;
  instructionHistoryFingerprint?: string;
  previous?: Array<Pick<SavedChatConversation, "claim" | "state" | "url" | "createdAt" | "history" | "pendingProject">>;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function hasAcceptedChatGptInstructions(saved: SavedChatConversation | undefined, fingerprint?: string): boolean {
  return Boolean(saved?.state === "bound" && saved.history?.length && fingerprint
    && saved.instructionFingerprint === fingerprint
    && saved.instructionHistoryFingerprint === hash(JSON.stringify(saved.history)));
}

function validConversationDetails(value: Pick<SavedChatConversation, "history" | "pendingProject">): boolean {
  return (value.history === undefined || (Array.isArray(value.history) && value.history.length > 0
    && value.history.every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))))
    && (value.pendingProject === undefined || (value.pendingProject !== null
      && /^g-p-[a-f0-9]{32}$/.test(value.pendingProject.id)
      && typeof value.pendingProject.name === "string" && !!value.pendingProject.name.trim()));
}

export function conversationPersistenceError(code: string, message: string, cause?: unknown, diagnostics?: Record<string, unknown>): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 409, errorType: "invalid_request_error", code, retryable: false, ...(diagnostics ? { diagnostics } : {}), ...(cause === undefined ? {} : { cause }),
  });
}

/** Persist only canonical account-owned saved-chat routes, never query tokens or Temporary Chats. */
export function canonicalSavedChatUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw conversationPersistenceError("saved_conversation_url_invalid", "The saved ChatGPT conversation URL is invalid.");
  }
  if (url.origin !== "https://chatgpt.com" || url.username || url.password
    || url.searchParams.get("temporary-chat") === "true"
    || !/^(?:\/g\/g-p-[a-f0-9]{32}(?:-[^/]+)?)?\/c\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/?$/.test(url.pathname)) {
    throw conversationPersistenceError("saved_conversation_url_invalid", "Persistent sessions require a saved ChatGPT conversation URL.");
  }
  return url.origin + url.pathname.replace(/^\/g\/(g-p-[a-f0-9]{32})(?:-[^/]+)?\/c\//, "/g/$1/c/").replace(/\/$/, "");
}

/**
 * One private file per account/conversation, without expiration or eviction. The
 * first write uses an atomic hard-link publish so competing helpers cannot both
 * claim an unbound session. A claim is atomically replaced with its immutable URL.
 */
export class ChatGptConversationStore {
  readonly account: string;
  readonly directory: string;

  constructor(directory: string, accountId: string) {
    if (!accountId.trim()) throw conversationPersistenceError("conversation_account_missing", "Persistent ChatGPT sessions require an account identity.");
    this.account = hash(accountId);
    this.directory = join(resolve(directory), this.account);
  }

  private path(key: string): string {
    if (!key.trim()) throw conversationPersistenceError("conversation_key_missing", "Persistent ChatGPT sessions require a conversation key.");
    return join(this.directory, `${hash(key)}.json`);
  }

  read(key: string): SavedChatConversation | undefined {
    let text: string;
    try { text = readFileSync(this.path(key), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw conversationPersistenceError("conversation_store_unavailable", "The saved conversation mapping could not be read.", error);
    }
    try {
      const value = JSON.parse(text) as SavedChatConversation;
      if (!value || value.version !== 1 || value.account !== this.account || value.conversation !== hash(key)
        || !["pending", "bound"].includes(value.state) || typeof value.claim !== "string"
        || !/^[a-f0-9-]{36}$/.test(value.claim) || typeof value.createdAt !== "string"
        || !Number.isFinite(Date.parse(value.createdAt))
        || !validConversationDetails(value)
        || (value.instructionFingerprint !== undefined && (typeof value.instructionFingerprint !== "string"
          || !/^[a-f0-9]{64}$/.test(value.instructionFingerprint)))
        || (value.instructionHistoryFingerprint !== undefined && (typeof value.instructionHistoryFingerprint !== "string"
          || !/^[a-f0-9]{64}$/.test(value.instructionHistoryFingerprint)))
        || (value.previous !== undefined && (!Array.isArray(value.previous) || value.previous.some(old => !old
          || !/^[a-f0-9-]{36}$/.test(old.claim) || !Number.isFinite(Date.parse(old.createdAt))
          || !validConversationDetails(old)
          || !["pending", "bound"].includes(old.state) || (old.state === "pending" && old.url !== undefined)
          || (old.state === "bound" && (typeof old.url !== "string" || canonicalSavedChatUrl(old.url) !== old.url)))))
        || (value.state === "pending" && value.url !== undefined)
        || (value.state === "bound" && (typeof value.url !== "string" || canonicalSavedChatUrl(value.url) !== value.url))) {
        throw new Error("Conversation record failed validation");
      }
      return value;
    } catch (error) {
      throw conversationPersistenceError("conversation_store_invalid", "The saved conversation mapping is invalid; it was not replaced with a new chat.", error);
    }
  }

  lookup(key: string): SavedChatConversation | undefined {
    const entry = this.read(key);
    if (entry?.state === "pending") throw conversationPersistenceError(
      "saved_conversation_unresolved",
      "An earlier ChatGPT submission did not record its conversation URL. Inspect the earlier chat or explicitly start a new session/fork; the question was not resent.",
    );
    return entry;
  }

  reserve(key: string): SavedChatConversation {
    const record: SavedChatConversation = {
      version: 1, account: this.account, conversation: hash(key), createdAt: new Date().toISOString(),
      claim: randomUUID(), state: "pending",
    };
    const temporary = this.writeTemporary(key, record);
    try {
      linkSync(temporary, this.path(key));
      this.flushDirectory();
      return record;
    } catch (error) {
      throw conversationPersistenceError(
        (error as NodeJS.ErrnoException).code === "EEXIST" ? "saved_conversation_conflict" : "conversation_store_unavailable",
        "The conversation could not be reserved safely; no new ChatGPT message was submitted.", error,
      );
    } finally { try { unlinkSync(temporary); } catch {} }
  }

  bind(key: string, claim: SavedChatConversation, url: string, pendingProject?: { id: string; name: string }): SavedChatConversation {
    const canonical = canonicalSavedChatUrl(url);
    const current = this.read(key);
    if (!current || current.claim !== claim.claim || current.account !== claim.account) throw conversationPersistenceError(
      "saved_conversation_conflict", "The persistent conversation is owned by another submission.",
    );
    if (current.state === "bound") {
      if (current.url !== canonical) throw conversationPersistenceError("saved_conversation_conflict", "A persistent session cannot be rebound to another ChatGPT chat.");
      return current;
    }
    const record: SavedChatConversation = { ...current, state: "bound", url: canonical, ...(pendingProject ? { pendingProject } : {}) };
    const temporary = this.writeTemporary(key, record);
    try { renameSync(temporary, this.path(key)); this.flushDirectory(); } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw conversationPersistenceError("conversation_store_unavailable", "ChatGPT accepted the question, but its saved conversation mapping could not be committed.", error);
    }
    return record;
  }

  /** Called while the original Launcher writer lease is still held, after the native recovery fence. */
  recover(key: string, expected: SavedChatConversation): SavedChatConversation {
    const current = this.read(key);
    if (!current || current.claim !== expected.claim || current.account !== expected.account) {
      throw conversationPersistenceError("saved_conversation_conflict", "The recovery source no longer owns this conversation.");
    }
    const record: SavedChatConversation = { version: 1, account: current.account, conversation: current.conversation,
      createdAt: new Date().toISOString(), claim: randomUUID(), state: "pending",
      previous: [...(current.previous ?? []), { claim: current.claim, state: current.state,
        ...(current.url ? { url: current.url } : {}), createdAt: current.createdAt,
        ...(current.history ? { history: current.history } : {}),
        ...(current.pendingProject ? { pendingProject: current.pendingProject } : {}) }] };
    const temporary = this.writeTemporary(key, record);
    try { renameSync(temporary, this.path(key)); this.flushDirectory(); } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw conversationPersistenceError("conversation_store_unavailable", "The recovery mapping could not be committed.", error);
    }
    return record;
  }

  recordHistory(
    key: string,
    expected: SavedChatConversation,
    history: string[],
    instructionFingerprint?: string,
  ): SavedChatConversation {
    const current = this.lookup(key);
    if (!current || current.claim !== expected.claim || current.account !== expected.account
      || !history.length || history.some(item => !/^[a-f0-9]{64}$/.test(item))
      || (instructionFingerprint !== undefined && (typeof instructionFingerprint !== "string"
        || !/^[a-f0-9]{64}$/.test(instructionFingerprint)))) {
      throw conversationPersistenceError("saved_conversation_conflict", "Only the accepted conversation owner may checkpoint its canonical history.");
    }
    const { instructionFingerprint: _instructionFingerprint,
      instructionHistoryFingerprint: _instructionHistoryFingerprint, ...previous } = current;
    const record = {
      ...previous,
      history: [...history],
      ...(instructionFingerprint !== undefined ? {
        instructionFingerprint, instructionHistoryFingerprint: hash(JSON.stringify(history)),
      } : {}),
    };
    const temporary = this.writeTemporary(key, record);
    try { renameSync(temporary, this.path(key)); this.flushDirectory(); } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw conversationPersistenceError("conversation_store_unavailable", "The accepted conversation history could not be checkpointed.", error);
    }
    return record;
  }

  finishProjectMove(key: string, url: string): SavedChatConversation {
    const current = this.lookup(key);
    const canonical = canonicalSavedChatUrl(url);
    if (!current?.pendingProject || !current.url
      || canonical !== `https://chatgpt.com/g/${current.pendingProject.id}/c/${current.url.split("/c/")[1]}`) {
      throw conversationPersistenceError("saved_conversation_conflict", "Project move must preserve the recorded saved conversation identity.");
    }
    const { pendingProject, ...saved } = current;
    const record = { ...saved, url: canonical };
    const temporary = this.writeTemporary(key, record);
    renameSync(temporary, this.path(key)); this.flushDirectory();
    return record;
  }

  /** Only the caller still inside the pre-Send activation hook may cancel its own claim. */
  cancelBeforeSend(key: string, claim: SavedChatConversation): void {
    const current = this.read(key);
    if (!current || current.claim !== claim.claim || current.account !== claim.account || current.state !== "pending") {
      throw conversationPersistenceError("saved_conversation_conflict", "Only an unsubmitted owned reservation may be cancelled.");
    }
    const previous = current.previous?.at(-1);
    let temporary: string | undefined;
    try {
      if (previous) {
        // The failed recovery never sent a message. Restore its complete prior
        // mapping, including any uncertainty, instead of erasing accepted history.
        const record: SavedChatConversation = { version: 1, account: current.account, conversation: current.conversation,
          ...previous, ...(current.previous!.length > 1 ? { previous: current.previous!.slice(0, -1) } : {}) };
        temporary = this.writeTemporary(key, record);
        renameSync(temporary, this.path(key));
      } else {
        unlinkSync(this.path(key));
      }
      this.flushDirectory();
    } catch (error) {
      if (temporary) { try { unlinkSync(temporary); } catch {} }
      throw conversationPersistenceError("conversation_store_unavailable", "An unsubmitted reservation could not be cancelled safely.", error);
    }
  }

  private writeTemporary(key: string, record: SavedChatConversation): string {
    const path = this.path(key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temporary); } catch {}
      throw conversationPersistenceError("conversation_store_unavailable", "The persistent conversation record could not be written.", error);
    }
    return temporary;
  }

  private flushDirectory(): void {
    // POSIX directory fsync makes rename/link durable; Windows does not expose it.
    if (process.platform === "win32") return;
    const fd = openSync(this.directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
