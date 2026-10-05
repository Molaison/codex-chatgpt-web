# 双账号 Cloudflare 工具 + 认证 CPR Full 路线部署

结论：现役形态由**一个公有入口**（`src/download-gateway.ts`，构建产物 `app/download-gateway.js`）承载三条路线：每账号的公网 MCP 路径、账号文件下载路径、以及转发到 CPR 的 `/v1`。CPR 侧再通过**每账号独立的认证 provider + 本机 Unix socket** 回到该账号的 Full runtime。全部凭据留在私有 HOME（0600），仓库里只有脚本、示例配置和说明。

服务端运行时是构建出的 Bun 1.4 运行包（`package.json` 固定 `bun@1.4.0`，`scripts/build-runtime-bundle.ts` 会校验版本）；管理员主机需要 Python 3、systemd、Podman 和 Node.js 24 或更新版本；Bun 随运行包提供。客户端只需要标准 API 地址/密钥/模型名，不需要 SSH，也不需要 cloudflared。

## 现役组成

| 组件 | 监听 | 作用 | 由谁启动 |
| --- | --- | --- | --- |
| public ingress（`download-gateway.js` + `public-ingress.json`） | `127.0.0.1:<ingress-port>` | 公网唯一入口；精确路径分发，其余路径转发到 CPR | 既有 `chatgpt-web-public-ingress.service` |
| CPR 应用 | `127.0.0.1:18082` | 纯聊天与 Full 公网 API | 既有 CPR 栈（不在本仓库范围） |
| QA runtime ×2 | `127.0.0.1:1785N` | 账号文件下载（`/<pathPrefix>/account-N/files/<64hex>/<name>`） | 既有 `chatgpt-web-runtime-N` |
| Full runtime ×2 | `127.0.0.1:1795N` | 工具模式浏览器运行时 | 本仓库 `01_deploy_external_mcp.py --stage prepare` |
| local MCP ×2 | `127.0.0.1:1796N` | `mcp --transport http --contract native --public-origin <origin>` | 同上 |
| CPR provider ×2 + socat bridge ×2 | `127.0.0.1:1797N` -> Unix socket | 认证、只发布 `<slug>-tools` 别名，再转到该账号 Full runtime | 本仓库 `02_deploy_public_tools.py` |

请求流向：

```text
公网 MCP      https://<origin>/local-mcp/account-N/mcp -> ingress -> 127.0.0.1:1796N -> Full runtime 1795N
公网文件      https://<origin>/<pathPrefix>/account-N/files/... -> ingress -> QA runtime 1785N
公网 Full API https://<origin>/v1 -> ingress -> CPR 18082 -> provider 1797N -> bridge -> cpr-provider.mjs -> Full runtime 1795N
```

要点：

1. `/local-mcp/account-N/mcp` 是**精确映射**；`/local-mcp/` 下任何其他路径一律 404，不会落到 CPR 或文件路径。
2. MCP 路径自身不需要 bearer key：它靠 Host/Origin 白名单加**活动回合能力**授权，会话 ID 不授权工具（见 `docs/mcp-http-experiment.md`）。
3. 公网 Full API 走 CPR 的现有鉴权：每账号一份独立 key、独立分组、并发上限 1；原 QA/key/group/project 不变。
4. 部署脚本不自动重启共享服务。`--stage ingress` 只写配置和 dropin，重启 `chatgpt-web-public-ingress.service` 由管理员在确认无在途公网请求后显式执行。
5. 同一个 `/v1` 入口上的模型身份是分开的：Full provider 的 `/v1/models` 只列独立 Full 目录里的 `<slug>-tools` 别名，`/v1/responses` 与 `/v1/responses/compact` 只接受这些别名（转发前剥掉后缀，响应里的 `model` 字段再写回别名），原名在该 Full provider 触达上游前就被 400 拒绝；QA 模式（`config.mode!=='full'`）的目录与请求体保持原样。别名只换身份，不放大工具权限，也不存在 QA/tools 自动回退。

## 前置条件

1. 安装本仓库和 `launcher/` 的锁定依赖，见下方构建命令。运行包的许可证生成也会读取 launcher 依赖。
2. 两账号的 QA 资料已存在：`~/.local/share/codex-chatgpt-web/account-{1,2}/`（含 `config.json`、`models.json`）。
3. CPR 栈以 podman 运行，容器名可用 `--sql-container` / `--cpr-container` 覆盖；provider_accounts 里存在可复制的账号模板（默认名 `chatgpt-web-linux-{1,2}`）。
4. 已知公网域名（`--origin`），且反代/隧道把该域名交给 ingress 的 `127.0.0.1:<ingress-port>`。反代/隧道细节属于部署主机，不在本仓库。

## 管理员步骤

### 1) 构建运行包

```sh
bun install --frozen-lockfile --ignore-scripts
bun install --cwd launcher --frozen-lockfile --ignore-scripts
bun run scripts/build-runtime-bundle.ts /path/to/runtime
```

产物含 `bin/codex-chatgpt-web`、`app/cli.js`、`app/download-gateway.js`、`runtime/bun`。

### 2) 建立双账号 Full + local MCP

