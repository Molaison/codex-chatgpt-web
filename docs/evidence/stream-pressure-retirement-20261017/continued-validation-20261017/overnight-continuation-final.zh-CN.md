# 当前候选的补充验证交接

本次要求补齐的真实 HTTP、原生 CLI 和本机真实 Chrome 本地 fixture 已执行完成。它们支持下表限定的结论；不能据此把当前候选称为真实 ChatGPT 网站全面验收通过。新增真实模型提交为 **0**，没有重开此前保守封账的 24/24 模型额度，没有使用 Astra 或 GPT-6 Pro，也没有合并或部署 PR13。

SSH `ywl` 可用，执行身份为本机 `<WIN_EXECUTION_IDENTITY>`、远端 `<YWL_USER>`；使用既有路由。没有复制凭据、更换认证、安装软件或操作共享服务。

## 测试对象与版本

- 候选为 PR13 `cb12f370feb558002c7416ffe0087a9814e1b091`，树 `cd61345eca6242cd98d8228421faf9327e76871c`；基线 main 为 `fbabf15c49a4c11862b88eaf6268845c85808665`。本批只在候选执行，未新增同层基线对照，不能据此宣称相对 main 全面零回归。
- Git 祖先检查确认候选包含 PR6 的 `2e1d3e3`、PR7 的 `f1fde6f`、早前实测组合 `d02a881` 和上述 main；没有把两个旧 PR 单独的结果冒充当前组合。远端仓库为 `https://github.com/Molaison/codex-chatgpt-web.git`，生产源码、package 与 lock 的工作区差异为空。
- 最新 GitHub 查询：PR6、PR7、PR12 已合并；PR13 **open、ready、未合并**。这些状态不同于最初收到任务时的草稿状态。本执行器没有执行合并。
- 实际原生 Codex CLI 为 **0.162.0**，真实 app-server initialize 也返回该版本；远端 Bun **1.4.0+34cbb9a40**；本机 Chrome **155.0.8059.80**、Playwright Core **1.62.0**。本地服务 health 返回 **6.1.10**。本机 Chrome 用的是当前候选的生产源码，103 个源码/package/lock 文件与远端逐项相同；不是安装包上线验收。
- 精确候选的 push CI [39061660121](https://github.com/Molaison/codex-chatgpt-web/actions/runs/39061660121) 和 PR CI [39061663512](https://github.com/Molaison/codex-chatgpt-web/actions/runs/39061663512) 再次查询均 completed/success；原始日志和先前失败保留在前一批证据中，没有重新运行 CI。

## 本批实际结果

| 路径与输入 | 预期 | 实际结果和验证层次 |
|---|---|---|
| 真实 loopback HTTP SSE，10001 字符首次回答及相同请求补读 | 首次完整；同步补读过载只能明确失败，不重复 Send | 首次 200、唯一 completed/DONE、全文 SHA 匹配；补读 200 SSE、唯一 failed/DONE、`adapter_event_backlog_exceeded`、不可重试；2 次 Responses、1 次受控 worker/Send。真实 server/adapter/journal，只有 worker.run 替换 |
| 原生 CLI 新建及同 home `exec resume` | 各完成一次；续聊读取上一轮历史 | 均 exit0、唯一完成和正确 canary；同一个 thread。原请求历史及生产 prepare 编译上下文都包含旧 canary，续聊输入没有偷偷带入旧答案 |
| 原生 CLI 已接受后连续两次部分 SSE EOF | 缺终态不能报完成；相同逻辑轮次只提交一次 | 原生输出两次 Reconnecting；3 次 HTTP 的 identity/input SHA 一致，前两次已提交且 body 已 flush、没有终态，第三次唯一 completed；worker/Send/Submitted 各 1。只切本任务两条连接，没有断网，也不声称测试了网卡故障 |
| 实际 app-server 的 Interrupt 目标与 peer | 精确取消目标，另一 thread 继续完成 | 生产安装/校验的 Interrupt hook 在原生 hooks 列表为 trusted 且 hash 一致；目标原生状态 interrupted、worker 实际退出，peer 未被取消并完成正确 canary。一个实际 app-server，两个受控 worker；真实模型并发为 0 |
| 20 次原生 CLI 完整生命周期 | 每次子进程退出、clear/等待物理退出、health 归零 | **20/20** 完成，逐次记录 HTTP/browser=0、nativeChildren=0。整套 CLI 共 25 个逻辑轮次、27 次 Responses、24 个原生子进程；114 个记录 PID 均已不存在，两端口关闭；监督器未强杀遗留 |
| 真实 Chrome 本地 DOM，JSON/SSE 首次及同步补读 | 正常答案完整，补读过载保持一个明确失败终态 | JSON 首次200/补读502；SSE 首次及补读均200但分别 completed/failed，SSE 各仅一个 DONE。每组 worker/模拟 Send 各1；答案来自真实 DOM 响应循环，10001 个字符事件是明确标注的受控 relay |
| 真实 Chrome 收到前缀后关闭 HTTP reader | HTTP 观察者退场后，后台仍完成并可补读全文 | **先确认 health HTTP=0/browser=1**、owner 未 abort、Chrome 仍活，再改变本地 DOM 完成回答；原 Chrome 退出后，同一请求补读37字节完整答案；仅1次启动/模拟 Send。证明运行中的 journal，不证明重启后的持久恢复 |
| 真实 Chrome 定向取消后同 owner 发新轮 | 旧浏览器真实退出前不能启动替代浏览器 | 旧 child 仍活时 browser=1、替代请求已进 adapter 但未启动 Chrome；实际 close 在约20030ms，新 Chrome 启动在约20300ms；替代回答正确，最终 browser=0 |
| 真实 Chrome 在服务关闭时仍未退出 | 持续 draining/busy；真实 child 退出后再关监听 | child 活时 accepting=false/browser=1，立即 shutdown 请求409；**单项补验在 fixture 显式 stop 之前，以新 TCP 连接取得 ECONNREFUSED**。真实 child close 与监听自然关闭均有独立记录 |

Chrome 初次执行 4 项通过、107 断言、6 次 Chrome 启动。非作者复核指出初次 shutdown 的宽泛 health catch 不能独立证明自然关监听；原记录和有限判定完整保留。随后只补强该项，单项复验 1 通过、17 断言、1 次 Chrome 启动，其余3项按精确名称过滤，没有删掉失败场景。两次执行总共 10 次 Responses；与独立 SSE 的2次、CLI 的27次合计 **39 次本地受控 Responses**，真实模型提交仍为0。

CLI 首次准备执行因 Bun 在新 home 初始化自身缓存而提前停止，0 个 CLI/HTTP/模型请求；保留原错误和输入后，以执行前写入的任务所有权 marker 修正新目录判断，第二次正常完成。Chrome 早期类型检查失败、原始 fixture、先前无法支持结论的证据和所有后续补强均保留，没有改写为一次全绿。

## 清理、资源和证据边界

CLI 外层监控记录1123个采样，proxy RSS 峰约216MiB、任务进程树约550MiB、任务数据约95MiB。Chrome 初次 proxy 峰约267MiB、进程树约697MiB；单项补验约231MiB/633MiB。都未触发512MiB proxy、2GiB tree、2GiB disk停止线。它们是有限时间的采样观察，不是硬配额或永久无泄漏证明。

Chrome 在 Bun 主线程恢复运行前加入新私有 Windows Job，子进程归属不依赖易失的父子链。两次执行 Job 均自然清空，无监督器 kill、无遗留、所有记录身份的 PID 已退出；所有隔离监听在清理后返回 TCP 拒绝。任务外进程、用户浏览器 profile 和共享服务没有被清理。Chrome 使用全新目录、启用 sandbox、禁用 GPU，并拦截本地 fixture 页面的一切外部请求。

这批不是 ChatGPT 网站/helper 的登录、选模型、Send 按钮和浏览器 IPC 完整链路验收；没有测试真实 helper 的 end 握手、完成答案后 helper 继续滞留、OS 信号投递、进程重启后的历史/持久性、真实 broker 工具确认丢失，或当前候选缺 instruction ID 的全新相同文本入口。没有追加真实工具/拒绝恢复的模型调用。早前 d02a881 的真实模型/工具/历史和保留失败只属于其冻结版本，见历史报告，不转移成当前候选的通过或失败。

旧 Windows malformed-stream CI 超时仍未归因；当前两轮完整 CI 通过不能回溯证明旧超时原因已修复。原日志及声明保留在前一批包中。

## 审阅入口

统一交付包为 `overnight-continuation-review-evidence.tar.gz`，外部 `overnight-continuation-review-evidence-manifest.json` 记录整个包的 SHA256。包内逐文件哈希覆盖三份新增分层证据包、旧失败/CI包、历史真实验收包和本交接文档，版本范围分别标注。

- `overnight-continued-validation.csv`：本次六组门禁状态；`overnight-continuation-cases.csv`：逐项输入、预期、结果、提交数及证据。
- `overnight-cli-completion-root-independent-verification.json`：非作者核对74个归档文件哈希、23份原生 exec 输出、实际 app-server target/peer 状态及重连身份。
- `overnight-chrome-fixture/root-postexecution-verification.json`：两次 Chrome 执行的独立断言、源码绑定和 PID 检查。三张 PNG 已人工查看，页面醒目标注 Local fixture, not ChatGPT。
- `overnight-chrome-independent-review.*`：保留初次 shutdown 的证据限制；`overnight-chrome-shutdown-fix-review.md` 与 `overnight-chrome-shutdown-supplemental-review.*`：静态补强和单项实际复验的非作者复核。
- `overnight-continuation-github-snapshot.json`、`overnight-continuation-repository-postcheck.json`、`overnight-final-ci-manifest.json`：提交、祖先关系、当前 PR 状态和 CI 绑定。

本机证据根目录为 `.codex-tasks/20261017-windows-ci-crash/`；远端集中交付目录为 `<YWL_TASK>/windows-ci-evidence/`。归档不包含用户凭据、现有 profile、浏览器二进制或依赖安装目录。HTTP 仅保存身份、正文哈希、终态和故障元数据，未声称保存完整 HTTP 双向字节；原生 CLI stdout/stderr 与 app-server 输出原协议保留。

后续是否接受此范围的证据、合并 PR13 或部署，由父任务决定。本执行器已停止追加验证请求。
