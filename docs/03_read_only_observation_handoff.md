# 原执行只读恢复交接

候选已实现原 accepted 执行的只读接回，并扩展到 Full 已有终态原生工具回执的安全子集。没有部署、远端变更或新 intent。本地构建、风险合同和合成 DOM 结果不等于真实 ChatGPT、systemd 或 Windows App 验收通过。

父是部署与真实故障验收 owner。本实现 owner 只写本候选树，未改原 `source`、生产、旧会话或账号配置。原 02 pre-connect 修正保留。

## 交付与证据

- 源码及 Launcher 模块均在本候选树。
- runtime 构建入口为 `../tools/bun run build`，产物为 `dist/runtime`。
- 最终类型检查为 `../tools/bun node_modules/typescript/bin/tsc --noEmit`，记录为 `03_observation_typecheck.log`。
- 最终直接风险合同为四文件 24 pass / 0 fail，记录为 `03_observation_validation.log`。
- 四文件为 `42_observation_recovery.test.ts`、`42_full_observation.test.ts`、`42_browser_helper_send.test.ts`、`42_execution_helper.test.ts`。
- 此前同一改动包的 pre-connect 与 writer lease 合同已通过。它们不是新增真实业务恢复场景，不与上述计数相加表示恢复率。
- 构建日志为 `03_observation_build.log`。父使用产物前以 `03_observation_result.json` 的最终状态为准。

合成 Chromium 合同真实连接同一个 CDP target、读取 DOM，并观察 Prefix 之后继续增长至完整 final。QA 与带 Full capability 的只读观察均核对 Send 为零、无导航、surface/helperPid 不变、一个 user 和一个 assistant。网页内容仍是本地拦截的合成 ChatGPT DOM，没有访问 ChatGPT。

Full adapter 合同使用真实本地 TurnBroker claim/invoke/complete/cleanup 回执，并从种入的 operation checkpoint 恢复。浏览器生成是合成的；没有运行真实原生命令或重启真实 Web 服务。它核对原 result hash、canonical round、完整文本、零新 tool_call，以及 notice 不进入 round 内容。

helper 子进程合同覆盖旧 usage EOF、新 checkpoint-backed EOF、最终 submission ACK 丢失及显式 shutdown。只有可信新 usage 的 EOF 保留；显式 shutdown 不保留。这些裸进程合同不是 systemd 部署恢复证据。

## 私有恢复数据与 DOM oracle

`operations/<digest>.json` 仍使用既有 checksum envelope；先解 envelope.payload，再读取：

```text
record.observation = {
  version: 1,
  identity: { operationId, executionKey, roundKey, threadId, turnId },
  traceId, modelId, accountId, appName,
  host: { pid, instanceId, profile, partition },
  lease: { helperPid, surfaceId, targetId },
  conversation: { key, url, claim },
  submission: {
    receipt, initialTurnIdentities, acceptedUserIdentity,
    assistantIdentity, acceptedTurnIdentities
  },
  toolChannel?: { tokenHash }
}
record.observationRound = {
  roundKey,
  deliveredToolResults: { [originalCallId]: resultHash }
}
```

`identity.roundKey` 永远是原物理 accepted submission 的 round。工具完成后的 HTTP round 由 `observationRound.roundKey` 另行绑定，不修改 Launcher 已登记的 checkpoint。恢复要求原 round 存在、当前 canonical round 相同且未完成、没有该 round 的未完成 tool_call/error。所有原工具结果必须在当前 parsed history 中保持原 call ID 与 hash。

父的只读 DOM oracle 使用 `lease.targetId`，同时核对 `descriptor.surfaceTargets[lease.surfaceId]`。不能在其他相似页面搜索答案，也不导航。`descriptor.observationInstanceId` 是 BrowserHost 实例的稳定随机标识。旧 `createdAt` 每次 writeDescriptor 都会更新，不能用作实例标识。

观察时核对原 saved URL、账号/profile/partition、host PID/instance、lease/surface/target、原提交 marker、原 user/assistant identity。`group:user:<key>` 和 `group:assistant:<key>` 是逻辑角色身份，DOM 容器的 `data-turn-key` 为 `<key>`。没有这些前缀的旧布局使用 `data-turn-id-container` 与 `data-turn-id`。全部原 Markdown 必须匹配已持久化并公开的前缀；只把剩余后缀作为新 delta 发布。

