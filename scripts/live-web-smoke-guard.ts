import type { AppConfig } from "../src/config";
import { isCodexComposerPrediction } from "../src/adapters/chatgpt-web/environment";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";

export const WEB_SUBAGENT_SMOKE_MODEL = "chatgpt-web/gpt-5.6-sol";

function smokeEndpoint(config: AppConfig): string {
  if (config.host !== "127.0.0.1" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || config.browserHost !== "launcher" || config.subagentProtocol !== "compatibility-v1"
    || config.browserInteractionMode !== "automatic" || !config.solAvailable) {
    throw new Error("Web subagent smoke requires a loopback automatic launcher with Compatibility V1 and Sol");
  }
  return `http://${config.host}:${config.port}/v1/responses`;
}

function assertSmokeRequest(raw: unknown, config: AppConfig): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a Responses object");
  const body = raw as Record<string, unknown>;
  const reasoning = body.reasoning;
  const effort = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
    ? (reasoning as Record<string, unknown>).effort : undefined;
  if (body.model !== WEB_SUBAGENT_SMOKE_MODEL || (effort !== "medium" && effort !== "high")
    || isCodexComposerPrediction(raw)) {
    throw new Error("Only explicit GPT-5.6 Sol Medium or High requests are permitted");
  }
  const parsed = parseRequest(raw);
  const route = routeChatGptWebRequest(parsed, config);
  if (route.interactionMode !== "automatic" || route.requiresPro || route.modelFamily !== "5.6"
    || parsed.modelId !== "gpt-5.6-sol" || parsed._chatgptModelFamily !== "5.6"
    || parsed._chatgptProModel || parsed.options.reasoning !== effort) {
    throw new Error("The production route did not resolve to the pinned non-Pro smoke model");
  }
}

export function webSubagentSmokeCatalog(nativeCatalog: unknown, config: AppConfig): Record<string, unknown> {
  smokeEndpoint(config);
  for (const effort of ["medium", "high"]) {
    assertSmokeRequest({ model: WEB_SUBAGENT_SMOKE_MODEL, reasoning: { effort }, input: "smoke preflight" }, config);
  }
  const catalog = augmentNativeModelCatalog(nativeCatalog, config);
  const models = (catalog.models as Array<Record<string, unknown>>)
    .filter(model => model.slug === WEB_SUBAGENT_SMOKE_MODEL)
    .map(model => ({
      ...model,
      default_reasoning_level: "medium",
      supported_reasoning_levels: (model.supported_reasoning_levels as Array<Record<string, unknown>>)
        .filter(level => level.effort === "medium" || level.effort === "high"),
    }));
  if (models.length !== 1) throw new Error("The pinned smoke model is absent or ambiguous in the catalog");
  return { ...catalog, models };
}

function rejection(status: number, code: string): Response {
  return Response.json({ error: { type: "smoke_guard_error", code,
    message: "Web subagent smoke stopped without a model fallback." } }, { status });
}

export function createWebSubagentSmokeGuard(readConfig: () => AppConfig) {
  const endpoint = smokeEndpoint(readConfig());
  const active = new Map<AbortController, () => void>();
  let closed = false;
  let failure: string | undefined;
  const fail = (status: number, code: string) => {
    failure ??= code;
    return rejection(status, code);
  };
  return {
    get failure(): string | undefined { return failure; },
    async fetch(request: Request): Promise<Response> {
      if (closed) return rejection(503, "smoke_guard_closed");
      if (failure) return rejection(403, "smoke_guard_failed");
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/responses" || url.search) {
        return fail(404, "smoke_endpoint_rejected");
      }
      if (request.signal.aborted) return rejection(499, "smoke_request_cancelled");
      let body: string;
      try {
        body = await request.text();
        const config = readConfig();
        if (smokeEndpoint(config) !== endpoint) throw new Error("The bridge endpoint changed");
        assertSmokeRequest(JSON.parse(body), config);
      } catch {
        return request.signal.aborted ? rejection(499, "smoke_request_cancelled")
          : fail(403, "smoke_model_rejected");
      }
      if (closed) return rejection(503, "smoke_guard_closed");
      if (failure) return rejection(403, "smoke_guard_failed");
      if (request.signal.aborted) return rejection(499, "smoke_request_cancelled");

      const controller = new AbortController();
      const cleanup = () => {
        request.signal.removeEventListener("abort", abort);
        active.delete(controller);
      };
      const abort = () => {
        controller.abort(request.signal.reason);
        cleanup();
      };
      request.signal.addEventListener("abort", abort, { once: true });
      active.set(controller, cleanup);
      try {
        const headers = new Headers(request.headers);
        for (const name of ["host", "content-length", "connection", "transfer-encoding"]) headers.delete(name);
        const response = await fetch(endpoint, {
          method: "POST", headers, body, signal: controller.signal, redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          controller.abort();
          cleanup();
          return fail(502, "smoke_upstream_redirect");
        }
        const responseHeaders = new Headers(response.headers);
        for (const name of ["content-length", "content-encoding", "connection", "transfer-encoding"]) {
          responseHeaders.delete(name);
        }
        const reader = response.body?.getReader();
        if (!reader) {
          cleanup();
          return new Response(null, { status: response.status, headers: responseHeaders });
        }
        const stream = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              const next = await reader.read();
              if (next.done) {
                cleanup();
                output.close();
              } else output.enqueue(next.value);
            } catch (error) {
              if (!controller.signal.aborted) failure ??= "smoke_upstream_failed";
              cleanup();
              output.error(error);
            }
          },
          cancel(reason) {
            controller.abort(reason);
            cleanup();
            void reader.cancel(reason).catch(() => {});
          },
        });
        return new Response(stream, { status: response.status, headers: responseHeaders });
      } catch {
        cleanup();
        return request.signal.aborted || controller.signal.aborted
          ? rejection(499, "smoke_request_cancelled") : fail(502, "smoke_upstream_failed");
      }
    },
    close(): void {
      closed = true;
      for (const [controller, cleanup] of active) {
        controller.abort();
        cleanup();
      }
    },
  };
}
