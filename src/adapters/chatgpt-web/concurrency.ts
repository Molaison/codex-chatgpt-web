/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;
export const DEFAULT_CHATGPT_STANDARD_CONCURRENCY = 5;
export const DEFAULT_CHATGPT_PRO_CONCURRENCY = 2;
