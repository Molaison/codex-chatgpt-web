# Distributing durable multi-account QA

Build this fork on each target operating system. The upstream download/install scripts
install upstream releases and do not include these changes. The runtime bundle includes
`app/qa-pool.js`, `app/download-gateway.js` and the `deploy/` example configurations.
Build native Windows/macOS launcher packages on those operating systems; a Linux build
is not a Windows/macOS release. Never distribute logged-in browser profiles or keys.

## Per-account runtimes

Sign into each account using its own launcher user-data/profile directory. Give each
runtime a unique stable `accountId`, separate home, isolated launcher descriptor and
loopback port. In each account config set:

```json
{
  "mode": "browser-only",
  "accountId": "account-1",
  "useSavedChats": true,
  "experimentalFreshConversationPerTurn": false,
  "conversationStoreDirectory": "runtime/conversations",
  "standardConcurrencyLimit": 5,
  "proConcurrencyLimit": 2,
  "downloadBaseUrl": "https://files.example.com/account-1"
}
```

Keep existing launcher/runtime path settings specific to the destination machine.
`accountId` identifies an authenticated ChatGPT account, not a port or release version.
Never reuse it for a different account. Explicit `useSavedChats: false` opts into
Temporary Chat and disables durable saved-chat restoration. It cannot satisfy durable
session requirements. Existing temporary chats cannot be recovered retrospectively.

## Permanent account routing

A router's ordinary short-lived account affinity is insufficient: after expiry it can
select another ChatGPT account that does not own the saved chat. Run the included QA pool
and register it as one CPR API-key provider, in a dedicated group containing only that
pool. Route durable QA client keys to this group. The pool owns the underlying account
selection, and each account runtime enforces its configured model concurrency limits.

1. Copy `deploy/qa-pool.example.json` into a private configuration directory.
2. Generate a strong random API key into `keyFile` (at least 24 characters; prefer 32
   random bytes), with user-only file permissions. Keep client `id` stable when rotating it.
3. Set accounts to their actual loopback origins and verified model catalog. The example
   has a single model deliberately; it does not assert your account's entitlements.
4. Run `runtime/bun app/qa-pool.js /absolute/path/qa-pool.json` from the built bundle.
   On Windows use `runtime/bun.exe`. Relative pool paths resolve from the process working
   directory, so absolute paths are recommended in service configurations.
5. Register the pool's base URL ending in `/v1`, its key and model routes with CPR.
   If CPR runs in a container, use a private network bridge or Unix socket proxy to reach
   the host's loopback listener. Do not expose browser control or unauthenticated runtimes.

The pool permanently stores a client-scoped thread hash and account ID in SQLite.
There is no idle TTL. A disabled, removed, unreachable or model-incompatible owner
returns an explicit error; the pool does not silently move an existing conversation.
New sessions are balanced across enabled eligible accounts. Capacity exhaustion does
not move an established session. Different pool client IDs isolate same-named threads.
Use globally unique native Codex thread IDs if multiple CPR clients share one pool
credential; provision separate pool client IDs/credentials when explicit tenant
isolation is required. A child/fork uses its own thread ID and its own saved chat.

Saved-chat Responses also persist verified `previous_response_id` aliases under each
account's conversation store in `response-aliases.sqlite`. These small identity records
have no default expiry or count limit and do not duplicate prompts or answers. They
allow incremental continuation after the ordinary Responses cache expires or is lost.
The same account and native thread ID must accompany continuation; unknown or mismatched
IDs fail explicitly. An old response ID continues the current saved chat, not a past
snapshot. Forking still requires a distinct child thread and the inherited QA history.

## Downloads from another network

Run `runtime/bun app/download-gateway.js /absolute/path/gateway.json`. The default
example is a file-only loopback gateway. Terminate TLS with your existing HTTPS reverse
proxy/tunnel; `deploy/Caddyfile.example` illustrates a separate file hostname. Set
each runtime's `downloadBaseUrl` to that account's externally reachable HTTPS prefix.
A private LAN address or localhost is not a cross-network download origin.

For an existing CPR hostname, `deploy/public-ingress.example.json` exposes only generated
files beneath `/qa-files/<account>/files/...`, forwarding other traffic to CPR. It
preserves streaming HTTP and WebSocket upgrade traffic. Point the existing HTTPS
ingress at this gateway, and set download bases to
`https://cpr.example.com/qa-files/account-1` and the corresponding second account.
The example does not create DNS records or provision a public tunnel.

