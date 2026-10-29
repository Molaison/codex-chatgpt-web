import type { Locator } from "playwright-core";

export type NativeComposerModelIdentity41 = {
  slug: string;
  thinkingEffort: unknown;
  versionId: unknown;
  catalogTitle: unknown;
  workMode: unknown;
  premiumFallbackModelSlug: unknown;
};

/** Read the selected model directly from a closed composer control's React props. */
export async function readClosedNativeComposerModelIdentity41(
  control: Locator,
  composerSelector: string,
): Promise<NativeComposerModelIdentity41 | null> {
  return control.evaluate((element, composerSelector) => {
    if (!(element instanceof HTMLButtonElement) || !element.isConnected
      || element.getAttribute("aria-expanded") !== "false") return null;
    const form = element.closest("form");
    if (!form || form.querySelectorAll(composerSelector).length !== 1) return null;
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.matches('[hidden], [inert], [aria-hidden="true"]')) return null;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
    }
    const keys = Object.keys(element).filter(key => key.startsWith("__reactFiber$"));
    if (keys.length !== 1) return null;
    type ModelProps = {
      selectedModel?: { slug?: unknown; thinkingEffort?: unknown; versionId?: unknown };
      models?: { modelConfigBySlug?: Record<string, { title?: unknown; isWorkModeModel?: unknown }> };
      premiumFallbackModelSlug?: unknown;
    };
    type Fiber = { memoizedProps?: ModelProps; return?: Fiber | null };
    let fiber = (element as unknown as Record<string, Fiber>)[keys[0]];
    for (let depth = 0; fiber && depth < 64; depth++, fiber = fiber.return!) {
      const props = fiber.memoizedProps;
      if (!props?.selectedModel || !props.models?.modelConfigBySlug) continue;
      const selected = props.selectedModel;
      if (typeof selected.slug !== "string" || !Object.hasOwn(props, "premiumFallbackModelSlug")) return null;
      const catalog = props.models.modelConfigBySlug[selected.slug];
      if (!catalog) return null;
      return {
        slug: selected.slug,
        thinkingEffort: selected.thinkingEffort,
        versionId: selected.versionId,
        catalogTitle: catalog.title,
        workMode: catalog.isWorkModeModel,
        premiumFallbackModelSlug: props.premiumFallbackModelSlug,
      };
    }
    return null;
  }, composerSelector);
}

/** Read only the selected-model state owned by this slider's open composer menu. */
export async function readNativeComposerModelIdentity41(slider: Locator, composerSelector: string): Promise<NativeComposerModelIdentity41 | null> {
  return slider.evaluate((element, composerSelector) => {
    const menu = element.closest('[role="menu"]');
    if (!menu?.id) return null;
    const labelledBy = menu.getAttribute("aria-labelledby");
    if (!labelledBy || /\s/.test(labelledBy)) return null;
    const control = element.ownerDocument.getElementById(labelledBy);
    if (!(control instanceof HTMLButtonElement) || !control.isConnected ||
        control.getAttribute("aria-controls") !== menu.id || control.getAttribute("aria-expanded") !== "true") return null;
    const form = control.closest("form");
    if (!form || form.querySelectorAll(composerSelector).length !== 1) return null;
    // The structural slider itself is aria-hidden; its open menu owns the UI.
    for (const start of [menu, control]) {
      for (let node: Element | null = start; node; node = node.parentElement) {
        if (node.matches('[hidden], [inert], [aria-hidden="true"]')) return null;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
      }
    }
    const keys = Object.keys(control).filter(key => key.startsWith("__reactFiber$"));
    if (keys.length !== 1) return null;
    type ModelProps = {
      selectedModel?: { slug?: unknown; thinkingEffort?: unknown; versionId?: unknown };
      models?: { modelConfigBySlug?: Record<string, { title?: unknown; isWorkModeModel?: unknown }> };
      premiumFallbackModelSlug?: unknown;
    };
    type Fiber = { memoizedProps?: ModelProps; return?: Fiber | null };
    let fiber = (control as unknown as Record<string, Fiber>)[keys[0]];
    for (let depth = 0; fiber && depth < 64; depth++, fiber = fiber.return!) {
      const props = fiber.memoizedProps;
      if (!props?.selectedModel || !props.models?.modelConfigBySlug) continue;
      const selected = props.selectedModel;
      if (typeof selected.slug !== "string" || !Object.hasOwn(props, "premiumFallbackModelSlug")) return null;
      const catalog = props.models.modelConfigBySlug[selected.slug];
      if (!catalog) return null;
      return {
        slug: selected.slug,
        thinkingEffort: selected.thinkingEffort,
        versionId: selected.versionId,
        catalogTitle: catalog.title,
        workMode: catalog.isWorkModeModel,
        premiumFallbackModelSlug: props.premiumFallbackModelSlug,
      };
    }
    return null;
  }, composerSelector);
}

/** Exact observed native slugs, not radio text, 'latest', default catalog or auto. */
export function nativeComposerModelMatches41(identity: NativeComposerModelIdentity41 | null, family: string, effort: string): boolean {
  if (!identity || family !== "6" || (identity.versionId !== "latest" && identity.versionId !== "6") ||
      identity.workMode !== false || identity.premiumFallbackModelSlug !== null) return false;
  if (effort === "low") return identity.slug === "gpt-6" && identity.thinkingEffort === null && identity.catalogTitle === "GPT-6";
  if (effort === "max") return identity.slug === "gpt-6-pro" && identity.thinkingEffort === null && identity.catalogTitle === "GPT-6 Pro";
  const thinkingEffort = ({ medium: "standard", high: "extended", xhigh: "max" } as Record<string, string>)[effort];
  return thinkingEffort !== undefined && identity.slug === "gpt-6-thinking" &&
    identity.thinkingEffort === thinkingEffort && identity.catalogTitle === "GPT-6";
}