```sh
python3 deploy/01_deploy_external_mcp.py --stage prepare \
  --release /path/to/runtime --origin https://<origin>
```

- 每个账号生成 `~/.local/share/codex-chatgpt-web/full-N/`（`config.json`、`client/config.toml`、运行日志），并写 `chatgpt-web-full-N` / `chatgpt-web-mcp-N` 两个用户级 unit。首次运行会生成 `controlToken`；重跑会复用已有配置，不会重新生成凭据。
- QA 资料、浏览器、原服务都不改写、不重启。

### 3) 接通认证 CPR Full 路线

```sh
python3 deploy/02_deploy_public_tools.py --home ~/.local/share/codex-chatgpt-web \
  --models-file ~/private/full-models-{account}.json
```

- 每账号新增 `chatgpt-web-full-provider-N`（认证 provider，`deploy/cpr-provider.mjs`）与 `chatgpt-web-full-bridge-N`（只绑回环的 socat 桥），并写一条 CPR provider account/group/key，指向 `http://127.0.0.1:1797N/v1`。
- `--models-file` 支持 `{account}`：首次创建 Full 路线时，它必须是**独立的 Full 目录**（例如保留的 `models.json.before-browser-only-20261001`，含全部 9 个 slug）；脚本把它复制成 `<home>/full-N/models.json`（0600 普通文件），不再软链账号的 QA `models.json`。
- `<home>/full-N/models.json` 已存在且不是软链时按原样使用；若是软链、或 `--models-file` 指向账号 QA 目录，脚本直接退出，不做静默迁移（替换在跑路线的目录是管理员单独执行的迁移动作）。
- 新 Full 账号的 `model_access_json` 就是同一份目录的 `-tools` 后缀允许清单，与 provider 发布的别名一一对应；原 QA key/group 不因此扩权。
- 幂等：账号/分组/key 标识确定，重试复用 `<home>/full-N/public-test.json` 里的同一份 key，DB 事务带 `ON CONFLICT DO NOTHING`。重复执行不会产生第二套凭据。
- `account_groups.color` 有 NOT NULL 与 `^#[0-9A-F]{8}$` 约束：脚本默认复制表内已有的合法色值，或用 `--color '#RRGGBBAA'` 指定；非法值在事务开始前就报错退出（这是首次部署两次事务回滚的修复）。
- 不重启 CPR、QA、Full、浏览器或 ingress；DB 凭 `runtime_settings.config_revision` 自增被感知。
- 输出只含账号、状态、端口、恢复记录路径，不含任何 key。把客户端 key 从恢复记录（0600）交给使用者，不要入库、不要提交。

### 已有 QA 账号池的目录元数据

只返回 `data[].id` 的旧 QA 池会让 CPR 为普通模型生成通用编程助手说明。这不是纯聊天的模型说明，不能继续沿用。

对于已经部署了 `src/qa-pool.ts` 的服务器，在它的源码目录应用本仓库的 `deploy/qa-pool-catalog.patch`，重新构建 QA pool。给现有 pool 配置增加 `modelCatalogPath`，指向原有纯聊天 `account-N/models.json`，并在无在途请求时重启 pool。补丁只增加目录元数据，不改请求处理、会话分配或提示词；不要将其他任务的整份 QA 源码覆盖进去。两账号共用一个目录时，先确认元数据一致。

修改已有账号的目录后，在 CPR 管理界面刷新该账号模型目录，或调用已认证的 `POST /api/admin/accounts/models/refresh`，请求体为 `{"accountId":"对应provider账号ID"}`。只改 DB 允许清单不保证旧目录缓存立即失效。

验收 `GET /v1/models?client_version=<客户端版本>`：普通模型的 `base_instructions` 和 `model_messages` 应来自原 QA 目录；`-tools` 模型应来自独立 Full 目录，不得互相复用。对应 key 需已获准两个模型组。

### 4) 切换公网入口

```sh
python3 deploy/01_deploy_external_mcp.py --stage ingress \
  --release /path/to/runtime --origin https://<origin>
# 确认没有在途公网请求后：
python3 deploy/01_deploy_external_mcp.py --stage ingress \
  --release /path/to/runtime --origin https://<origin> --restart-public-ingress
```

- 写入 `public-ingress.json` 的 `mcpAccounts`（`account-N -> 127.0.0.1:1796N`）以及 ingress dropin；第一次运行会先备份原配置为 `public-ingress.before-external-mcp.json`。
- 不带 `--restart-public-ingress` 时只输出重启命令，不自动重启共享入口。

### 5) 为两个 ChatGPT 账号连接 MCP

这是管理员在服务器上一次性完成的操作，不要求每位 API 使用者重复配置。

1. 在各账号的 ChatGPT 打开 `/plugins`，添加自定义 MCP 服务器，名称填 `Codex Cloudflare`。
2. URL 分别填 `https://<origin>/local-mcp/account-1/mcp` 和 `https://<origin>/local-mcp/account-2/mcp`，认证方式选择无认证；创建后连接。
3. 如需无人值守调用，仅对这个连接器在权限页选择允许所有工具。它可能在活动回合中请求执行客户端工具，因此只连接自己控制的入口；客户端的沙箱与审批仍生效。

