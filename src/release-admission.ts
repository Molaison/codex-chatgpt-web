import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";

export interface ReleaseControlConfig { tokenFile: string; stateFile: string }

/** Admission belongs to the real listener owner, not an administrative proxy.
 * The sticky fence survives owner replacement. Counters come from that owner's
 * actual lifecycles; the release coordinator cannot declare them idle.
 */
export class ReleaseAdmission {
  readonly instance = randomUUID();
  draining: boolean;
  sealed = false;
  activeHttp = 0;
  private digest: Buffer;
  constructor(readonly role: string, readonly config: ReleaseControlConfig,
    readonly counters: () => Record<string, number>) {
    const token = readFileSync(config.tokenFile, "utf8").trim();
    if (token.length < 24) throw Error("Release control token must contain at least 24 characters");
    this.digest = createHash("sha256").update("Bearer " + token).digest();
    const saved = existsSync(config.stateFile) ? JSON.parse(readFileSync(config.stateFile, "utf8")) : undefined;
    if (saved && saved.role !== role) throw Error("Release fence belongs to another role");
    this.draining = saved?.draining === true;
    this.sealed = this.draining && saved?.sealed === true;
  }
  status() {
    const counters = { active_http: this.activeHttp, ...this.counters() };
    return { status: "ok", contract: this.role+"-native-v1", owner_instance: this.instance,
      pid: process.pid, phase: this.sealed ? "sealed" : this.draining ? "draining" : "accepting", accepting_new: !this.draining, ...counters,
      safe_to_stop: this.draining && Object.values(counters).every(value => value === 0) };
  }
  fence(draining: boolean) {
    if (!draining) this.sealed = false;
    const temp = this.config.stateFile+"."+process.pid+".tmp";
    writeFileSync(temp, JSON.stringify({role: this.role, draining, sealed: this.sealed}), {mode: 0o600});
    renameSync(temp, this.config.stateFile);
    this.draining = draining;
  }
  control(request: Request): Response | undefined {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/admin/release/")) return undefined;
    const supplied = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
    if (!timingSafeEqual(supplied, this.digest)) return new Response("Unauthorized", {status: 401});
    if (request.method === "POST" && request.headers.has("origin")) return new Response("Origin refused", {status: 403});
    if (request.method === "POST" && path === "/admin/release/drain") this.fence(true);
    else if (request.method === "POST" && path === "/admin/release/seal") {
      if (!this.status().safe_to_stop) return Response.json({...this.status(), error: "Native work is not drained"}, {status: 409});
      this.sealed = true; this.fence(true);
    }
    else if (request.method === "POST" && path === "/admin/release/resume") this.fence(false);
    else if (!(request.method === "GET" && path === "/admin/release/status")) return new Response("Not found", {status: 404});
    return Response.json(this.status(), {headers: {"cache-control": "no-store"}});
  }
  enter() {
    this.activeHttp++;
    const admitted = !this.draining;
    let ended = false;
    return { admitted, finish: () => { if (!ended) { ended = true; this.activeHttp--; } } };
  }
}

/** Keep HTTP ownership until the response body ends, not merely fetch() headers. */
export function releaseTrackedResponse(response: Response, finish: () => void, signal?: AbortSignal): Response {
  const done = () => { signal?.removeEventListener("abort", done); finish(); };
  signal?.addEventListener("abort", done, {once: true});
  if (signal?.aborted) done();
  if (!response.body) { done(); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { done(); controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) { done(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { done(); } },
  });
  return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
}
