import { expect, test } from "bun:test";
import { buildChatGptWebModel } from "../src/model-catalog";
import { availableChatGptWebModelRoutes, requireChatGptWebModelRoute } from "../src/chatgpt-web-models";

const config: any = { mode: "full", browserInteractionMode: "automatic", solAvailable: true,
  proAvailable: true, extraHighAvailable: true, subagentProtocol: "compatibility-v1" };
const template = { slug: "native-fixture", priority: 1, multi_agent_version: "v1",
  multi_agent_reasoning_effort: "high", supported_reasoning_levels: [] };

test("hidden legacy Pro advertises an explicit ordinary Max target for Native Ultra", () => {
  const route = requireChatGptWebModelRoute("chatgpt-web/pro", config, "ultra");
  const model: any = buildChatGptWebModel(template, route, config);
  expect(model.default_reasoning_level).toBe("ultra");
  expect(model.visibility).toBe("hide");
  expect(model.multi_agent_reasoning_effort).toBe("max");
  expect(model.supported_reasoning_levels.map((v: any) => v.effort)).toEqual(["max", "ultra", "ultra-temporary"]);
});

test("legacy Pro retains old Ultra input identity and fixed browser Max", () => {
  for (const effort of [undefined, "ultra", "max", "medium"]) {
    const route: any = requireChatGptWebModelRoute("chatgpt-web/pro", config, effort);
    expect(route.codexEffort).toBe("ultra");
    expect(route.adapterEffort).toBe("max");
    expect(route.requiresPro).toBe(true);
  }
});

test("selectors retain their supported default while other routes inherit the native effort", () => {
  for (const route of availableChatGptWebModelRoutes(config, true)) {
    if (route.slug === "chatgpt-web/pro") continue;
    const model: any = buildChatGptWebModel(template, route, config);
    expect(model.multi_agent_reasoning_effort).toBe(route.toolAccess ? "xhigh" : "high");
    if (route.toolAccess) {
      expect(model.supported_reasoning_levels.map((value: { effort: string }) => value.effort))
        .toContain(model.multi_agent_reasoning_effort);
    }
  }
});
