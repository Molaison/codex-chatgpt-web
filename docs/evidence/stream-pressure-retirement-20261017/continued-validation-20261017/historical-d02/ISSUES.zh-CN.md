# 本轮实测失败的最小证据（供主线程 Linear 查重）

固定候选：PR6 `2e1d3e3cfc74b856d02faf6099d629c22a83cdca` + PR7 `f1fde6f726112fff41a256ef4688712e7858293e`，主线基线 `3be25ae2855a2234cf8ae82e75f7717047293b86`。Git 合并无冲突，tree `d5162b311c7bbf926a7ee33ac94857664ca86800`，已冻结成本地提交 `d02a88115cc5af86ad65f94f7690293503300784`，分支 `validation/pr6-pr7-20261017`。

这些结果不属于后续上游整合版本。所有生成均白名单 GPT-6 Sol Instant、关闭 Pro 能力；无 Astra/6Pro、无新软件、无认证复制或变更、GPU 0。

## A. CPR 缺调用方指令 ID：精确重试无法取回已完成结果

实际入口：候选 `deploy/cpr-provider.mjs` 的 AF_UNIX HTTP -> 仅注入本任务夹具认证的透明桥 -> 候选 pool -> 候选 runtime/helper -> 既有登录的真实 ChatGPT 独立测试页。共享 Rust CPR 网关未改动，不能据此声称完成共享网关验收。入口脚本 `source/live-cpr-server.mjs`，客户端 `source/live-cpr-client.mjs`。

原始 input 为单条 user message，文本 `Reply with exactly: CPR IDENTITY READY`，无 item id，temporary 模式，原生 thread/turn/request_id 都固定。首次 HTTP `x-request-id=cpr-wire-one` 成功，明确 completed。

保持原始 JSON 完全相同，仅把传输请求号改成 `cpr-wire-retry`：预期重放同一响应；实际 `409 request_identity_conflict`，消息 `This request identity was already used for a different payload`，新增 Send 激活/接受为 0。

原因定位：CPR 正常化用传输请求号合成 user item id；新合成 ID 改变 pool 的 payload digest，原生 request_id 并未变化。此为已知 MOL-184 缺 ID 诊断的真实复现，应先查重。

证据：`cpr-seed-request.json` / `cpr-seed-result.json`、`cpr-retry-request.json` / `cpr-retry-result.json`。首次结果前后 Send 12->13，失败重试 13->13。这里计数是 helper 的激活/接受边界，ChatGPT 物理 POST 数未独立抓取。

## B. CPR 缺调用方指令 ID：新的相同文本被静默复用旧执行

同一个已完成会话与 turn、同一无 item id 的文本。将原生 request_id 改成 `cpr-native-new-instruction`，previous_response_id 指向首次结果，传输 `x-request-id` 保留 `cpr-wire-one`。改变 request_id 本来不足以证明新指令，预期明确拒绝身份歧义。

实际：27ms 返回 200/completed 与旧文本 `CPR IDENTITY READY`，新 response id，但没有新 Send（13->13）。CPR 合成的相同 item id 使 pool 无法发现原始调用方缺 ID，绕过窄身份拒绝并复用了保留执行。直连 pool 的对应缺 ID 请求已真实返回 `409 instruction_identity_required`，精确重试与不同稳定指令 ID 正向对照均通过；不能把它泛化到 CPR。

证据：`cpr-ambiguous-request.json` / `cpr-ambiguous-result.json` 与同一脚本。此场景明确保留请求差异，不能隐藏或算通过。

## C. 初期 CLI 环境拒绝：配置/测试入口问题，已排除一般性 native 工具缺陷

官方 0.162.0、官方 0.154.0、Web-tools 0.154.0 的自定义 provider 入口均在 Send 前退出 1，可见错误：`Codex rollout does not authenticate the historical environment messages`，CLI JSON 未暴露机器错误 code。记录在 `native-closed-stdin-events.jsonl`、`baseline-native-events.jsonl`、`legacy-native-events.jsonl`、`webtools-native-events.jsonl`；前后 Send 不变。

已找到项目 `scripts/smoke-codex-environment.ts:13` 明示：custom/API-key provider 会剥除逐条 provenance。真实 wire 保留 message id，但没有 item turn attribution；源 guard 按历史环境查验而拒绝。因此不应把这些尝试直接建成“正式 CLI 工具在 main/candidate 均坏”的产品缺陷。

改用已存在 ChatGPT 登录与项目正式内置 openai provider + 仅本次 openai_base_url 覆盖后，CLI 0.162.0 逐条归属信息真实保留，工具实际执行并完整回传，退出 0。没有复制登录凭据、伪造元数据或放宽 guard。后续真实 resume 和结果流中断恢复也通过。证据 `cli-auth-zstd-*`、`cli-repeat-*`、`cli-tool-result-stream-cut.json`、`cli-change-*`。

观察代理首次不支持原生 zstd 而退出、以及第一次覆盖保留内置 provider 表被 CLI 拒绝，均为本任务夹具错误，原日志保留；修正后原字节转发。它们不应建成项目产品缺陷。

## CLI 真实通过与剩余门槛

真实 CLI 0.162.0 同一会话：首次计数文件由不存在变 1；resume 重复同一指令后只变 2；在真实工具结果的输出 delta 后、完成信号前切断专属连接，CLI 显示 Reconnecting 1/5 后恢复，文件仍为 2；再 resume 改口为无工具追问，回答 `COUNTERS 1,2; CURRENT 2`，文件仍 2。三个 CLI 命令退出码均 0。

工具后的模型续跑与有变化的重连请求也保守计费，本轮硬预算占用 24/24，已停止所有真实调用。观察到 21 次 Send 激活和21次接受；物理 ChatGPT POST 总数未独立可观测，不用该 Send 数替代模型续跑预算。

旧/过期会话的 CLI resume、仅重启 pool 后 CLI 续问、两次断读取、CLI steer/rewind/fork、真实 broker ACK 丢失、真实浏览器 snapshot/CDP 故障、真实 adapter EOF 等未完成，不能称鲁棒性全面验收。过期/重启/升级/断线补读已有后端+浏览器证据，必须与 CLI 证据分开。

## 适用范围复核

该provider正常化显式支持字符串/缺item id输入，不是无效JSON夹具。原生元数据保留，identity是合法编码；不经过CLI观察代理。零模型复核在添加逐条turn归属以及identity/gzip/zstd下均保持相同缺陷，稳定调用方item id正向对照正常。正式CLI发送稳定item id后没有复现这两个失败。请将票限定为QA CPR provider第三方/缺ID输入安全边界，查重MOL-184/MOL-189，不能写为正式CLI普遍失败。

上游整合64593284cdea07f74dfdc0e36e7fb1af7c65f60f的相关五个生产文件与原候选哈希相同；原样十一场景仍8通过/3失败。新整合没有追加真实模型验收。
