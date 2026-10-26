import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";
import { toolSchema } from "../../responses/schema";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile } from "../../config";
import { getCodexHome, getTrustedCodexHomes } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptTurnEnvironmentClaim,
  restrictedReadOnlyCwdContinuation,
  restrictedReadOnlyFailedFirstContinuation,
  extractVerifiedNativeEnvironmentClaim,
  extractChatGptCompactionSourceRevision,
  extractChatGptContinuationEnvironmentClaim,
  extractChatGptSteeringEnvironmentClaim,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
  hasCurrentChatGptEnvironmentContext,
  extractChatGptCalendarEnvironmentDelta,
  extractChatGptNativeCompactionEnvironment,
  hasRawChatGptEnvironmentContext,
  legacyChatGptEnvironmentClaims,
  hasOnlyPermissionNeutralChatGptCalendarHistory,
  hasOnlyPermissionNeutralReadOnlyCalendarHistory,
  unattributedChatGptEnvironmentMessages,
  isChatGptCompactionContinuation,
  MissingTrustedCodexEnvironmentError,
  type ChatGptEnvironmentClaim,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
} from "./environment";
import { resolveCurrentCodexRolloutEnvironment } from "./codex-rollout-environment";
import { ChatGptWebAdapterError } from "./adapter-error";
import { forkedFromThreadId } from "./conversation-key";

interface StoredThreadEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  updatedAt: number;
  acceptedHistory?: { inputLength: number; sha256: string; catalogIndependent?: { version: 1; sha256: string };
    forkIndependent?: { version: 1; sha256: string } };
}

interface StoredThreadEnvironmentFile {
  version: 1;
  threads: Record<string, StoredThreadEnvironment>;
}

