# Experimental automatic Full harness over HTTP

The explicit `external-http` provider enables the existing automatic Full harness with a
loopback Streamable HTTP adapter in place of the managed OpenAI Secure MCP Tunnel.
The automatic path is:

```text
Codex request -> browser prompt + current turn token -> ChatGPT
ChatGPT MCP call -> HTTPS proxy -> loopback /mcp -> turn broker
turn broker -> Codex tool/approval -> tool result -> MCP response -> ChatGPT
ChatGPT final answer -> browser completion fence -> Codex response
```

The browser worker selects the configured connector, sends the compiled prompt, observes tool
boundaries, and returns the final answer. There is no manual prompt copying, per-turn manual
connector selection, Launcher Sent step, or `codex_turn_start` call in this automatic workflow.
One-time sign-in, connector registration, and any tool approvals requested by Codex remain necessary.

This is a production Launcher + Full opt-in experiment, supporting `automatic` and Zero Risk
`manual` interaction. Browser-only, managed-Chrome, and DEV profiles are rejected. The explicit
external provider re-enables automatic local tools; this fork's default official-provider automatic
behavior is unchanged. Official stdio transport and Zero Risk/manual remain available.

The adapter does not execute commands itself. The current turn capability, advertised native tool
schema, and outer Codex sandbox/approval policy still control execution. `autoApproveToolCalls`
is not enabled by selecting this provider. The existing approval setting is preserved.

## Build and configure an automatic Full profile

Use a production launcher and backend built from this patched checkout. Unpatched launchers do
not contain this experiment. The `bun run launcher` development shortcut passes
`--dev-profile` and is unsuitable. Build prerequisites are the repository-pinned Bun, frozen
dependencies, and the normal Electron binary from the project's declared dependency.

```sh
bun install --frozen-lockfile
bun install --frozen-lockfile --cwd launcher
bun run scripts/build-browser-helper.ts
bun run --cwd launcher build
```

A renderer build alone does not verify Electron or an authenticated account. Before starting a
production launcher, choose the intended profile and approve any installation, account login, or
Codex route changes. `CODEX_CHATGPT_WEB_HOME` can isolate the bridge profile, but setup still
integrates with Codex; a different profile directory alone does not isolate the Codex route.
Do not run setup against the active installation merely to test the HTTP server.

After the patched production launcher is running and its browser is ready, configure that same
profile from the CLI, using its actual owner-only browser descriptor:

```sh
bun run src/cli.ts setup --full --automatic-browser-interaction --mcp-provider external-http --browser-host-descriptor /path/to/launcher-browser.json --acknowledge-unofficial
```

This command writes configuration and installs the Codex integration. It does not start an HTTP
listener or public proxy, and does not create a ChatGPT connector. If a different Codex route already
exists, setup refuses to overwrite it unless replacement is explicitly authorized. Legacy background
or tunnel services must first be removed through the Launcher's supported workflow. Existing tunnel
credentials are retained for rollback and are not used by the external provider.

The graphical **Connect harness** credential wizard remains specific to the official provider;
use the explicit CLI selector above for this experiment. The supervisor starts the Full broker and
Responses daemon without provisioning an OpenAI Tunnel or requiring a runtime key. Automatic
browser-model capability inspection remains part of setup.

## Start the native HTTP adapter

In a separate terminal with the same profile environment, run:

```sh
bun run src/cli.ts mcp --transport http --port 8788 --contract native
```

The profile's default broker endpoint is used unless `--broker-socket` is supplied. On Windows this
is a named pipe; on Unix it is a socket path. Both processes must use the same endpoint. Starting
this command alone does not create a turn or grant any execution capability. Stop it with Ctrl+C.
It writes no profile, credentials, or service definitions.

The listener binds only `127.0.0.1`. It accepts `POST /mcp` and session-aware `DELETE /mcp`.
Other paths, including unused OAuth discovery, return 404. `GET` and `OPTIONS /mcp` return 405.
Local initialize/tools/list can succeed without an active Codex turn; that proves discovery only.

## One-time approved HTTPS connection

ChatGPT must be able to reach the MCP URL. A loopback-only success cannot prove its **Create**
button will work. Approve the specific proxy service, endpoint, and tool-data flow before exposing
it, entering credentials, changing persistent access, or registering a connector. This patch installs
or starts no proxy. Expose only the MCP listener, never the Responses API, launcher control port,
broker endpoint, or filesystem.

The HTTPS proxy must preserve POST bodies, JSON responses, `Mcp-Session-Id` request/response
headers, and `MCP-Protocol-Version`, with a request timeout longer than 120 seconds. If it preserves
the public Host header, specify the single approved origin:

```sh
bun run src/cli.ts mcp --transport http --port 8788 --contract native --public-origin https://your-approved-host.example
```

Alternatively the proxy may rewrite Host to `127.0.0.1:8788`. Forwarded headers are not trusted.
The origin allowlist is not authentication. Unexpected Origin headers are rejected; wildcard CORS
is not enabled. Public requests can discover the tool schema, but execution still requires a live
high-entropy turn capability. Never put capabilities or credentials in URLs or public logs.
A permanent public deployment needs a separately reviewed access/authentication design.

### Optional fixed hostname with Cloudflare Tunnel