如果账号没有自定义 MCP 创建权限，不能把安装成功当作工具路线已可用。

### 6) 验收（不是只看 HTTP 200）

1. `GET https://<origin>/local-mcp/account-N/mcp` 返回 MCP 层错误（如 400/406）而不是 404，说明该账号路径已接通。
2. 用客户端 key 调 `GET https://<origin>/v1/models`，目录由它获准的组决定：QA 组给出原名，Full 组给出 `-tools` 名称；同时获准两组时，两种名称同时出现。Full provider 直接收到原名必须返回 400，QA provider 直接收到 `-tools` 也必须拒绝，不能串线。
3. 真正的验收是一次真实回合：模型在本机执行命令或调用本机 MCP，并返回实际输出。只看连通性、健康检查或首个字节不算通过。

## 客户端接入

### 公网 API（推荐）

| 项 | 值 |
| --- | --- |
| base_url | `https://<origin>/v1` |
| 模型 | `chatgpt-web/gpt-5.6-sol-tools` |
| key | 管理员发的工具专用 key（`Bearer`） |
| 协议 | Responses API（`wire_api = "responses"`） |
| 是否需要 SSH / cloudflared | 不需要 |

同一个 `base_url` 不等于同一组权限。纯聊天使用 `chatgpt-web/gpt-5.6-sol`，工具模式使用 `chatgpt-web/gpt-5.6-sol-tools`。管理员可以为同一个 key 同时授权 QA 与 Full 组，用户随后只需选择模型；原聊天 key 不会自动获得工具权限。两种模式不互相回退，工具路线失败也不能改用纯聊天返回。切换模式请新建会话；已有工具客户端需将公网模型名改为 `-tools`。同机脚本直接连接 Full runtime，仍使用底层原名，不经过公网别名映射。

```toml
model = "chatgpt-web/gpt-5.6-sol-tools"
model_provider = "web"

[model_providers.web]
name = "Public tools"
base_url = "https://<origin>/v1"
wire_api = "responses"
env_key = "TOOLS_API_KEY"
```

客户端必须支持 Responses API 与**本机工具执行**：工具在客户端机器上运行，不是在服务器上运行。只显示文本的客户端、普通浏览器或没有工具权限的客户端不会因此获得本机工具能力。

以下两件事仍是客户端自己的责任，服务器不代做：

1. 安装/注册要用的本机 MCP 与 skill。
2. 在客户端里批准要用的工具（例如单工具 `approval_mode = "approve"`）；沙箱与审批策略仍由客户端决定。

2026-10-05 公网实测：两账号的自动工具目录发现与按名称调用都通过（本仓库 `mcp-server` 修复后无需再手写 `wire_name`）。

### 同机客户端脚本

在放有隔离资料的机器上（默认 `~/.local/share/codex-chatgpt-web/full-N/client`）：

```sh
deploy/03_codex_web_tools.sh 1        # 第二个账号：deploy/03_codex_web_tools.sh 2
```

`CODEX_WEB_TOOLS_HOME` 覆盖资料根目录，`CODEX_WEB_TOOLS_BIN` 覆盖 Codex 可执行文件；脚本只切换 provider，不改沙箱/审批参数。纯聊天继续用原来的入口。

## 恢复与回滚

| 目标 | 做法 |
| --- | --- |
| 撤回公网 MCP 路径 | 还原 `public-ingress.before-external-mcp.json`，删除 `chatgpt-web-public-ingress.service.d/zzzz-external-mcp.conf`，`systemctl --user daemon-reload`，再按窗口重启 ingress |
| 撤回 CPR Full 路线 | 停 `chatgpt-web-full-provider-N` 与 `chatgpt-web-full-bridge-N`，按 `<home>/full-N/public-test.json` 记录的 account/group/key 标识在 CPR 中撤销或停用 |
| 回到纯聊天 | 原 QA 入口、key、分组、项目本来就不变；不要停原 Full/MCP/QA/CPR 服务 |
| 部署失败重试 | 直接重跑同一命令：配置与 key 复用，DB 写入幂等；不要手工再建一套账号或 key |
| 撤回 `<slug>-tools` 别名 | 按迁移前记录同时还原 provider 版本与 DB 模型允许清单；只更换目录不会撤销后缀。不要把 QA 目录重新当作 Full 目录 |

## 已知边界

1. 只在 Linux 服务端 + Linux 客户端实测；Windows/macOS 客户端、多用户并发与长期稳定性未验收。
2. 两账号共享各自浏览器的标签上限；Pro 限额仍按 runtime 计数，未做跨 QA/Full 统一计数。
3. 服务器上的反代/隧道配置属于部署主机，仓库只保存示例（`deploy/Caddyfile.example`）。
4. 公共目录本身不授予执行权限：工具调用需要活动回合能力，会话 ID 不等于授权。
5. `-tools` 别名只改变公开模型身份、响应回显和 DB 允许清单，不新增工具权限：工具与本地 MCP 仍在客户端执行，客户端的沙箱与审批不变。
