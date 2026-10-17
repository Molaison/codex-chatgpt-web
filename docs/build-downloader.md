# Build artifact downloader

Launcher builds require Node.js 22.12 or newer and Bun 1.4.0. CI uses Node.js
22.21.1 on Windows, macOS and Linux. Application runtime modes are unaffected.

`electron-builder` 26.15.3 still depends on `@electron/get` 3, whose Got dependency
includes `http-cache-semantics` affected by GHSA-ch52-4w7c-c8xp. The launcher
overrides `@electron/get` to its official 5.1.0 release, removing that dependency
chain. No advisory is ignored and no package is relabeled.

Version 5's default FetchDownloader does not implement the Got-style `agent` and
`timeout` options electron-builder passes. A pinned Bun patch therefore supplies
the local `@codex-chatgpt-web/build-downloader` through the documented
`Downloader.download(url, path, options)` interface at both builder entry points:
Electron/toolset downloads and generic binary downloads. Explicit custom
downloaders remain supported. This is an install-time patch, with no runtime
module interception or postinstall rewriting. Frozen installs apply it on every
platform. Keep the electron-builder pin and patch together when upgrading.

The adapter uses Node's HTTP/HTTPS streams and retains:

- Builder-provided HTTP/HTTPS proxy agents, including HTTPS CONNECT; custom
  agents also work. Environment proxy precedence is still builder-util's.
- Whole-request (including redirects), connect, TLS handshake, response and
  socket-idle timeouts. Builder downloads retain the ten-minute request default.
- TLS certificate and hostname validation by default, plus explicit CA/client
  certificate options. Existing explicit `strictSSL: false` configuration is
  preserved; no build configuration enables it.
- Relative/absolute redirects (ten by default), with authorization, cookies,
  proxy authorization and Host removed when the origin changes.
- Two transient GET retries by default, bounded Retry-After handling, streamed
  progress, gzip/deflate/Brotli decoding, and removal of incomplete output.
  Builder's outer retry/locking/extraction behavior is unchanged.
- Upstream SHA-256 verification, mirror resolution, fresh checksum downloads,
  corrupt-cache rejection, all four artifact disk-cache modes and legacy
  `force` mapped to write-only cache with the original conflicting-mode error.

HTTP response caching is absent; the default old downloader also left it off.
Artifact caching remains in `@electron/get`. Opt-in Got HTTP caches and arbitrary
Got hooks are not supported. Unknown options fail explicitly instead of being
silently ignored. Supported adapter options are `agent`, `timeout`, `headers`,
`https`, `retry` (number or `{ limit }`), `maxRedirects`, `followRedirect`,
`getProgressCallback`, `quiet`, `decompress`, and `cache: false`. `quiet` is
accepted for compatibility; progress display belongs to electron-builder.
Timeout phase names are `request`, `connect`, `secureConnect`, `response`, and
`socket`. Connect timeout includes time waiting for the agent/DNS/socket.

Run `node --test launcher/tests/build-downloader.test.cjs` from the repository
root after `bun install --cwd launcher --frozen-lockfile`. Tests use loopback
servers, generated ephemeral certificates and synthetic artifacts. They cover
the actual installed builder integration, proxy routing, the v5 agent/timeout
regression, TLS rejection, credential stripping, retries, checksums and caching.
`bun run verify` includes these tests; native `bun run app:package` and
`bun run app:smoke` remain the final platform checks.

Upstream references: [Downloader interface](https://github.com/electron/get/blob/v5.1.0/src/Downloader.ts),
[v5 migration](https://github.com/electron/get/releases/tag/v5.0.0),
[Bun dependency patches](https://bun.com/docs/pm/cli/patch),
[advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
