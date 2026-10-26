import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import * as launcher from "../src/launcher-browser-host";
import { ChatGptBrowserWorker, type BrowserTurn, type ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptConversationStore } from "../src/adapters/chatgpt-web/conversation-persistence";
import { nativeSubmissionDigest, type NativeSubmissionRecord } from "../src/adapters/chatgpt-web/submission-identity";
import { type NativeResultReady } from "../src/adapters/chatgpt-web/native-execution";
import { observationSuffix, type BrowserObservationCheckpoint } from "../src/adapters/chatgpt-web/observation-recovery";
import { serveGeneratedFile } from "../src/generated-files";

const browserTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
const capabilities = { solAvailable: true, extraHighAvailable: false, proAvailable: false, localToolsEnabled: false };
const fileFixture = readFileSync(new URL("./fixtures/chatgpt-file-only-complete.html", import.meta.url), "utf8");

async function fixture(kind: "text" | "file" | "image", native: boolean, run: (f: {
  page: Page; root: string; turn: BrowserTurn; checkpoint: BrowserObservationCheckpoint;
  worker: { runExclusive(turn: BrowserTurn): Promise<string> }; events: string[]; deltas: string[];
  latest(): NativeSubmissionRecord | undefined; ready(): NativeResultReady | undefined;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "observed-response-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: request => serveGeneratedFile(request, join(root, "downloads")) ?? new Response(null, { status: 404 }) });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const id = randomUUID(), surfaceId = "s".repeat(32), url = `https://chatgpt.com/c/${randomUUID()}`;
    await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto(url);
    const receipt = `[codex-submission:${randomUUID()}]`;
    const html = kind === "file" ? fileFixture.replace("fixture-current", id)
      : `<section id="turn" data-turn-key="${id}"><div data-content-search-unit-key="fixture:1:assistant">`
        + '<h4 data-conversation-role="assistant" hidden>Assistant</h4><div data-markdown-text-style="assistant-message">'
        + (kind === "text" ? "<p>Original recovered answer.</p>" : "")
        + '</div></div><button data-testid="copy-turn-action-button">Copy</button></section>';
    await page.setContent(html);
    await page.locator("#turn").evaluate((element, receipt) => element.insertAdjacentHTML("afterbegin",
      `<div data-user-message-bubble><div data-search-result-target>Original question ${receipt}</div></div>`), native ? "" : receipt);
    if (kind === "file") await page.evaluate(() => {
      document.querySelector('button[aria-label="下载文件"]')!.addEventListener("click", () => {
        const url = URL.createObjectURL(new Blob(["name,value\noriginal,1\n"], { type: "text/csv" }));
        const link = document.createElement("a"); link.href = url; link.download = "report.csv";
        document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      });
    });
    if (kind === "image") await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 192;
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#2879dc"; ctx.fillRect(0, 0, 256, 192);
      const image = document.createElement("img"); image.src = canvas.toDataURL("image/png");
      image.width = 256; image.height = 192; image.alt = "Generated image";
      document.querySelector('[data-content-search-unit-key]')!.append(image); await image.decode();
    });
    const host = { pid: process.pid, instanceId: "h".repeat(32), profile: "production" as const, partition: "persist:codex-web-gpt-chatgpt" };
    const lease = { helperPid: process.pid + 100, surfaceId, targetId: "original-target" };
    const identity = { operationId: "original-operation", executionKey: "original-key", roundKey: "original-round", threadId: "thread", turnId: "turn" };
    const pair = [`group:user:${id}`, `group:assistant:${id}`];
    const store = new ChatGptConversationStore(join(root, "conversations"), "fixture-account");
    const key = "c".repeat(64), claim = store.reserve(key);
    store.bind(key, claim, url);
    const checkpoint: BrowserObservationCheckpoint = { version: native ? 2 : 1, identity,
      traceId: "original-trace", modelId: "gpt-5.6-sol", accountId: "fixture-account", appName: "fixture-app",
      host, lease, conversation: { key, claim: claim.claim, url }, submission: { initialTurnIdentities: [],
        acceptedUserIdentity: pair[0]!, assistantIdentity: pair[1]!, acceptedTurnIdentities: pair,
        ...(native ? {} : { receipt }) } };
    const now = Date.now() - 100;
    const post = { userMessageId: id, payloadSha256: "a".repeat(64), action: { presence: "value" as const, value: "next" },
      parentMessageId: { presence: "value" as const, value: "client-root" }, conversationId: { presence: "absent" as const }, observedAt: now };
    const sendId = randomUUID();
    const binding = { roundKey: identity.roundKey, stage: { kind: "final" as const }, host, lease, documentEpoch: JSON.stringify(["frame", "loader"]) };
    const watch: launcher.LauncherNativeSubmissionWatch = { version: 1, traceId: checkpoint.traceId, sendId, currentSendId: sendId,
      binding, host, lease, scope: { ...identity, traceId: checkpoint.traceId }, segmentState: "watching", totalPostCount: 1, segments: [], latePosts: [],
      sessionEpoch: randomUUID(), documentEpoch: binding.documentEpoch, mainFrame: { frameId: "frame", loaderId: "loader" },
      seq: 2, active: true, gap: false, gapReasons: [], conflict: false, conflictReasons: [], postCount: 1,
      identities: [{ ...post, ordinal: 1, watchOrdinal: 1, endpoint: "/backend-api/conversation", requestId: "request", frameId: "frame", loaderId: "loader" }],
      startedAt: now, readAt: now, initialConversationId: null, boundConversationId: url.split("/c/")[1]!,
      flush: { stable: true, pending: 0, throughSeq: 2 } };
    if (native) checkpoint.submission.native = { version: 1, sendId, revision: 4, phase: "accepted", initialTurnIdentities: [],
      binding, hostWatch: watch, post, dom: { acceptedUserIdentity: pair[0]!, assistantIdentity: pair[1]!,
        acceptedTurnIdentities: pair, proof: "same-bound-assistant-progress", observedAt: now } };
    const descriptor: launcher.LauncherBrowserHostDescriptor = { version: 3, kind: launcher.LAUNCHER_BROWSER_HOST_KIND,
      profile: "production", pid: process.pid, observationInstanceId: host.instanceId,
      endpoint: "http://127.0.0.1:39001", control: { endpoint: server.url.origin, token: "fixture-control-token-012345678901234567890123" },
      helper: { executable: process.execPath, script: join(root, "unused-helper.cjs") }, partition: host.partition,
      idleUrl: launcher.LAUNCHER_BROWSER_IDLE_URL, surfaceId, surfaceTargets: { [surfaceId]: lease.targetId }, createdAt: new Date().toISOString() };
    writeFileSync(descriptor.helper.script, "throw new Error('This read-only fixture cannot launch a helper');\n");
    const descriptorPath = join(root, "launcher.json"); writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
    const events: string[] = [], deltas: string[] = [];
    let latest: NativeSubmissionRecord | undefined, ready: NativeResultReady | undefined;
    spies.push(spyOn(launcher, "connectLauncherBrowserHost").mockImplementation(async (_path, _timeout, surface, _signal, readOnly) => {
      expect(surface).toBe(surfaceId); expect(readOnly).toBeTrue();
      return { page, context: page.context(), descriptor, browser: { close: async () => { events.push("disconnect"); } } as any };
    }));
    spies.push(spyOn(launcher, "notifyLauncherTurn").mockImplementation(async (_path, activity) => {
      if (activity.phase === "observe") return {};
      events.push(activity.phase);
      if (activity.phase === "native-submission-watch") return { nativeSubmissionWatch: watch };
      if (activity.phase === "observe-complete") {
        expect(activity.helperPid).toBe(process.pid);
        expect(latest).toEqual(activity.receipt.record);
        expect(activity.resultReady.completedDigest).toBe(nativeSubmissionDigest(latest!));
        expect(ready).toBeDefined();
        return { nativeRelease: { version: 1, releaseId: randomUUID(), sendId, roundKey: identity.roundKey,
          sessionEpoch: watch.sessionEpoch, host, lease, documentEpoch: binding.documentEpoch,
          outcome: "completed", terminalDigest: activity.resultReady.completedDigest } };
      }
      if (activity.phase === "observe-end") return {};
      throw new Error(`Unexpected browser mutation: ${activity.phase}`);
    }));
    const config: ResolvedBrowserConfig = { appName: checkpoint.appName, accountId: checkpoint.accountId,
      browserHost: "launcher", browserHostDescriptorPath: descriptorPath, conversationStoreDirectory: join(root, "conversations"),
      chromeExecutablePath: "unused", headed: false, autoApproveToolCalls: false, storageStatePath: join(root, "storage.json"),
      downloadDirectory: join(root, "downloads"), downloadBaseUrl: server.url.origin, imageOutputDirectory: join(root, "images"), turnTimeoutMs: 10_000 };
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config });
    const turn: BrowserTurn = { traceId: checkpoint.traceId, modelId: checkpoint.modelId, capabilities, observation: checkpoint,
      prepare: async () => { throw new Error("Observation must never prepare or resend a prompt"); }, onTextDelta: delta => deltas.push(delta),
      ...(native ? { nativeSubmissionIdentity: true, nativeOperationScope: { ...identity, traceId: checkpoint.traceId },
        nativeObservationSubmission: checkpoint.submission.native,
        onNativeSubmission: async (value: NativeSubmissionRecord) => { latest = value; events.push("durable-completed"); },
        onNativeResultReady: async (value: NativeResultReady) => { ready = value; events.push("durable-result"); },
        onNativeRelease: async () => { events.push("durable-release"); } } : {}) };
    await run({ page, root, worker, turn, checkpoint, events, deltas, latest: () => latest, ready: () => ready });
  } finally { for (const spy of spies.splice(0)) spy.mockRestore(); await browser.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); }
}

