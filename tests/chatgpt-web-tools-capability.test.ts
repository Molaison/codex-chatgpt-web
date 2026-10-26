import { expect, test } from "bun:test";
import { defaultConfig, providerConfig } from "../src/config";
import { availableChatGptWebModelRoutes, requireChatGptWebModelRoute } from "../src/chatgpt-web-models";
import { localChatGptWebModelCatalog } from "../src/model-catalog";
import { responseRequest } from "../src/server";

test.each([undefined, "openai-tunnel"] as const)("automatic Full with %s exposes only its available Chat selectors", async mcpProvider => {
  const config = { ...defaultConfig("full"), browserHost: "launcher" as const, mcpProvider };
  expect(providerConfig(config).chatgptWeb?.localToolsEnabled).toBeFalse();
  const routes = availableChatGptWebModelRoutes(config);
  expect(routes).toHaveLength(4);
  expect(routes.every(route => route.toolAccess === "chat")).toBeTrue();
  const models = localChatGptWebModelCatalog(config).models as Array<{ slug: string; visibility: string }>;
  expect(models.filter(model => model.visibility === "list").map(model => model.slug)).toEqual(routes.map(route => route.slug));
  let invoked = false;
  const response = await responseRequest(new Request("http://isolated.test/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "chatgpt-web/gpt-6-tools-persist", input: "Use tools", stream: false,
      reasoning: { effort: "high" } }),
  }), config, () => {
    invoked = true;
    return { name: "must-not-run", async runTurn(_parsed, _request, emit) { emit({ type: "done", endTurn: true }); } };
  }, { rememberState: false });
  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toContain("Tools");
  expect(invoked).toBeFalse();
});

test("configured external Full retains all eight selectors and exact Tools capability", () => {
  const config = { ...defaultConfig("full"), browserHost: "launcher" as const, mcpProvider: "external-http" as const };
  expect(providerConfig(config).chatgptWeb?.localToolsEnabled).toBeTrue();
  const routes = availableChatGptWebModelRoutes(config);
  expect(routes).toHaveLength(8);
  expect(routes.filter(route => route.toolAccess === "tools")).toHaveLength(4);
  expect(requireChatGptWebModelRoute("chatgpt-web/gpt-6-tools-persist", config, "high").toolAccess).toBe("tools");
  expect(() => requireChatGptWebModelRoute("chatgpt-web/gpt-6-tools-persist", { ...config, mode: "browser-only" }, "high")).toThrow("Full");
});

test("manual Full keeps its existing explicit tool capability and separate model catalog", () => {
  const config = { ...defaultConfig("full"), browserHost: "launcher" as const, browserInteractionMode: "manual" as const };
  expect(providerConfig(config).chatgptWeb?.localToolsEnabled).toBeTrue();
  expect(availableChatGptWebModelRoutes(config).map(route => route.slug)).toEqual(["chatgpt-web/zero-risk"]);
});