Use a named tunnel for a stable hostname. Cloudflare Quick Tunnels change hostnames and do not
support SSE; they are not an equivalent deployment. Install `cloudflared` only from the
[official downloads](https://developers.cloudflare.com/tunnel/downloads/), then complete
`cloudflared tunnel login` yourself in the browser for the intended account and zone. Do not put
API keys, login certificates, tunnel credentials, or turn capabilities in this repository.

Before creating a route, check the chosen hostname's existing DNS records. Create a separate
tunnel and keep an existing working transport available until the new endpoint passes validation:

```sh
cloudflared tunnel create codex-web-mcp
cloudflared tunnel route dns --overwrite-dns=false <TUNNEL_UUID> mcp.example.com
```

Copy [the generic ingress example](examples/cloudflared-mcp.yml) outside the checkout, replace
the tunnel ID, credential-file path, and hostname, and use the same hostname for the adapter's
`--public-origin https://mcp.example.com`. The example forwards only the exact `/mcp` path to
`127.0.0.1:8788`; every other host/path returns 404. Its explicit `httpHostHeader` agrees with the
adapter allowlist. Metrics also stay on loopback. Do not add the Responses or Launcher ports as
ingress services.

```sh
cloudflared tunnel --config /path/to/cloudflared-mcp.yml ingress validate
cloudflared tunnel --config /path/to/cloudflared-mcp.yml ingress rule https://mcp.example.com/mcp
cloudflared tunnel --config /path/to/cloudflared-mcp.yml ingress rule https://mcp.example.com/v1/responses
cloudflared tunnel --config /path/to/cloudflared-mcp.yml run <TUNNEL_UUID>
```

The second rule check must match the final 404 rule. The current adapter returns JSON responses,
not SSE streams. If SSE is enabled in a future implementation, preserve its `text/event-stream`
response header and verify incremental delivery, disconnects, and long calls independently;
[Cloudflare's streaming guidance](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/#cloudflare-tunnel-is-buffering-my-streaming-response-instead-of-streaming-it-live)
explains the required header. A successful short initialize request does not test long-call
timeouts or streaming behavior. Do not weaken Host/Origin checks or capability authorization to
work around a proxy failure.

Verify initialize, tool discovery, missing/invalid capability rejection, and non-MCP path rejection
through the fixed HTTPS hostname before registering it in ChatGPT. A newly connected hostname
requires its own installed-Codex read/edit/test/final-answer acceptance; success on another tunnel
does not establish that result. Keep startup and credential lifecycle under your own control:
this experiment does not install a `cloudflared` system service or change firewall rules.

In ChatGPT Developer Mode create a **URL** connector pointing to
`https://your-approved-host.example/mcp`, with the exact automatic connector name in the profile
(`automaticAppName`, normally `Codex Native2`). This adapter does not implement OAuth; its
experimental setting is **No Auth**. Do not enter a Tunnel ID for this route. The name must match
because the existing automatic browser selector chooses that exact connector and fails closed on
ambiguous identity. After registration, ordinary turns use the automatic harness.

Compare initialize/tools/list locally, through the approved HTTPS endpoint, and from ChatGPT.
Content-free HTTP stage/status records distinguish no request, initialization, and tool discovery.
Other inherited MCP diagnostics require privacy review before sharing, including caller-provided
request IDs and metadata. Record the failure timestamp and safe error text when Create fails.
No arriving HTTP request indicates that protocol or tool execution changes have not yet tested
the failing registration boundary. Successful Create still requires a separate live Codex tool turn
and returned final answer before end-to-end acceptance can be claimed.

## Manual and official alternatives

Zero Risk is a separate supported workflow. Select `--zero-risk-browser-interaction` instead of
`--automatic-browser-interaction`, start
the adapter with `--contract safe`, and use the manual connector name (`manualAppName`). This
path intentionally retains the manual prompt/Sent, `codex_turn_start`, and completion gates.
Do not point an automatic profile at a safe-contract connector or vice versa.

To restore the official transport, explicitly select `--mcp-provider openai-tunnel` and satisfy its
normal tunnel/runtime-key requirements. Stop separately managed HTTP/proxy processes yourself.
The original `mcp` command without `--transport http` remains stdio. Switching interaction modes
does not restart or reconfigure the separately managed HTTP server; choose the matching contract
and connector before running turns.

## Protocol and bounds

- The locked MCP SDK 1.30.0 supports session-aware Streamable HTTP through protocol `2025-11-25`.
  JSON responses are used; there is no legacy SSE endpoint or background replay/resumption store.
- Initialize returns a random `Mcp-Session-Id` required on subsequent requests. Up to 64 sessions
  are allowed, expiring after 10 minutes idle. Session IDs isolate protocol traffic, not authority.
- At most 32 ordinary requests plus 8 cancellation slots, 24 MiB encoded input, a 30-second body
  deadline, and a 120-second request deadline are allowed. Batched JSON-RPC arrays are rejected.
  Native invocation deadlines remain enforced. Long approvals may require a retry after timeout.
- Cancellation, HTTP disconnect, and shutdown abort affected handlers through the existing broker.
  Interrupted execution retires its whole turn binding; unrelated turns remain independent.
  Request IDs, including zero and empty string, are scoped by session and normalized for the SDK.
- Automatic Responses request disconnects retain the existing resumable harness behavior; they
  are not interchangeable with operator turn cancellation or MCP invocation cancellation.

## Local verification

```sh
bun run typecheck
bun test tests/external-http-full-harness.test.ts tests/mcp-http-broker.test.ts
bun test tests/mcp-http.test.ts tests/mcp-observation.test.ts
bun test tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts tests/zero-risk-mcp-lifecycle.test.ts
bun run verify
```

`external-http-full-harness` uses the actual provider configuration, adapter, SDK HTTP client, and
OS broker. A browser/model fixture emits MCP calls and observes real returned results; an outer
Codex fixture denies an escalation and runs a fixed harmless child process. It checks multiple tool
rounds, native approval arguments, automatic completion, replay, new-turn tokens, and cancellation
without entering manual control. Browser/account and actual Codex are simulated in this test.
Offline DOM and contract tests exercise the existing automatic browser behavior separately.
None proves live ChatGPT Create, public HTTPS, or installed Codex acceptance.
