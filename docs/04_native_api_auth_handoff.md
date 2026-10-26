# 隔离测试 usage 的原生 API 认证

本包只新增可选的本地入站 Bearer 边界。它使共享主机上的新测试 API 不再无认证暴露账号会话。它不证明真实 Full 恢复、原生工具 ACK 或 Windows 桌面验收已通过。原恢复与 systemd 合同仍以 [03 交接](03_read_only_observation_handoff.md) 为准。

## 配置与私有读取

数据形状只有 `AppConfig.nativeApiTokenFile?: string`。配置 JSON 只保存绝对路径，可使用 `~/` 展开。未配置时维持旧入口、原 OAuth 转发和旧 caller，不引入新前提。

```json
{"nativeApiTokenFile":"/absolute/private/test-native-api-token"}
```

文件内容必须是独立随机 API token，43 至 128 个 ASCII base64url 字符，可以有一个末尾 LF 或 CRLF，不能有 BOM、空白或第二行。部署 owner 在批准窗口通过已有私有文件机制生成，不能复用 controlToken 或 MCP OAuth。本包没有生成运行 key，没有读取或借用真实 OAuth。代码还显式拒绝 token 等于 controlToken。

POSIX 文件必须由运行用户持有，group/other 权限为零，推荐 0600 或 0400。拒绝符号链接和非普通文件。Windows 私有 ACL 仍由既有安装/部署 owner 负责，代码不声称验证了 ACL。

`serve` 仍是 `loadConfig()` 到 `startServer(config)`，没有新增传 secret 的 CLI 参数。启动时在 HTTP listener 和 Full broker 之前读取一次。路径错误、缺失、不可读、空文件或非法内容直接启动失败，不回退无认证。运行后换文件或删文件不改变当前进程的认证值。换 key 要由部署 owner 在批准窗口受控重启，不能借此绕 native drain/seal/safe_to_stop。

调用方只通过已有私有 credential reader 提供 `Authorization: Bearer <私有读取所得值>`。值不进入环境变量、普通证据、配置、provider、notice、模型输入或错误。父的 `07_test_api_auth.py` 属于部署/客户端包，不是后端依赖。

## 精确 HTTP 合同

所有 `/v1`、`/v1/*` 请求在 parser、admission、adapter、upstream 之前统一校验。未知路径、非 POST 方法和 WebSocket upgrade 也不能绕过。缺失或不匹配返回 HTTP 401，固定 `authentication_error`，并带 `WWW-Authenticate: Bearer` 和 `Cache-Control: no-store`。比较复用既有 `timingSafeEqual` 机制。旧浏览器 Origin 防护仍存在，有正确 API key 也不能绕过。

| 入口 | 新配置 usage 的行为 |
| --- | --- |
| `GET /healthz` | 不要求 API key，不触发模型。 |
| 既有普通 `/admin/*` | 仍校验 controlToken，不接受本地 API key 代替。既有 `/admin/release/*` 保留原 release token。 |
| `GET /v1/models` | 正确 key 返回本地 Web 模型目录，只包含原 Web routes，没有 native 模型，没有上游目录请求。 |
| `POST /v1/responses`、`POST /v1/responses/compact` 的 Web 模型 | 保留原 parser、会话、Full、工具和 compaction 栅栏。错误 JSON 仍 400；本地 key 不进入 adapter metadata。 |
| 上述两个 POST 的非 Web 模型 | HTTP 501，`error.code=native_upstream_auth_unavailable`，`submission_state=not_submitted`。不转发、不自动换模型。 |
| `POST /v1/alpha/search`、`POST /v1/images/generations`、`POST /v1/images/edits` | 同样 501。需要独立上游认证，没有合同就不借本地 key/OAuth。 |
| `GET /v1/responses`，包括 WS upgrade | 先认证；正确 key 后维持原 HTTP 426，未新增 WS 支持。 |

本地 API key 只在入站边界消费。通过后从内部 Request 删除 Authorization，不能作为 OpenAI/Codex 上游凭据。本包不新增公开 MCP 工具、权限或服务。

