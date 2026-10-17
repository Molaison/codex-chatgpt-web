import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

// All browser execution is replaced before constructing the adapter. No browser,
// credentials, remote service, or real tool execution participates in this test.
const root = mkdtempSync(join(tmpdir(), "mol185-submit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function request(id: string): CodexParsedRequest {
  const threadId = `thread_${id}`;
  const turnId = `turn_${id}`;
  const text = "Inspect the project";
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [{
        type: "message", role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    },
  };
}

test.each([
  ["prepared", "upstream_server_error", true, 502, "server_error"],
  ["send_activated", "upstream_server_error", true, 502, "server_error"],
  ["accepted", "upstream_server_error", true, 502, "server_error"],
  ["accepted", "client_cancelled", false, 499, "client_closed_request"],
  ["accepted", "invalid_api_key", false, 401, "authentication_error"],
] as const)(
  "submission phase %s safely handles typed %s (retryable=%s)",
  async (phase, code, retryable, status, errorType) => {
    const id = randomUUID();
    const socketPath = defaultBrokerEndpoint(join(root, id));
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web", baseUrl: `browser://mol185-submission-${id}`,
      chatgptWeb: {
        brokerSocketPath: socketPath,
        threadEnvironmentStatePath: join(root, `${id}-environment.json`),
        conversationStoreDirectory: join(root, `${id}-conversations`),
        localToolsEnabled: false,
        solAvailable: true, extraHighAvailable: true, proAvailable: true,
      },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run;
    let browserStarts = 0;
    let sendActivations = 0;
    let acceptedSubmissions = 0;
    worker.run = async turn => {
      browserStarts += 1;
      if (phase !== "prepared") {
        sendActivations += 1;
        turn.onSendActivated?.();
      }
      if (phase === "accepted") {
        acceptedSubmissions += 1;
        turn.onSubmitted?.();
      }
      throw new ChatGptWebAdapterError("Injected transient transport failure", {
        status, errorType, code, retryable,
      });
    };
    try {
      const input = request(id);
      const outcomes: AdapterEvent[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const events: AdapterEvent[] = [];
        await createChatGptWebAdapter(provider).runTurn!(input, { headers: new Headers() }, event => events.push(event));
        outcomes.push(events.at(-1)!);
      }
      console.info("MOL185_SUBMISSION_RETRY", JSON.stringify({ phase, injectedCode: code, browserStarts, sendActivations, acceptedSubmissions, outcomes }));
      if (phase === "prepared") {
        expect(browserStarts).toBe(2);
        expect(sendActivations).toBe(0);
        for (const outcome of outcomes) expect(outcome).toMatchObject({ type: "error", retryable: true, code: "upstream_server_error" });
      } else {
        // An exact native reconnect must replay the original non-retryable
        // failure, never start another possibly side-effectful submission.
        expect(browserStarts).toBe(1);
        expect(sendActivations).toBe(1);
        expect(acceptedSubmissions).toBe(phase === "accepted" ? 1 : 0);
        for (const outcome of outcomes) expect(outcome).toMatchObject({
          type: "error", retryable: false,
          code: !retryable ? code : phase === "send_activated" ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
          ...(!retryable ? { status, errorType, message: "Injected transient transport failure" } : {}),
        });
      }
    } finally {
      worker.run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  },
);
