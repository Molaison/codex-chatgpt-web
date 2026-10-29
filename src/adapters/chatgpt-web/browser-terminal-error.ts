export interface ChatGptBoundTurnErrorEvidence {
  signal: "legacy-retry" | "semantic-retry" | "localized-error" | "unclassified-alert";
  identity: string;
  text: string;
}

export function readChatGptBoundTurnError(
  root: HTMLElement,
  options: { stopSelector: string },
): ChatGptBoundTurnErrorEvidence | undefined {
  if (!root?.isConnected) return undefined;
  const rendered = (candidate: Element): boolean => {
    if (!candidate.isConnected) return false;
    for (let node: Element | null = candidate; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true"
        || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  };
  if ([...root.ownerDocument.querySelectorAll(options.stopSelector)].some(rendered)) return undefined;
  const identity = root.getAttribute("data-turn-key") ?? root.getAttribute("data-turn-id") ?? "";
  const activityContainers = [...root.querySelectorAll("[data-chatgpt-agent-turn-start]")]
    .map(marker => marker.parentElement!);
  const excluded = '[data-user-message-bubble], [data-message-author-role="user"], [data-conversation-role="user"], '
    + '[data-content-search-unit-key$=":user"], .markdown, [data-markdown-text-style], .puik-root, '
    + 'pre, code, blockquote, [data-streaming-response-status], [data-tool-result], [data-tool-output], '
    + '[data-tool-call-id], [class~="group/resource-row"], [data-testid="tool-approval-card"], '
    + '[data-codex-approval-surface], [role="dialog"]';
  const owned = (candidate: Element): boolean => {
    if (!root.contains(candidate) || candidate.closest(excluded) || !rendered(candidate)) return false;
    if (activityContainers.some(container => container.contains(candidate))) return false;
    if (root.hasAttribute("data-turn-key") && candidate.closest("[data-turn-key]") !== root) return false;
    const unit = candidate.closest("[data-content-search-unit-key]");
    return !unit || ![...unit.children].some(child => child.getAttribute("data-conversation-role") === "user");
  };
  const retryLabel = /^(?:retry|try again|重试|重試|再试一次|再試一次|重新尝试|重新嘗試|다시 시도|再試行|réessayer|reintentar|erneut versuchen|повторить)(?:[.!。！])?$/i;
  const retry = (scope: Element): boolean => [...scope.querySelectorAll("button, [role=button]")]
    .some(button => owned(button) && !button.matches('[disabled], [aria-disabled="true"]')
      && retryLabel.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()));
  for (const candidate of root.querySelectorAll('[data-testid="regenerate-thread-error-button"]')) {
    if (owned(candidate)) return { signal: "legacy-retry", identity, text: "" };
  }
  const errorText = /something went wrong|an error occurred|error (?:generating|while generating)|failed to (?:generate|respond)|出(?:了点|现了|現了)?(?:问题|問題)|发生(?:了)?错误|發生(?:了)?錯誤|出错|出錯|生成.{0,12}(?:失败|失敗)|无法生成|無法產生|응답.{0,20}오류|エラーが発生|une erreur|ha ocurrido un error|ein fehler|произошла ошибка/i;
  const notice = /(?:waiting for|awaiting).{0,30}(?:approval|permission|tool)|^(?:(?:still|currently) )?(?:generating|working|connecting|reconnecting|processing)(?:\.{1,3}|…)?$|等待.{0,20}(?:授权|授權|批准|工具)|正在(?:生成|处理|處理|连接|連線)|需要(?:授权|授權|批准)|allow chatgpt to use/i;
  let ambiguous: ChatGptBoundTurnErrorEvidence | undefined;
  for (const alert of root.querySelectorAll('[role="alert"]')) {
    if (!owned(alert)) continue;
    const text = (alert.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || notice.test(text)) continue;
    const evidence = { identity, text: text.slice(0, 512) };
    if (retry(alert)) return { ...evidence, signal: "semantic-retry" };
    if (errorText.test(text)) return { ...evidence, signal: "localized-error" };
    ambiguous = { ...evidence, signal: "unclassified-alert" };
  }
  for (const button of root.querySelectorAll("button, [role=button]")) {
    if (!owned(button) || button.matches('[disabled], [aria-disabled="true"]')
      || !retryLabel.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim())) continue;
    const panel = button.parentElement;
    const text = panel?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (panel && owned(panel) && text.length < 2_048 && errorText.test(text)) {
      return { signal: "semantic-retry", identity, text: text.slice(0, 512) };
    }
  }
  return ambiguous;
}

export interface ChatGptOwnedSseError {
  kind: "size" | "terminal";
  code: string;
}

export function readChatGptOwnedSseError(body: string): ChatGptOwnedSseError | undefined {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      if (event.error_code === "input_too_large" && event.error_reason === "last_user_message"
        && typeof event.error === "string" && event.error.length > 0) {
        return { kind: "size", code: "input_too_large" };
      }
      const explicit = lines.some(line => /^event:\s*error\s*$/.test(line));
      const error = event.error;
      const errorObject = error && typeof error === "object" && !Array.isArray(error);
      const code = typeof event.error_code === "string" ? event.error_code
        : errorObject && typeof error.code === "string" ? error.code
        : errorObject && typeof error.type === "string" ? error.type : "";
      const message = typeof error === "string" ? error
        : errorObject && typeof error.message === "string" ? error.message
        : explicit && typeof event.message === "string" ? event.message : "";
      if ((message || errorObject) && (explicit || code)) {
        return { kind: "terminal", code: (code || "sse_error").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96) };
      }
    } catch {}
  }
  return undefined;
}