browserTest("accepted Native observer persists completed result and releases the original lease without another Send", async () => {
  await fixture("text", true, async f => {
    const answer = await f.worker.runExclusive(f.turn);
    expect(answer).toBe("Original recovered answer."); expect(f.deltas.join("")).toBe(answer);
    expect(f.latest()?.phase).toBe("completed"); expect(f.ready()?.answer).toBe(answer);
    expect(f.events).toEqual(["native-submission-watch", "durable-completed", "durable-result", "observe-complete", "durable-release", "disconnect"]);
  });
}, 15_000);

browserTest("failed recovered result persistence retains the original Host lease", async () => {
  await fixture("text", true, async f => {
    f.turn.onNativeResultReady = async () => { throw new Error("fixture durable storage failure"); };
    const error = await f.worker.runExclusive(f.turn).then(() => undefined, error => error);
    expect(error?.message).toBe("fixture durable storage failure");
    expect(f.events).not.toContain("observe-complete"); expect(f.events).not.toContain("durable-release");
  });
}, 15_000);

for (const kind of ["file", "image"] as const) browserTest(`read-only recovery preserves a ${kind}-only answer and exact downloadable bytes`, async () => {
  await fixture(kind, true, async f => {
    const answer = await f.worker.runExclusive(f.turn);
    expect(f.deltas.join("")).toBe(answer); expect(f.ready()?.answer).toBe(answer);
    const url = answer.match(/\]\(<([^>]+)>\)/)?.[1]; expect(url).toBeDefined();
    const response = await fetch(url!); expect(response.ok).toBeTrue();
    if (kind === "file") expect(await response.text()).toBe("name,value\noriginal,1\n");
    else {
      const manifest = JSON.parse(readFileSync(join(f.root, "images", f.turn.traceId, "manifest.json"), "utf8"));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(manifest.images[0].path));
    }
    expect(f.events).toContain("durable-release");
  });
}, 15_000);

