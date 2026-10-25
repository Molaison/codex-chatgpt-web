import { expect, test } from "bun:test";
import { localChatGptWebModelCatalog } from "../src/model-catalog";
import { routeChatGptWebRequest } from "../src/server";
import { requireChatGptWebModelRoute, availableChatGptWebModelRoutes } from "../src/chatgpt-web-models";
const config: any = { mode: "full", solAvailable: true, extraHighAvailable: true, proAvailable: true, subagentProtocol: "compatibility-v1" };
test("original eight selectors, Pro in max, legacy sessions hidden and preserved", () => {
 const models: any[] = localChatGptWebModelCatalog(config).models as any[];
 const visible = models.filter(m => m.visibility === "list");
 expect(visible).toHaveLength(8);
 for (const m of visible) {
  expect(m.slug).toMatch(/gpt-(5\.6|6)-(chat|tools)-(persist|temp)$/);
  expect(m.supported_reasoning_levels.map((x:any)=>x.effort)).toEqual(["high","xhigh","max"]);
  expect(m.supported_reasoning_levels[2].description).toBe("Pro");
  expect(m.default_reasoning_level).toBe("xhigh");
  expect(m.multi_agent_version).toBe("v1");
  if(m.slug.includes("-chat-")) {
   expect(m.shell_type).toBe("disabled");
   expect(m.apply_patch_tool_type).toBeNull();
   expect(m.experimental_supported_tools).toEqual([]);
  }
 }
 expect(models.find(m=>m.slug==="chatgpt-web/gpt-5.6-sol-instant").visibility).toBe("hide");
});
for (const family of ["5.6","6"]) for (const tools of ["chat","tools"]) for (const mode of ["persist","temp"]) {
 test(`selector ${family}/${tools}/${mode}: exact capabilities, session, Pro`, () => {
  for (const effort of ["high","xhigh","max"]) {
   const p:any={modelId:`chatgpt-web/gpt-${family}-${tools}-${mode}`,options:{reasoning:effort}};
   routeChatGptWebRequest(p,config);
   expect(p._chatgptSessionMode).toBe(mode==="persist"?"persistent":"temporary");
   expect(p._chatgptLocalTools).toBe(tools==="tools");
   expect(p._chatgptModelFamily).toBe(family);
   expect(p._chatgptProModel===true).toBe(effort==="max");
  }
 });
}
test("no Full escalation, no unowned Pro, no persist/temporary ambiguity",()=>{
 expect(()=>requireChatGptWebModelRoute("chatgpt-web/gpt-6-tools-persist",{...config,mode:"browser-only"})).toThrow();
 expect(()=>requireChatGptWebModelRoute("chatgpt-web/gpt-6-tools-persist",{...config,proAvailable:false},"max")).toThrow();
 expect(()=>routeChatGptWebRequest({modelId:"chatgpt-web/gpt-6-tools-persist",options:{reasoning:"high-temporary"}} as any,config)).toThrow();
 expect(availableChatGptWebModelRoutes({...config,mode:"browser-only"}).some(r=>r.toolAccess)).toBe(false);
});