File links are random bearer capabilities and expire after 24 hours. Saved chat mapping
retention is independent of file-link retention. Recipients should download files they
need to keep; a long-lived chat does not make its generated links permanent.

## Backup and relocation

Stop/drain the pool and runtimes before filesystem backups or use SQLite's online backup
API. Copy `sessions.sqlite` together with any live `-wal`/`-shm` files when using filesystem
snapshots; copying only the main file while running can lose recent bindings. Preserve
every account's `runtime/conversations` mapping directory, stable account IDs and pool
client IDs. Move credentials privately or sign in again to the same ChatGPT accounts.
Update only machine-specific paths, ports and public origins. Test a known saved session
before admitting traffic. Never merge different accounts' browser profiles.

Mappings survive service restarts and idle periods locally. ChatGPT must still retain
and permit access to the original saved conversation. Deleted/inaccessible chats and
ambiguous interrupted submissions fail explicitly; local persistence cannot recreate
server-side history or guarantee unlimited model context.

## 项目与临时会话

项目由可信的 pool 路由指定，不接受调用方伪造的 `_chatgpt_project` 或 `_chatgpt_session_mode`。
在 `projectRoutes` 配置 `name`、`accountId`、官网 `projectId`、`displayName` 和独立的 `sessionNamespace`，
再将对应 CPR 账号上游设为 `/project/<name>/v1`。现有会话不因新路由而换号或搬项目。
不同外部 key 需要不同可信路由和 namespace；它们共用一个 pool 凭据时，pool 不能自行识别外层 key。

账号启用 `sessionModes: true` 后，`reasoning.effort` 可用 `high-temporary`、`xhigh-temporary` 等值。
普通强度或 `-persistent` 后缀请求持久模式。

| 当前状态 | 请求模式 | 行为 |
|---|---|---|
| 新会话 | temporary | 官网 Temporary Chat，不进入项目 |
| 临时会话 | temporary | 同页继续；页面丢失时用私有历史重建新的临时会话 |
| 临时会话 | persistent | 原生保存，再移至绑定项目，不重发历史问题 |
| 已持久会话 | temporary | 保持持久身份与项目，只调整强度 |

私有临时历史存于 pool SQLite，完整响应后更新，空闲 48 小时过期。它不是原官网临时 ID 的冷恢复。
临时历史包含问题和回答，备份与访问权限应按私人会话数据处理。持久映射不设该 TTL。

## papers 登记与按需上传

`src/paper-registry.ts` 随 `app/qa-pool.js` 一起构建，不另设服务。
可信 pool 客户端 ID 须为 `cpr`，项目路由名须为 `papers`。路由绑定一个账号及已有官网项目，
通过 `modelAliases` 将 `papers/gpt-5.6-sol` 映射到该账号支持的普通 QA 模型。
账号须配置与 runtime 相同的 `conversationStoreDirectory`。这份配置不创建官网项目或 CPR 权限。

每次 POST `/project/papers/v1/responses`，将以下对象序列化为 JSON 字符串放入
`client_metadata["x-codex-turn-metadata"]`：

`{"paper_id":"doi:10.1234/example","paper_operation":"resolve"}`

1. `resolve` 不调用模型，支持 JSON 与 SSE。`ready` 返回原 thread 和 URL，随后只传新问题。
2. `missing` 且 `upload_required` 时保留返回的 `upload_token`，改用 `paper_operation:"chat"`，
   metadata 加 `paper_upload_token`；用户内容带 `input_file` 的 `filename` 和内联 `file_data`。
3. 无 DOI 用 `sha256:<PDF SHA256>`。传 `paper_pdf_sha256` 可让 DOI 与已登记 SHA 关联到同一对话。
4. 只有完整响应和已验证的原生保存映射才标记已上传。`uncertain` 停止自动重传，不新建替代会话。

登记、别名和事件保留在原 `sessions.sqlite`，长期绑定无 TTL。未发送预留 15 分钟到期。
`prompt_attachments_not_submitted` 仅证明单段请求在 Send 前附件失败，允许保留原 token 重试。
其他错误或截断仍视为不确定。大 PDF 附件等待 300 秒、附件阶段 360 秒，不截短或压缩输入。
论文路由不接受临时模式、匿名论文身份或未知旧映射。账号或原会话不可访问时明确失败。

源码测试使用隔离临时数据库和本地 HTTP 后端，不调用 ChatGPT；它们不等于生产部署或桌面 UI 验收。