for (const kind of ["file", "image"] as const) browserTest(`a ${kind} link streamed before helper loss remains byte-identical when observation resumes`, async () => {
  await fixture(kind, true, async f => {
    const persistReady = f.turn.onNativeResultReady!;
    f.turn.onNativeResultReady = async () => { throw new Error("fixture helper lost before result-ready ACK"); };
    const failure = await f.worker.runExclusive(f.turn).then(() => undefined, error => error);
    expect(failure?.message).toBe("fixture helper lost before result-ready ACK");
    const prefix = f.deltas.join(""); expect(prefix).toContain("](<");
    expect(f.events).not.toContain("observe-complete");
    const additional: string[] = [], suffix = observationSuffix(prefix, delta => additional.push(delta));
    f.turn.nativeObservationSubmission = f.latest();
    f.turn.onNativeResultReady = persistReady;
    f.turn.onTextDelta = delta => suffix.push(delta);
    const recovered = await f.worker.runExclusive(f.turn);
    suffix.finish(recovered);
    expect(recovered).toBe(prefix); expect(additional).toEqual([]);
    expect(f.ready()?.answer).toBe(prefix); expect(f.events).toContain("durable-release");
    const url = recovered.match(/\]\(<([^>]+)>\)/)![1]!;
    expect((await fetch(url)).ok).toBeTrue();
  });
}, 20_000);

browserTest("legacy observer sends checkpoint-gated completion before disconnecting", async () => {
  await fixture("text", false, async f => {
    expect(await f.worker.runExclusive(f.turn)).toBe("Original recovered answer.");
    expect(f.events).toEqual(["observe-end", "disconnect"]);
  });
}, 15_000);
