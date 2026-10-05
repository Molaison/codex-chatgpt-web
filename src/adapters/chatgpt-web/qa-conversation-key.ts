import { createHash } from "node:crypto";

export function chatGptQuestionAnswerNamespace(accountId = "default"): string {
  return createHash("sha256").update(JSON.stringify({ schema: "chatgpt-web/qa-account/v1", accountId })).digest("hex");
}

export function chatGptQuestionAnswerKey(threadId: string, namespace: string): string {
  return createHash("sha256").update(JSON.stringify({ namespace, threadId, purpose: "question-answer" })).digest("hex");
}
