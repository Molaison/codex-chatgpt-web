# Generated files in QA answers

QA Markdown preserves paths and download targets, including sandbox links. The current
ChatGPT interface can also show a generated file only as a resource card outside the
answer Markdown. Automatic browser runs inspect cards belonging to the current assistant
answer, capture the original downloaded Blob, and append a usable HTTP link to the answer.
User-upload cards are excluded. A revoked blob URL is never returned as a download link.

A completed QA reply may contain only a downloadable file card and no prose. With
downloads configured, that card can establish final content after the same stable
completion checks as a text answer. The response contains the captured file's real
link; no placeholder answer is invented. Empty replies, still-running generation,
disabled download controls and cards belonging to other turns cannot establish success.
If the indicated file cannot actually be captured, the response fails explicitly.

The bridge stores each file privately under its account home's downloads directory.
GET and HEAD /files/<random-256-bit-token>/<filename> return only that file, with attachment,
no-store and nosniff headers. Wrong account, wrong filename, expired links, and unsupported
methods return 404. A file is limited to 64 MiB; its link expires after 24 hours. Expired
files are removed when another generated file is stored. Treat links as bearer capabilities:
anyone who receives a link can download its file until it expires.

## Native-shaped links and cache refresh (October 1, 2026)

The card download click is observed, so the bridge also records the real ChatGPT download
endpoints: `backend-api/estuary/content?id=file_...` and the unsigned
`backend-api/conversation/<id>/interpreter/download?sandbox_path=...`. Only these two observed
`https://chatgpt.com` shapes become replay sources; anything else is discarded.

When a real `file_...` identifier was observed, the answer links the native shape
`<downloadBaseUrl>/estuary/content?id=file_...&fn=<filename>` instead of the random token path.
The runtime resolves that identifier against its own downloads cache, so a normal download
costs no ChatGPT traffic. A missing, unknown, wrong-account or mismatched-filename request is 404;
signature, timestamp and other native query parameters are never forwarded by the public ingress.

After the 24-hour cache expires the content bytes are reclaimed but the entry, its real
filename and its replay sources are kept. The next request then re-downloads the bytes once
through the already signed-in launcher browser (page-context `credentials: include`, no cookie
export), refreshes the cached entry and serves it locally. If the original conversation or
download is gone, the request fails with 410 instead of inventing a body. `/files/<token>/<name>`
keeps its previous expiry semantics for older links.

The optional top-level downloadBaseUrl setting controls the link origin and an optional
path prefix. Its default is the loopback runtime URL. Remote CPR clients need an origin
they can reach; localhost in their browser points to their own computer. A file-only
reverse proxy can expose /account-1/files/... and /account-2/files/... while leaving the
Responses runtime and browser control endpoints on loopback. Set each account's
downloadBaseUrl to that proxy's corresponding prefix. Use HTTPS for untrusted networks.

An HTTP link appears only after the original bytes have been captured and stored.
Preserving a sandbox link alone does not make it accessible outside ChatGPT. This path
covers the observed assistant resource-card download controls, including their Chinese
and English labels; arbitrary external URLs are preserved, not fetched or rewritten.

Verification: tests/qa-downloads.test.ts checks byte-for-byte HTTP delivery, account
isolation, expiration and cleanup, path validation, and real Chromium Blob capture with
immediate URL revocation. The September 28, 2026 live test generated a CSV in ChatGPT,
received its HTTP link through Responses, and downloaded the exact 19 expected bytes
through the deployment's private-network file gateway.


## Saved response images (September 29, 2026)

Raster images in completed answers are now saved by default, independently of
Markdown text conversion. The observed standalone generated-image-gallery
renderer is supported even without a Markdown root or assistant search-unit
wrapper. Inline answer images are also preserved; user uploads, previous turns,
resource-card previews, and small UI icons are excluded. Duplicate sources within
one answer are saved once.

The worker requires completed-turn actions, decoded image content and a stable
snapshot. A pending gallery canvas, an unloaded image, active generation or an
in-flight local tool prevents image-only completion. It archives the actual image
resource bytes (including authenticated Blob URLs), not a screenshot, then appends
saved-image Markdown links consistently to both the streamed and final answer.
The source displayed by ChatGPT is preserved; this is not a promise of a separate,
higher-resolution original beyond the resource the page exposes.

Durable files and a manifest live beside the configured browser state:
<directory of storageStatePath>/generated-images/<traceId>/. The manifest records
format, decoded pixel dimensions, size and SHA-256. Archives have no automatic time
expiry in this implementation; operators should back up and manage this directory.
A failed download or decode fails the request explicitly. Images saved before a
later failure remain in the archive.

If the HTTP file gateway is configured, replies contain its normal image download
links. Those links still expire after 24 hours and retain the 64 MiB file limit;
expiry does not remove the separate durable image archive. Without a gateway,
replies contain local file URIs. Existing text, file-card and native Images
passthrough routes retain their contracts.

This change does not switch model/provider, add a second token store, promise
image availability for every ChatGPT model/account, or change upstream quotas.