正常 writer 完成仍走原 `/turn/end`，按既有 retain/release 条件移除 target 映射。不能为 final oracle 延长权限。父需在 target 尚存在时同步取样，或明确保留此前与最终输出相符的 DOM 证据。恢复 observer 自身不调用 `/turn/end`，也不改变 writer 身份。停止续观察后仍使用既有 TTL 清理，不永久保留 tab。

## Full 终态栅栏与回执查询

`TurnBroker.inspectRetainedObservation(tokenHash, traceId, deliveredToolResults)` 只读原 local broker 的 durable channel。它不 register、claim、恢复 rawcap/binding、完成工具或修改 unknown。原 owner 仍在内存中时拒绝。旧 channel 缺少新 `observationState` 时拒绝，不能假定没有活动 claim。

新 channel 持久化活动 claim 的 digest 集合与 revision。恢复要求集合为空、原 binding link 相符、全部调用为 completed、result hash 完整、当前 HTTP round 已接收相同原结果。`observerLost` 没有原渠道 reconciliation 时继续 retained。开始只读观察前和 final 前各核验同一 receipt digest。

当前只支持 `exec_command`、`write_stdin` 的终态证明。结构化 running handle 必须有同 handle 的终态 poll。Native completed text 严格移植已验证 envelope grammar，不从 assistant 内容或随意关键词推断完成。Native running text 尚无可用证据，仍 unknown。其他异步工具和 freeform `exec` 未获终态证明时仍 retained。

私有 socket 增加 `owner_invocation_receipt`，请求包含原 `bindingId`、`invocationId`、`wireName`、`freeform` 及原 arguments/input 签名。它只返回既有状态与已完成结果；不同签名拒绝，缺失 invocation 返回 not_found/unknown，不表示未派发。它不调用 reconcileReceipt、不清除 observerLost，也不把 delivery 变成 sent。查询本身不触发 broker prune。六个公开 MCP 工具的名称与 schema 不变。

未完成原生执行、丢失 claim cleanup、缺少 native terminal receipt、原 HTTP round/result 无法证明，或旧 unknown 未对账时，本包不冒险恢复。此包不承诺原生工具跨进程崩溃的 external exactly-once。

## systemd 新 usage 合同

源码事实为 `LauncherBrowserHelperClient.ensureChild()` 使用普通 `spawn` 和 pipe stdio，没有 detached、独立 scope 或独立 service owner。helper 继承 Web 的 cgroup。此 owner 没有远端 `/proc` 实测，不能把代码推断写成当前部署事实。

父已采纳仅新隔离 usage 使用以下 unit 合同，仍须用户窗口批准：

```ini
KillMode=mixed
SendSIGKILL=yes
KillSignal=SIGTERM
# TimeoutStopSec 保留部署 owner 已批准的有界清理时长，不把超时当 native gate 通过。
```

不采用 `KillMode=process`。mixed 的初始 SIGTERM 只发给 MainPID；MainPID 退出后，剩余 cgroup 进程只收最终 SIGKILL。真实 MainPID 崩溃后，这避免 systemd 给 helper SIGTERM 并执行 Stop，同时不让 helper 无限残留。官方依据为 [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)，本轮已直接读取。默认 control-group 会把剩余 helper 一并 SIGTERM，不能把该部署当作已通过 EOF 恢复。

正常 stop 仍先通过原 owner 的 native drain、seal 和 `safe_to_stop`，再调用既有受控 stop/shutdown。`server.ts` 的 SIGTERM handler 在 gate 未通过时拒绝 shutdown；它不是对 systemctl 最终强杀的授权。禁止用 TimeoutStopSec 后的强杀绕 gate，或声称 gate 已通过。

gate 通过的正常 SIGTERM 路径仍是 server shutdown、clear turns、close browser workers、helper shutdown、原 tab cleanup，然后进程退出。显式用户 cancel/Stop 合同不变。mixed 的最终 cgroup SIGKILL 是有界兜底，不代替 graceful cleanup 证据。