const MAX_THREAD_ENVIRONMENTS = 256;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Invalid persisted ChatGPT thread ${field}`);
  }
  const unique = new Map<string, string>();
  for (const path of value.map(path => resolve(path as string))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

function sandboxPolicy(value: unknown, roots: string[], writableRoots: string[]): ChatGptSandboxPolicy {
  const parsed = record(value);
  if (parsed?.type === "dangerFullAccess") {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (writableRoots.length !== roots.length || writableRoots.some(path => !rootIdentities.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT danger-full-access roots");
    }
    return { type: "dangerFullAccess" };
  }
  if (parsed?.type === "workspaceWrite") {
    const policyRoots = absolutePaths(parsed.writableRoots, "workspace-write policy writable roots");
    const declared = new Set(policyRoots.map(pathIdentity));
    // Project membership is not the grant boundary: native Codex also authorizes
    // external output directories. Both persisted grant sets must agree exactly.
    if (typeof parsed.networkAccess !== "boolean" || policyRoots.length !== writableRoots.length
      || writableRoots.some(path => !declared.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT workspace-write policy");
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: parsed.networkAccess };
  }
  if (parsed?.type === "readOnly") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.length !== 0) {
      throw new Error("Invalid persisted ChatGPT read-only policy");
    }
    return { type: "readOnly", networkAccess: parsed.networkAccess };
  }
  throw new Error("Invalid persisted ChatGPT sandbox policy");
}

function historyDigest(input: unknown[]): string {
  const comparison = input.map((value, index) => {
    const item = record(value);
    if (item?.type !== "message" || item.role !== "user" || typeof item.id !== "string") return value;
    const generated = /^cpr-message-(.+)-(0|[1-9][0-9]*)$/.exec(item.id);
    if (!generated || generated[0] !== item.id || generated[2] !== String(index)) return value;
    // CPR regenerates only these user-message IDs for each HTTP request.
    // Keep every other field, including native ownership metadata, unchanged.
    const { id: _id, ...stable } = item;
    return stable;
  });
  return createHash("sha256").update(JSON.stringify(comparison)).digest("hex");
}

// Only declaration-only native packets may vary. Unknown fields/shapes stay on
// the original exact-proof path; never erase a message, ownership or permission.
const declarationLeaf = z.union([
  toolSchema.strict(),
  z.strictObject({
    type: z.literal("custom"), name: z.string().min(1), description: z.string().optional(),
    format: z.union([
      z.strictObject({ type: z.literal("text") }),
      z.strictObject({ type: z.literal("grammar"), syntax: z.enum(["lark", "regex"]), definition: z.string() }),
    ]).optional(),
  }),
  z.strictObject({
    type: z.literal("tool_search"), execution: z.enum(["client", "server"]),
    description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional(),
  }),
]);
const catalogPacket = z.strictObject({
  type: z.literal("additional_tools"), role: z.literal("developer"), id: z.string().min(1),
  tools: z.array(z.union([declarationLeaf, z.strictObject({
    type: z.literal("namespace"), name: z.string().min(1), description: z.string().optional(),
    tools: z.array(declarationLeaf),
  })])),
});

function catalogIndependentDigest(input: unknown[], threadId: string): string | undefined {
  const stable: unknown[] = [];
  for (const value of input) {
    const item = record(value);
    if (item?.type !== "additional_tools") { stable.push(value); continue; }
    if (!catalogPacket.safeParse(item).success) return undefined;
    // Preserve packet position, role, type, field presence and key order. Only
    // declaration ID/tools vary. Schema data within tools is not authority XML.
    stable.push(Object.fromEntries(Object.entries(item).map(([key, val]) =>
      [key, key === "id" || key === "tools" ? null : val])));
  }
  return createHash("sha256").update(JSON.stringify(["catalog-independent-v1", threadId, historyDigest(stable)])).digest("hex");
}

/** Native forks rekey only the declaration/static preamble IDs; never normalize permission or history IDs. */
function forkIndependentDigest(input: unknown[], parentThreadId: string): string | undefined {
  let preamble = true;
  const stable: unknown[] = [];
  for (const value of input) {
    const item = record(value);
    if (item?.role === "user") preamble = false;
    if (!preamble || item?.role !== "developer") { stable.push(value); continue; }
    if (item.type === "additional_tools") {
      if (!catalogPacket.safeParse(item).success) return undefined;
    } else if (item.type !== "message" || typeof item.id !== "string" || !item.id
      || /<\/?(?:permissions instructions|environment_context)\b/.test(JSON.stringify(item.content))) {
      stable.push(value); continue;
    }
    // All content, declaration schemas, metadata and field presence remain byte-proven.
    stable.push(Object.fromEntries(Object.entries(item).map(([key, val]) => [key, key === "id" ? null : val])));
  }
  return createHash("sha256").update(JSON.stringify(["native-fork-prefix-v1", parentThreadId, historyDigest(stable)])).digest("hex");
}

// Offline migration only: an old exact proof plus its private witness is the
// authority. Never mint this proof from the unverified continuation request.
export function addCatalogIndependentHistoryProof(
  cache: unknown, threadId: string, witness: CodexParsedRequest, expectedEntry: unknown, now = Date.now(),
): Record<string, unknown> {
  const file = record(cache);
  const threads = record(file?.threads);
  const target = record(threads?.[threadId]);
  if (file?.version !== 1 || !threads || !target || !isDeepStrictEqual(target, expectedEntry)) {
    throw new Error("History migration target changed");
  }
  const stored = validateStoredEnvironment(target);
  const proof = stored.acceptedHistory;
  const input = record(witness._rawBody)?.input;
  if (extractChatGptTurnIdentity(witness).threadId !== threadId) throw new Error("History migration thread mismatch");
  if (!Number.isFinite(now) || !Number.isFinite(stored.updatedAt) || now - stored.updatedAt > THREAD_ENVIRONMENT_TTL_MS) {
    throw new Error("History migration cache expired");
  }
  if (!proof || proof.catalogIndependent || !Array.isArray(input) || input.length < proof.inputLength
    || historyDigest(input.slice(0, proof.inputLength)) !== proof.sha256) {
    throw new Error("History migration witness does not match original proof");
  }
  const sha256 = catalogIndependentDigest(input.slice(0, proof.inputLength), threadId);
  if (!sha256) throw new Error("History migration witness contains unsupported catalog packet");
  return { ...file, threads: { ...threads, [threadId]: {
    ...target, acceptedHistory: { ...record(target.acceptedHistory), catalogIndependent: { version: 1, sha256 } },
  } } };
}

function acceptedHistory(parsed: CodexParsedRequest): StoredThreadEnvironment["acceptedHistory"] {
  const input = record(parsed._rawBody)?.input;
  if (!Array.isArray(input) || input.length === 0 || !hasRawChatGptEnvironmentContext(parsed)) return undefined;
  // Persist a digest of the accepted prefix, never conversation/tool-result text.
  const threadId = extractChatGptTurnIdentity(parsed).threadId;
  const digest = threadId ? catalogIndependentDigest(input, threadId) : undefined;
  const forkDigest = threadId ? forkIndependentDigest(input, threadId) : undefined;
  return { inputLength: input.length, sha256: historyDigest(input),
    ...(digest ? { catalogIndependent: { version: 1 as const, sha256: digest } } : {}),
    ...(forkDigest ? { forkIndependent: { version: 1 as const, sha256: forkDigest } } : {}),
  };
}

function verifiedAcceptedPrefix(parsed: CodexParsedRequest, stored: StoredThreadEnvironment, forkParent?: string): unknown[] | undefined {
  const proof = stored.acceptedHistory;
  const body = record(parsed._rawBody);
  const input = body?.input;
  if (!proof || !Array.isArray(input) || input.length <= proof.inputLength) return undefined;
  const prefix = input.slice(0, proof.inputLength);
  if (historyDigest(prefix) !== proof.sha256) {
    if (forkParent) {
      if (!proof.forkIndependent || forkIndependentDigest(prefix, forkParent) !== proof.forkIndependent.sha256) return undefined;
      return prefix;
    }
    const threadId = extractChatGptTurnIdentity(parsed).threadId;
    if (!threadId || !proof.catalogIndependent
      || catalogIndependentDigest(prefix, threadId) !== proof.catalogIndependent.sha256) return undefined;
  }
  return prefix;
}

function matchesAcceptedHistory(parsed: CodexParsedRequest, stored: StoredThreadEnvironment, forkParent?: string): boolean {
  const prefix = verifiedAcceptedPrefix(parsed, stored, forkParent);
  if (!prefix) return false;
  const proof = stored.acceptedHistory!;
  const body = record(parsed._rawBody)!;
  const input = body.input as unknown[];
  const continuation = { ...parsed, _rawBody: { ...body, input: input.slice(proof.inputLength) } };
  if (forkParent && hasOnlyPermissionNeutralReadOnlyCalendarHistory(parsed, { ...stored, tools: [] }, prefix)) return true;
  if (forkParent && ((input.slice(proof.inputLength) as unknown[]).some(value => {
    const item = record(value);
    return item?.role === "developer" || item?.type === "additional_tools";
  }) || hasRawChatGptEnvironmentContext(continuation))) return false;
  // Untagged native deltas can follow the proven prefix without assistant output.
  // The narrow validator rejects explicit current ownership and any new authority.
  if (hasRawChatGptEnvironmentContext(continuation)) {
    if (!hasOnlyPermissionNeutralChatGptCalendarHistory(continuation, { ...stored, tools: [] }, input.slice(0, proof.inputLength))) return false;
    // Managed history has already compared the last proven profile (including
    // read exclusions) and native network packet against the unchanged cache.
    if (stored.sandboxPolicy.type !== "dangerFullAccess") return true;
  }
  // Current sandbox/workspace metadata must still validate the proven envelope.
  // Reuse its exact accepted prefix; never search arbitrary earlier XML for a match.
  try {
    const environment = extractChatGptTurnEnvironmentClaim({ ...parsed, _rawBody: { ...body, input: input.slice(0, proof.inputLength) } });
    return conflictingAuthorityFields(environment, { ...stored, tools: parsed.context.tools ?? [] }, false).length === 0;
  } catch (error) {
    if (error instanceof MissingTrustedCodexEnvironmentError) return false;
    throw error;
  }
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT thread environment");
  }
  const proof = record(parsed.acceptedHistory);
  if (parsed.acceptedHistory !== undefined && (!proof || !Number.isSafeInteger(proof.inputLength)
    || typeof proof.inputLength !== "number" || proof.inputLength < 1
    || typeof proof.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.sha256))) {
    throw new Error("Invalid persisted ChatGPT accepted history proof");
  }
  const catalogProof = record(proof?.catalogIndependent);
  if (proof?.catalogIndependent !== undefined && (!catalogProof || catalogProof.version !== 1
    || Object.keys(catalogProof).some(key => key !== "version" && key !== "sha256")
    || typeof catalogProof.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(catalogProof.sha256))) {
    throw new Error("Invalid persisted ChatGPT catalog-independent history proof");
  }
  const forkProof = record(proof?.forkIndependent);
  if (proof?.forkIndependent !== undefined && (!forkProof || forkProof.version !== 1
    || Object.keys(forkProof).some(key => key !== "version" && key !== "sha256")
    || typeof forkProof.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(forkProof.sha256))) {
    throw new Error("Invalid persisted ChatGPT native-fork history proof");
  }
  const cwd = resolve(parsed.cwd);
  const roots = absolutePaths(parsed.roots, "roots");
  const writableRoots = Array.isArray(parsed.writableRoots) && parsed.writableRoots.length === 0
    ? []
    : absolutePaths(parsed.writableRoots, "writable roots");
  if (!roots.some(root => contains(root, cwd))) throw new Error("Persisted ChatGPT cwd is outside its roots");
  return {
    cwd,
    roots,
    writableRoots,
    sandboxPolicy: sandboxPolicy(parsed.sandboxPolicy, roots, writableRoots),
    updatedAt: parsed.updatedAt,
    ...(proof ? { acceptedHistory: { inputLength: proof.inputLength as number, sha256: proof.sha256 as string,
      ...(catalogProof ? { catalogIndependent: { version: 1 as const, sha256: catalogProof.sha256 as string } } : {}),
      ...(forkProof ? { forkIndependent: { version: 1 as const, sha256: forkProof.sha256 as string } } : {}),
    } } : {}),
  };
}

function authority(environment: ChatGptTurnEnvironment, updatedAt: number, parsed?: CodexParsedRequest): StoredThreadEnvironment {
  return {
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    updatedAt,
    ...(parsed ? { acceptedHistory: acceptedHistory(parsed) } : {}),
  };
}

function conflictingAuthorityFields(claim: ChatGptEnvironmentClaim, right: ChatGptTurnEnvironment, allowNativeOutputGrants = true): string[] {
  const left = claim.environment;
  const samePaths = (a: string[], b: string[]): boolean => {
    const expected = new Set(b.map(pathIdentity));
    return a.length === expected.size && a.every(path => expected.has(pathIdentity(path)));
  };
  const claimedRoots = new Set(left.roots.map(pathIdentity));
  const nativeRoots = new Set(right.roots.map(pathIdentity));
  const nativeGrants = new Set([...right.roots, ...right.writableRoots].map(pathIdentity));
  const fields: string[] = [];
  if ((left.cwd !== undefined && pathIdentity(left.cwd) !== pathIdentity(right.cwd))
    || !left.roots.some(root => contains(root, right.cwd))) fields.push("cwd");
  // Codex 0.163 omits workspace_roots in some rollouts while its envelope still
  // lists output directories. Every extra claimed root must be an exact native
  // grant, and no native workspace may disappear. Return only native authority.
  // A cached history proof cannot add grants; only a current native rollout can.
  if (allowNativeOutputGrants
    ? [...nativeRoots].some(root => !claimedRoots.has(root)) || [...claimedRoots].some(root => !nativeGrants.has(root))
    : !samePaths(left.roots, right.roots)) fields.push("workspace_roots");
  // Filesystem envelopes omit Codex's extra output directories, including after
  // compaction. Only the current native rollout supplies the returned grants.
  if (allowNativeOutputGrants
    ? !left.writableRoots.every(path => right.writableRoots.some(root => pathIdentity(root) === pathIdentity(path)))
    : !samePaths(left.writableRoots, right.writableRoots)) {
    fields.push("writable_roots");
  }
  if (left.sandboxPolicy.type !== right.sandboxPolicy.type) fields.push("sandbox_policy");
  // An envelope that does not state its network policy cannot contradict the rollout on it.
  if (left.sandboxPolicy.type !== "dangerFullAccess" && right.sandboxPolicy.type !== "dangerFullAccess"
    && claim.statesNetworkAccess && left.sandboxPolicy.networkAccess !== right.sandboxPolicy.networkAccess) {
    fields.push("network_access");
  }
  return fields;
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. This store carries only that trusted authority across turns. Tool
 * declarations are always taken from the current request and are never persisted.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();
  private readonly codexHomes: readonly string[];

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    codexHome: string = getCodexHome(),
    private readonly sqliteHome?: string,
    additionalCodexHomes?: readonly string[],
  ) {
    this.codexHomes = getTrustedCodexHomes(codexHome, additionalCodexHomes);
  }

  resolve(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
    const identity = extractChatGptTurnIdentity(parsed);
    let initialClaim: ChatGptEnvironmentClaim | undefined;
    try {
      const claim = extractChatGptTurnEnvironmentClaim(parsed);
      const environment = claim.environment;
      if (environment.cwd === undefined || this.codexHomes.length > 1
        || (environment.sandboxPolicy.type !== "dangerFullAccess" && !claim.statesNetworkAccess)) {
        // A shared bridge must prove the current native owner even for complete envelopes.
        // Modern envelopes state filesystem access only. Resolve the current native policy on
        // the first round too: absence of a network statement is not a disabled-network grant.
        // Likewise, workspace roots do not identify cwd; only this turn's native record can.
        initialClaim = claim;
        throw new MissingTrustedCodexEnvironmentError(
          environment.cwd === undefined ? "cwd"
            : this.codexHomes.length > 1 ? "current native task ownership" : "network access",
        );
      }
      const completeEnvironment = { ...environment, cwd: environment.cwd };
      if (identity.threadId) this.set(identity.threadId, completeEnvironment, parsed);
      return completeEnvironment;
    } catch (error) {
      if (!(error instanceof MissingTrustedCodexEnvironmentError)) throw error;
      if (!identity.threadId) { error.resolutionBranch = "identity_missing"; throw error; }
      const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
      const lineage = extractChatGptThreadSpawnLineage(parsed);
      const currentCompaction = hasCurrentContext && isChatGptCompactionContinuation(parsed);
      // Root tasks also retain unattributed environment fragments after compaction.
      // They are historical only when the exact native record predates this task;
      // neither the fragment nor the cache supplies the current authority.
      const unattributedMessages = hasCurrentContext && !currentCompaction
        ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
      // One adjacent claim can be checked against turn_context directly. Mixed
      // untagged history still needs native item provenance even when its last
      // envelope parses as a current claim.
      const historicalMessages = !initialClaim || (unattributedMessages?.length ?? 0) > 1
        ? unattributedMessages : undefined;
      const steeringClaim = hasCurrentContext && !currentCompaction
        ? extractChatGptSteeringEnvironmentClaim(parsed) : undefined;
      const calendarDelta = hasCurrentContext && !currentCompaction
        ? extractChatGptCalendarEnvironmentDelta(parsed) : undefined;
      const nativeCompaction = hasCurrentContext && !currentCompaction && !initialClaim && !steeringClaim && !calendarDelta
        ? extractChatGptNativeCompactionEnvironment(parsed) : undefined;
      if (hasCurrentContext && !currentCompaction && !initialClaim && !historicalMessages && !steeringClaim && !calendarDelta && !nativeCompaction) {
        console.warn("[chatgpt-web] trusted_environment_recovery rejected=unrecognized_current_context");
        error.resolutionBranch = "current_context_unverified";
        throw error;
      }
      const currentClaim = initialClaim ?? (currentCompaction
        ? extractChatGptContinuationEnvironmentClaim(parsed) : steeringClaim ?? nativeCompaction?.claim);
      const resolvedCalendarDelta = calendarDelta ?? currentClaim?.calendarDelta;
      const rolloutIdentity = lineage ?? extractChatGptRootThreadMetadata(parsed);
      // Automatic compaction has a current turn_context; standalone compaction has only its
      // source turn_context. Either must be the latest native record, never an arbitrary ancestor.
      const compactionSourceTurnId = parsed._compactionRequest
        ? extractChatGptCompactionSourceRevision(parsed).turnId : undefined;
      if (rolloutIdentity && identity.turnId) {
        const rollout = resolveCurrentCodexRolloutEnvironment({
          codexHome: this.codexHomes[0]!,
          additionalCodexHomes: this.codexHomes.slice(1),
          ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
          lineage: rolloutIdentity,
          turnId: identity.turnId,
          ...(compactionSourceTurnId ? { compactionSourceTurnId } : {}),
          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),
          ...(nativeCompaction ? { compactedEnvironmentItems: nativeCompaction.items } : {}),
          tools: parsed.context.tools,
        });
        if (rollout) {
          let rolloutEnvironment = rollout.environment;
          // After a restart Codex can omit workspace_roots while still explicitly
          // granting unrestricted access. In that case [cwd] is not a native
          // restriction. Keep the current envelope's workspace context; permissions
          // and task identity still come from the exact current native record.
          if (!rollout.workspaceRootsDeclared
            && rolloutEnvironment.sandboxPolicy.type === "dangerFullAccess"
            && currentClaim?.environment.sandboxPolicy.type === "dangerFullAccess"
            && (currentClaim.environment.cwd === undefined
              || pathIdentity(currentClaim.environment.cwd) === pathIdentity(rolloutEnvironment.cwd))
            && currentClaim.environment.roots.some(root => contains(root, rolloutEnvironment.cwd))) {
            rolloutEnvironment = {
              ...rolloutEnvironment,
              roots: [...currentClaim.environment.roots],
              writableRoots: [...currentClaim.environment.roots],
            };
          }
          const nativeClaims = rollout.currentEnvironmentMessages.map(message => extractVerifiedNativeEnvironmentClaim(parsed, message));
          if (resolvedCalendarDelta) {
            const nativeRoots = new Set(rolloutEnvironment.roots.map(pathIdentity));
            if (resolvedCalendarDelta.filesystemProfiles.some(profile => profile !== rollout.filesystemProfileXml)
              || resolvedCalendarDelta.workspaceRoots.some(roots => roots.length !== nativeRoots.size
                || roots.some(root => !nativeRoots.has(root)))) {
              throw new Error("Calendar environment delta conflicts with its current Codex rollout");
            }
          }
          const conflicts = [...new Set([...nativeClaims, ...(currentClaim ? [currentClaim] : [])]
            .flatMap(claim => conflictingAuthorityFields(claim, rolloutEnvironment)))];
          if (conflicts.length > 0) {
            const source = currentCompaction || nativeCompaction ? "Compaction continuation" : initialClaim || nativeClaims.length ? "Current" : "Steering";
            // Field names are safe to export; paths, request text and permission
            // contents are deliberately excluded from both the log and UI error.
            console.warn(`[chatgpt-web] trusted environment conflict (source=${source}, fields=${conflicts.join(",")})`);
            throw new Error(`${source} environment conflicts with its current Codex rollout (fields: ${conflicts.join(", ")})`);
          }
          this.set(rolloutIdentity.threadId, rolloutEnvironment, parsed);
          return rolloutEnvironment;
        }
      }
      console.warn(`[chatgpt-web] trusted_environment_recovery ${JSON.stringify({
        currentContext: hasCurrentContext,
        compactionContinuation: currentCompaction,
        nativeMetadata: rolloutIdentity !== undefined,
        nativeTurnId: identity.turnId !== undefined,
        registeredHomes: this.codexHomes.length,
        nativeRolloutFound: false,
      })}`);
      if (this.codexHomes.length > 1) {
        throw new Error("No current native Codex task proof in the trusted homes", { cause: error });
      }
      const sameThread = this.get(identity.threadId);
      if (!sameThread && initialClaim && !currentCompaction) {
        const restricted = restrictedReadOnlyFailedFirstContinuation(parsed, initialClaim);
        // The current native filesystem plus a strictly decoded network DENIAL establish
        // only this narrower read-only environment, so later turns can keep using it.
        if (restricted) {
          this.set(identity.threadId, restricted, parsed);
          return restricted;
        }
      }
      if (sameThread && initialClaim && !initialClaim.statesNetworkAccess && !currentCompaction) {
        const prefix = verifiedAcceptedPrefix(parsed, sameThread);
        const restricted = prefix && restrictedReadOnlyCwdContinuation(parsed, { ...sameThread, tools: [] }, prefix, initialClaim);
        // This combines a current decoded filesystem restriction with an exact accepted prefix.
        // It adds no grants, writes no cache proof, and never refreshes the original authority TTL.
        if (restricted) return restricted;
      }
      const calendarPrefix = sameThread && verifiedAcceptedPrefix(parsed, sameThread);
      const readOnlyCalendar = calendarPrefix && hasOnlyPermissionNeutralReadOnlyCalendarHistory(parsed, { ...sameThread!, tools: [] }, calendarPrefix);
      const forkParentId = forkedFromThreadId(parsed);
      if (!readOnlyCalendar && !initialClaim && !currentCompaction && forkParentId?.trim()
        && forkParentId !== identity.threadId && !lineage && rolloutIdentity?.threadId === identity.threadId) {
        const source = this.get(forkParentId);
        const rawMetadata = record(record(parsed._rawBody)?.client_metadata)?.["x-codex-turn-metadata"];
        const metadata = record(typeof rawMetadata === "string" ? JSON.parse(rawMetadata) : rawMetadata);
        const existingProofNeedsRepair = sameThread && verifiedAcceptedPrefix(parsed, sameThread)
          && !matchesAcceptedHistory(parsed, sameThread);
        if (source && (!sameThread || existingProofNeedsRepair
          && conflictingAuthorityFields({ environment: { ...sameThread, tools: [] }, statesNetworkAccess: true }, { ...source, tools: [] }, false).length === 0)
          && rolloutIdentity.sandboxType === source.sandboxPolicy.type && metadata?.network_access === undefined
          && (metadata?.cwd === undefined || typeof metadata.cwd === "string" && pathIdentity(metadata.cwd) === pathIdentity(source.cwd))
          && matchesAcceptedHistory(parsed, source, forkParentId)) {
          const environment = { cwd: source.cwd, roots: source.roots, writableRoots: source.writableRoots,
            sandboxPolicy: source.sandboxPolicy, tools: parsed.context.tools ?? [] };
          // This is an explicit native fork, not subagent ancestry or recovery migration.
          // Preserve the parent's authority expiry while recording this child's own prefix.
          const body = record(parsed._rawBody)!;
          const input = body.input as unknown[];
          // Retain the exact authority witness, not a longer prefix ending in this
          // child's instruction (which has no adjacent current environment packet).
          this.set(identity.threadId, environment, { ...parsed,
            _rawBody: { ...body, input: input.slice(0, source.acceptedHistory!.inputLength) },
          }, Math.min(source.updatedAt, sameThread?.updatedAt ?? source.updatedAt));
          return environment;
        }
      }
      // Proof-bearing caches require their authenticated immutable prefix. Legacy caches only permit
      // nonconflicting, fully decoded history; neither path accepts current updates.
      // Returning cached authority here never creates a proof or refreshes its age.
      // A browser preflight failure can leave no assistant separator. Only the
      // exact verified prefix can prove that its untagged environment is historical.
      if (!readOnlyCalendar && hasRawChatGptEnvironmentContext(parsed)
        && (!sameThread || (sameThread.acceptedHistory
          ? (hasCurrentContext && !historicalMessages) || !matchesAcceptedHistory(parsed, sameThread)
          : hasCurrentContext || !legacyChatGptEnvironmentClaims(parsed)?.every(claim => conflictingAuthorityFields({ environment: claim, statesNetworkAccess: true }, { ...sameThread, tools: [] }, false).length === 0)))) {
        error.resolutionBranch = "history_not_authenticated";
        throw error;
      }
      if (sameThread) {
        const rawMetadata = record(record(parsed._rawBody)?.client_metadata)?.["x-codex-turn-metadata"];
        const metadata = record(typeof rawMetadata === "string" ? JSON.parse(rawMetadata) : rawMetadata);
        if (metadata?.network_access !== undefined || metadata?.cwd !== undefined
          && (typeof metadata.cwd !== "string" || !isAbsolute(metadata.cwd)
            || pathIdentity(metadata.cwd) !== pathIdentity(sameThread.cwd))) {
          error.resolutionBranch = "current_context_unverified";
          throw error;
        }
        // Upgrade an old optional proof only from its exact already-verified witness.
        // Permissions, original digest/length and authority expiry remain unchanged.
        const proof = sameThread.acceptedHistory;
        if (proof && !proof.forkIndependent && identity.agentName === "/root") {
          const prefix = verifiedAcceptedPrefix(parsed, sameThread);
          const digest = prefix && forkIndependentDigest(prefix, identity.threadId);
          if (digest) {
            sameThread.acceptedHistory = { ...proof, forkIndependent: { version: 1, sha256: digest } };
            this.persist();
          }
        }
        return {
        cwd: sameThread.cwd,
        roots: sameThread.roots,
        writableRoots: sameThread.writableRoots,
        sandboxPolicy: sameThread.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };
      }

      if (!lineage) { error.resolutionBranch = "no_cache_or_lineage"; throw error; }
      const parent = this.get(lineage.parentThreadId);
      if (!parent) { error.resolutionBranch = "parent_cache_missing"; throw error; }
      if (lineage.sandboxType !== parent.sandboxPolicy.type) {
        throw new Error("ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread");
      }
      if (lineage.workspaceRoots.length > 0 && !lineage.workspaceRoots.some(root => contains(root, parent.cwd))) {
        throw new Error("ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd");
      }
      if (lineage.workspaceRoots.some(root => !parent.roots.some(parentRoot => (
        contains(parentRoot, root) || contains(root, parentRoot)
      )))) {
        throw new Error("ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots");
      }
      const inherited: ChatGptTurnEnvironment = {
        cwd: parent.cwd,
        roots: parent.roots,
        writableRoots: parent.writableRoots,
        sandboxPolicy: parent.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };
      this.set(lineage.threadId, inherited, undefined, parent.updatedAt);
      return inherited;
    }
  }

  private get(threadId: string): StoredThreadEnvironment | undefined {
    this.load();
    const stored = this.threads.get(threadId);
    if (!stored) return undefined;
    if (this.now() - stored.updatedAt > THREAD_ENVIRONMENT_TTL_MS) {
      this.threads.delete(threadId);
      this.persist();
      return undefined;
    }
    return stored;
  }

  private set(threadId: string, environment: ChatGptTurnEnvironment, parsed?: CodexParsedRequest, authorizedAt = this.now()): void {
    // Shared-home recovery uses current native proof, never the single-home cache.
    if (this.codexHomes.length > 1) return;
    // Only this path has already verified authority from the current request, native
    // rollout, or a successfully loaded parent. A cache read alone may never recover it.
    this.load(true);
    this.threads.delete(threadId);
    this.threads.set(threadId, authority(environment, authorizedAt, parsed));
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
    }
    this.persist();
  }

  private load(verifiedEnvironment = false): void {
    if (this.loaded) return;
    if (!this.path || !existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    const invalidState = (reason: string) => new ChatGptWebAdapterError(
      `The saved Codex task environment file (thread-environments.json) ${reason}. `
      + "Its contents have not been overwritten. Start a fresh Codex task to supply its current workspace and permissions. "
      + "If that also fails, export Activity > Export safe log; do not delete your launcher settings.",
      { status: 409, errorType: "invalid_request_error", code: "thread_environment_state_invalid", retryable: false },
    );
    const source = readFileSync(this.path, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      if (!verifiedEnvironment) throw invalidState("contains invalid JSON");
      // Preserve the original for diagnosis. Never infer permissions from a damaged cache,
      // discard an unfamiliar schema, or turn a read/rename permission error into recovery.
      if (readFileSync(this.path, "utf8") !== source) throw invalidState("changed during recovery");
      const backup = `${this.path}.corrupt-${crypto.randomUUID()}`;
      renameSync(this.path, backup);
      console.warn("[chatgpt-web] preserved corrupt thread-environments.json beside the original; rebuilding from a verified current Codex environment");
      this.loaded = true;
      return;
    }
    const parsed = record(decoded);
    const rawThreads = record(parsed?.threads);
    if (parsed?.version !== 1 || !rawThreads) throw invalidState("has an unsupported or invalid format");
    let entries: Array<readonly [string, StoredThreadEnvironment]>;
    try {
      const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
      entries = Object.entries(rawThreads)
        .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
        .filter(([, environment]) => environment.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_THREAD_ENVIRONMENTS);
    } catch {
      throw invalidState("contains invalid workspace or permission records");
    }
    for (const [threadId, environment] of entries) this.threads.set(threadId, environment);
    this.loaded = true;
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`, { durable: true });
  }
}
