import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {chromium} from "playwright-core";
import {ChatGptBrowserWorker} from "../src/adapters/chatgpt-web/browser-worker";
import {ChatGptMarkdownBuffer,type ChatGptMarkdownSegment} from "../src/adapters/chatgpt-web/markdown";

const browserTest=test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER || !process.env.CORE_SLOT35_FIXTURE);
browserTest("captured slot35's forty repeated blocks retain exact DOM identities across witnessed whole-root remount",async()=>{
  const fixture=JSON.parse(readFileSync(process.env.CORE_SLOT35_FIXTURE!,"utf8"));
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true,args:["--no-sandbox"]});
  try {
    const page=await browser.newPage();await page.setContent(`<section id="turn"><div class="markdown">${fixture.fullHtml}</div></section>`);
    const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
    const first=await worker.responseDomSnapshot(page.locator("#turn")) as {markdownSegments:ChatGptMarkdownSegment[]};
    expect(first.markdownSegments).toHaveLength(41);
    const buffer=new ChatGptMarkdownBuffer(undefined,0);
    const prefix=buffer.observe(first.markdownSegments,0);expect(prefix.length).toBeGreaterThan(1000);
    await page.locator(".markdown").evaluate(root=>{root.innerHTML=root.innerHTML;});
    const remounted=await worker.responseDomSnapshot(page.locator("#turn")) as {markdownSegments:ChatGptMarkdownSegment[]};
    expect(remounted.markdownSegments.map(s=>s.key)).toEqual(first.markdownSegments.map(s=>s.key));
    expect(buffer.observe(remounted.markdownSegments,1)).toBe("");
    const final=buffer.finish();expect(prefix+final.delta).toBe(final.markdown);
    const expected=new ChatGptMarkdownBuffer(undefined,0);expected.observe(first.markdownSegments,0);
    expect(final.markdown).toBe(expected.finish().markdown);
    expect(final.markdown.length).toBeGreaterThan(5000);
  } finally {await browser.close();}
},15000);

browserTest("an edited whole-child replacement cannot inherit partial identities for repeated blocks", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent('<section id="turn"><div class="markdown"><p>repeat</p><p>repeat</p><p>tail</p></div></section>');
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const first = await worker.responseDomSnapshot(page.locator("#turn"));
    await page.locator(".markdown").evaluate(root => { root.innerHTML = root.innerHTML.replace("tail", "edited"); });
    const edited = await worker.responseDomSnapshot(page.locator("#turn"));
    const previous = new Set(first.markdownSegments.map((segment: ChatGptMarkdownSegment) => segment.key));
    expect(edited.markdownSegments).toHaveLength(3);
    expect(edited.markdownSegments.every((segment: ChatGptMarkdownSegment) => !previous.has(segment.key))).toBe(true);
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    buffer.observe(first.markdownSegments, 0);
    buffer.observe(edited.markdownSegments, 1);
    expect(() => buffer.finish()).toThrow();
  } finally { await browser.close(); }
}, 15000);

browserTest("witnessed remount retains repeated blocks while the original response continues growing", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent('<button aria-label="Stop generating"></button><section id="turn"><div class="markdown"><p>Repeated.</p><p>Repeated.</p><p>Anchor.</p><p>Growing.</p></div></section>');
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const first = await worker.responseDomSnapshot(page.locator("#turn"));
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    const prefix = buffer.observe(first.markdownSegments, 0);
    await page.locator(".markdown").evaluate(root => { root.innerHTML = root.innerHTML; });
    const remount = await worker.responseDomSnapshot(page.locator("#turn"));
    expect(buffer.observe(remount.markdownSegments, 1)).toBe("");
    await page.locator(".markdown").evaluate(root => {
      root.lastElementChild!.textContent = "Growing answer.";
      const tail = document.createElement("p"); tail.textContent = "Final."; root.append(tail);
    });
    const growing = await worker.responseDomSnapshot(page.locator("#turn"));
    const delta = buffer.observe(growing.markdownSegments, 2);
    expect(await page.locator('[aria-label="Stop generating"]').isVisible()).toBe(true);
    const final = buffer.finish();
    expect(prefix + delta + final.delta).toBe("Repeated.\n\nRepeated.\n\nAnchor.\n\nGrowing answer.\n\nFinal.");
    expect(final.markdown).toBe(prefix + delta + final.delta);
  } finally { await browser.close(); }
}, 15000);