父在花真实 intent 前须读实际 unit 的 MainPID、ControlGroup、KillMode、SendSIGKILL、KillSignal、TimeoutStopUSec，并对实际 MainPID 与 helper PID 分别保存 `/proc/<pid>/cgroup`、父子关系及 owner 身份。注入只用绑定 MainPID 的 pidfd SIGKILL，独立恢复任务先准备好。记录 helper 实际退出方式、原 target 是否继续生成、恢复后的同 round 全文，以及没有第二次 Send/原生调用。正常 stop 另验证 native gate、helper 退出与原 tab cleanup。以上都仍是父的真实部署验收待办，不由本地合同替代。

## 独立 provider notice

外部帧严格为：

```json
{"type":"response.provider_notice","notice":{"version":1,"id":"opaque-id","execution_id":"opaque-execution","seq":1,"kind":"resumed","observed_at":"2026-10-24T00:00:00.000Z","message":"已只读接回原执行，继续观察原生成。","source":"chatgpt-web","evidence":"observed"}}
```

事件不是 assistant/thinking item，不进入 response output、round.events、usage input 或 accepted history。独立 noticeSeq 按 execution 递增；最近 32 条单独持久化，重接重播相同 ID。message 为固定单行中文模板，每个模板小于 512 UTF-8 bytes，无 ANSI、URL、secret 或 raw 错误。id/execution_id 是不超过 128 字节的 opaque ASCII，observed_at 使用 RFC3339。

本次实际 hook 发 account_pinned、conversation_restored、observer_detached、reconnecting、resumed、tool_waiting、needs_reconcile，以及符合下述条件的 conversation_forked。固定账号 2 的测试路径没有合法换号动作，不造 account_changed。通知从不授权自动换号、fork 或重发。notice HTTP publication 失败只断开观察者，不取消 browser execution。旧 helper caller 没有显式协商 notice event 时不发送新可选 IPC 帧；旧 SSE client 可忽略新事件。

conversation_forked 只报告用户显式请求且已接受的新分支。`forked_from_thread_id` 必须非空且不同于 child thread。原 browser worker 必须成功走 `prepare` 新建路径，而非 `prepareResume` 或实际 conversation restore。原 `onSubmitted` 公开 accepted 前，observation checkpoint 必须已持久化，且 operation、execution、round、thread、turn、conversation key 全部绑定当前执行。QA 和 Full 共用此通知条件，发送和工具语义不变。

每个 operation 的独立 `forkNoticeEmitted` 与 notice 一起持久化，重复 checkpoint 或 accepted 回调不再创建 notice。重接可重播同一个 ID，不创建第二条事件。正常 first、resume、restore、仅收到 fork metadata、失败、未 Send、缺 checkpoint 或身份不匹配都不发分叉通知。不新增 fork 检测平台，不猜父源 mapping。这条路径的本地协议测试不代表真实 ChatGPT fork 或 Full 恢复 E2E 已验收。

## 修改清单

- `src/adapters/chatgpt-web/observation-recovery.ts`：checkpoint/domain/只读 host 校验及前缀核验。
- `src/adapters/chatgpt-web/native-terminal-receipt.ts`：严格 native 终态 grammar。
- `operation-journal.ts`、`turn-broker.ts`、`index.ts`：durable 身份、Full 栅栏、只读回执、同 round 接回、独立 notice。
- `browser-worker.ts`、`browser-helper-main.ts`、`launcher-helper-client.ts`：只读原 target 观察、受限 EOF 保留与协商 IPC。
- `src/launcher-browser-host.ts`、`launcher/electron/browser-host.cjs`、`launcher/electron/control-server.cjs`：稳定实例身份、observe-ready/observe 的精确 lease 核验。
- `src/types.ts`、`src/bridge.ts`：独立 provider_notice 与严格 SSE 编码。
- 两份新定向测试及 `docs/02_durable-runtime-recovery.md`：风险合同与准确能力边界。

本次按 Model the Domain 原则把恢复凭据与 HTTP round/tool receipt 分开建模。按 Make Operations Idempotent 原则拒绝恢复路径触及 Send/工具派发。按 Prove It Works 原则使用真实 Chromium 的实际 DOM 行为做本地证明，同时把 systemd、真实业务和桌面验收留给对应的真实证据。

共享主机的新测试 API 可选入站认证另见 [04 原生 API 认证](04_native_api_auth_handoff.md)。只有配置 `nativeApiTokenFile` 的新 usage 启用，不改变这里的只读恢复或 native unknown 栅栏。
