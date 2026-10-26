import type { Page } from "playwright-core";
import type { LauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import type { NativeOperationScope } from "./native-execution";
import { CHATGPT_COMPOSER_SELECTOR } from "../../chatgpt-session";
import { readRetainedForwardPolicy, retainedForwardRejected, type RetainedForwardPolicy } from "./retained-forward-lane";

export interface RetainedForwardSurface {
  policy: RetainedForwardPolicy;
  surfaceId: string;
  targetId: string;
  attempted: boolean;
}
export function assertRetainedForwardHost(policy: RetainedForwardPolicy, descriptor: LauncherBrowserHostDescriptor): void {
  const h = policy.host;
  if (descriptor.pid !== h.pid || descriptor.observationInstanceId !== h.instanceId
    || descriptor.profile !== h.profile || descriptor.partition !== h.partition) return retainedForwardRejected();
}
export function retainedForwardWorkerPolicy(turn: { nativeOperationScope?: NativeOperationScope; nativeSubmissionIdentity?: boolean;
  observation?: unknown; compaction?: boolean; recoveryAttempt?: number; requireRetainedConversation?: boolean },
  accountId: string | undefined, descriptorPath: string | undefined): RetainedForwardPolicy | undefined {
  const policy = readRetainedForwardPolicy();
  if (!policy) return undefined;
  if (!policy.navigateNewEmptySurface || accountId !== policy.accountId || descriptorPath !== policy.descriptorPath
    || !turn.nativeSubmissionIdentity || turn.observation || turn.compaction || turn.recoveryAttempt || turn.requireRetainedConversation
    || turn.nativeOperationScope?.threadId !== policy.allow.threadId || turn.nativeOperationScope.turnId !== policy.allow.turnId
    || policy.deny.traceIds.includes(turn.nativeOperationScope.traceId)) return retainedForwardRejected();
  return policy;
}
export function retainedForwardNewLease(policy: RetainedForwardPolicy,
  before: LauncherBrowserHostDescriptor, after: LauncherBrowserHostDescriptor,
  lease: { surfaceId?: string; reused?: boolean }): RetainedForwardSurface {
  assertRetainedForwardHost(policy, before); assertRetainedForwardHost(policy, after);
  const surfaceId = lease.surfaceId, targetId = surfaceId && after.surfaceTargets[surfaceId];
  if (lease.reused !== false || !surfaceId || !targetId || before.surfaceTargets[surfaceId]
    || Object.values(before.surfaceTargets).includes(targetId)
    || policy.deny.surfaceIds.includes(surfaceId) || policy.deny.targetIds.includes(targetId)) return retainedForwardRejected();
  return { policy, surfaceId, targetId, attempted: false };
}

/** One full navigation of a freshly leased EMPTY root, never a saved or retained page. */
export async function navigateRetainedForwardEmptySurface(page: Page, proof: RetainedForwardSurface,
  descriptor: () => LauncherBrowserHostDescriptor, signal?: AbortSignal): Promise<void> {
  function fence(): void {
    signal?.throwIfAborted();
    const d = descriptor();
    assertRetainedForwardHost(proof.policy, d);
    if (d.surfaceTargets[proof.surfaceId] !== proof.targetId || page.isClosed()) return retainedForwardRejected();
  }
  async function target(): Promise<void> {
    fence();
    const session = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      if (targetInfo.targetId !== proof.targetId) return retainedForwardRejected();
    } finally { await session.detach(); }
    fence();
  }
  async function empty(): Promise<boolean> {
    return page.evaluate(({ surfaceId, composer }) => {
      const w = globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: string };
      const editors = [...document.querySelectorAll<HTMLElement>(composer)].filter(e => e.getClientRects().length > 0);
      return location.href === "https://chatgpt.com/" && document.readyState !== "loading"
        && w.__CODEX_WEB_GPT_SURFACE_ID__ === surfaceId && document.documentElement.dataset.codexWebGptSurface === surfaceId
        && editors.length === 1 && editors[0]!.getAttribute("contenteditable") === "true" && !editors[0]!.textContent?.trim()
        && !document.querySelector("[data-message-author-role],[data-turn-id-container],[data-turn-key],[data-testid='stop-button']")
        && ![...document.querySelectorAll<HTMLInputElement>("input[type=file]")].some(e => e.files?.length)
        && !document.querySelector("[data-testid*='attachment'],[data-testid*='file-chip']");
    }, { surfaceId: proof.surfaceId, composer: CHATGPT_COMPOSER_SELECTOR });
  }
  if (proof.attempted) return retainedForwardRejected();
  await target();
  if (!await empty()) return retainedForwardRejected();
  fence();
  proof.attempted = true; // Any ambiguous navigation is non-retryable under this lease.
  const navigation = page.goto("https://chatgpt.com/", { waitUntil: "load", timeout: 30_000 });
  if (signal) {
    let aborted!: () => void;
    const interruption = new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason ?? new DOMException("Forward navigation aborted", "AbortError"));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
    try { await Promise.race([navigation, interruption]); }
    finally { signal.removeEventListener("abort", aborted); }
  } else await navigation;
  await target();
  await page.waitForFunction(surfaceId => (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: string })
    .__CODEX_WEB_GPT_SURFACE_ID__ === surfaceId && document.documentElement.dataset.codexWebGptSurface === surfaceId,
  proof.surfaceId, { timeout: 5000 });
  fence();
  if (!await empty()) return retainedForwardRejected();
  await target();
}
