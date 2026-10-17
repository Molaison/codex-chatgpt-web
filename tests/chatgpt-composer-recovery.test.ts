import { expect, test } from "bun:test";
import { assertAuthenticatedChatGptPage } from "../src/chatgpt-session";
import { classifyError, inferHttpStatusFromAdapterMessage } from "../src/lib/errors";

function pageWithComposer(visible: () => boolean) {
  const composer = { count: async () => 1, nth: () => composer, isVisible: async () => visible() };
  return { locator: () => composer } as any;
}

test("a composer removed during hydration may reappear without invalidating login", async () => {
  let checks = 0;
  await assertAuthenticatedChatGptPage(pageWithComposer(() => ++checks >= 3), 1_000);
  expect(checks).toBeGreaterThanOrEqual(3);
});

test("a missing composer is retryable upstream unavailability, never invalid_api_key", async () => {
  let error: Error | undefined;
  try { await assertAuthenticatedChatGptPage(pageWithComposer(() => false), 0); }
  catch (caught) { error = caught as Error; }
  expect(error).toBeInstanceOf(Error);
  const message = error!.message;
  const status = inferHttpStatusFromAdapterMessage(message);
  expect(status).toBe(503);
  expect(classifyError(status, "server_error", message)).toMatchObject({
    type: "server_error", code: "server_is_overloaded",
  });
});

test("explicit expired-session authentication errors remain 401", () => {
  expect(classifyError(401, "authentication_error", "The ChatGPT session has expired. Sign in again.")).toMatchObject({
    type: "authentication_error", code: "invalid_api_key",
  });
});
