import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "../src/responses/state";

const home = process.env.CODEX_CHATGPT_WEB_HOME;
const directory = mkdtempSync(join(tmpdir(), "observed-receipt-"));
process.env.CODEX_CHATGPT_WEB_HOME = directory;
afterAll(() => {
  flushResponseState();
  if (home === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = home;
  rmSync(directory, { recursive: true, force: true });
});

test("streaming span hydration cannot change mid-paragraph HTTP or exit-code punctuation", () => {
  const text = "Before returning HTTP 200. The process exit status was 0. No resend.";
  const html = "<p><span>Before returning HTTP </span><span>200. The process exit status was </span>"
    + "<span><span>0. No resend.</span></span></p>";
  const streamed = new ChatGptMarkdownBuffer(undefined, 0);
  expect(streamed.observe([{ key: "original", tag: "p", html, text, streamable: true }])).toBe(text);
  streamed.observe([{ key: "original", tag: "p", html: `<p><span>${text}</span></p>`, text, streamable: true }]);
  expect(streamed.finish().markdown).toBe(chatGptHtmlToMarkdown(`<p>${text}</p>`));
});

test("presentation spans still escape real numbered prose and preserve real lists, code, links and emphasis", () => {
  expect(chatGptHtmlToMarkdown("<p><span>200.</span> The caller</p>")).toBe("200\\. The caller");
  expect(chatGptHtmlToMarkdown('<ol start="2"><li><span>Two</span></li><li>Three</li></ol>'))
    .toBe("2. Two\n3. Three");
  expect(chatGptHtmlToMarkdown('<p><span><strong>Bold</strong> <a href="https://example.com">link</a></span></p>'))
    .toBe("**Bold** [link](https://example.com)");
  expect(chatGptHtmlToMarkdown('<pre><code><span>200. literal_[]</span></code></pre>'))
    .toBe("```\n200. literal_[]\n```");
});

function receipt(id: string, text: string, phase = "final_answer") {
  return { id, type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] };
}

test("journal-proven partial receipts are replaced by complete items in previous_response_id history", () => {
  const user = { type: "message", id: "u", role: "user", content: "Original task" };
  const result = { type: "function_call_output", id: "tool-result", call_id: "call", output: "SIDE_EFFECT_DONE" };
  const reasoning = { type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "Checked" }] };
  const commentary = receipt("comment", "Checking", "commentary");
  const partial = receipt("answer", "Repeat.\n\nRepeat.");
  const complete = receipt("answer", "Repeat.\n\nRepeat.\n\nFinished.");
  const request = { store: false, input: [user, result, reasoning, commentary, partial] };
  const output = [reasoning, commentary, complete];
  rememberResponseState(request, { id: "restored", output, status: "completed" },
    { force: true, replaceObservedItems: true });
  const followup = { type: "message", role: "user", content: "Continue" };
  expect((expandPreviousResponseInput({ previous_response_id: "restored", input: [followup] }) as any).input)
    .toEqual([user, result, ...output, followup]);
  expect(request.input).toEqual([user, result, reasoning, commentary, partial]);
});

test("unproven callers and different item IDs retain their original cache semantics", () => {
  const partial = receipt("partial", "Same text");
  const other = receipt("other", "Same text");
  for (const enabled of [false, true]) {
    const id = `other-${enabled}`;
    rememberResponseState({ input: [partial] }, { id, output: [other], status: "completed" },
      { replaceObservedItems: enabled });
    expect((expandPreviousResponseInput({ previous_response_id: id, input: [] }) as any).input)
      .toEqual([partial, other]);
  }
  rememberResponseState({ input: [partial] }, { id: "unproven", output: [partial], status: "completed" });
  expect((expandPreviousResponseInput({ previous_response_id: "unproven", input: [] }) as any).input)
    .toEqual([partial, partial]);
});