本地目录逐条显式 `multi_agent_version="v1"`，包括配置 `subagentProtocol="native"` 时，不靠 features 禁 V2 代替。目录采用冻结 0.162.1 的 `protocol/src/openai_models.rs` 中 ModelInfo/ModelsResponse 合同。必需的 `support_verbosity`、`truncation_policy`、`experimental_supported_tools` 明确提供。ModelsResponse 还强制有 instructions template，因此只从本 revision 已验证的 `07_recovery42_models_v1.json` 原 Web alias 静态内嵌相同 17730 字符的 `base_instructions`，不复制其 approvals、permissions、guardian 或其他 model_messages，也不读 OAuth。默认关闭 apps usage instructions，不虚标原生搜索、图片 API 或实验工具可用。该静态元数据随 bundle 构建，不是新增运行前提。

Web Responses 的 `input_image.image_url` 和 `input_file.filename/file_data` 原结构仍交给 Web adapter，不误禁附件。既有只传 `file_id` 的限制不变。上表限制的是独立 native images API，不是 Web 会话自己的图片或附件路径。`/v1` 以外的下载入口保持原合同，本包不声称整个服务的所有 URL 都由此 token 保护。

## 验证与证据边界

`tests/42_native_api_auth.test.ts` 使用真实 loopback HTTP 和独立随机私有 fixture 文件，覆盖 QA/Full listener、缺/错 key、所有现有 v1 路由和未来路径、upgrade、正确 key 到 parser 400、health、原 admin、一次读取、旧 OAuth 转发。本地 catalog 与 native 501 路径均由 upstream spy 证明没有派发。附件测试只用零模型 adapter spy，证明 key 不进入 metadata/provider/parsed input，图片与文件结构保留，不代表真实上传已完成。

启动失败测试先于 Full broker/socket/SIGTERM handler，并覆盖缺失、空、格式、过长、复用 controlToken、不私有与符号链接。CLI 子进程测试从真实配置启动本地 listener，验证 401/400、本地目录和正常 SIGTERM。构建后的同一 CLI 再做零模型请求验证，具体命令、exit code 和日志见 `04_native_api_auth_result.json`。

旧 `tests/model-catalog.test.ts` 验证共享目录构造没有改变旧 usage 的 native/Web 元数据。初次附件 fixture 误选了只适用于 Luna-only 账号的模型，出现预期路由 400；已改为 fixture 账号原本可用的 Web route，没有放宽产品校验，失败和修正证据均保留在日志。

真实 native `debug models` 离线解析曾报缺少 `support_verbosity`，随后另报 `experimental_supported_tools`。错误保留在 `04_native_api_auth_catalog_schema.log`。依据冻结 serde 原文补齐后，定向测试把真实 Full loopback `/v1/models` 响应交给原生 parser，验证全部原 Web slugs 和逐条 v1，期间 upstream spy 为零。该检查只证明目录兼容，绝不代表 Full 工具资格。默认测试不要求安装 Codex；指定 `NATIVE_API_TEST_CODEX` 才执行该离线 parser 合同。

这不是远端部署验收。父在用户批准窗口负责实际私有 key、SSH 转发和客户端 reader 接线，以及真实原会话异常 E2E。没有新 intent、模型请求、远端修改或生产修改。

## 本轮修改清单

- `src/config.ts` 新增可选路径字段与配置校验，不保存 token。
- `src/native-api-auth.ts` 启动加载、私有文件约束和共享 constant-time Bearer authorizer。
- `src/server.ts` 统一 v1 gate、消费本地 Authorization、Web-only 目录和独立 native 不支持错误，admin 沿旧 authorizer 语义。
- `src/model-catalog.ts` 复用原 Web row 构造，独立输出本地 Web-only 目录，旧 native augmentation 不变。
- `src/chatgpt-web-model-instructions.ts` 仅保存已批准 Web alias 的既有指令模板，不含权限或认证元数据。
- `src/setup.ts` 把可选路径纳入既有 runtime-change 比较，保留 setup clone 的原字段。
- `tests/42_native_api_auth.test.ts` 本轮窄合同与 CLI loopback。
- 本文、`04_native_api_auth_result.json` 和编号日志记录交付与边界。`dist/runtime` 是最终同候选构建。

旧 readonly、Full terminal proof、notice、compaction 修正及原 source/01/02 patch 未被覆盖。父在 owner 停写后导出含本轮变化的 03 组合增量，不复用此前构建冒称新包。
