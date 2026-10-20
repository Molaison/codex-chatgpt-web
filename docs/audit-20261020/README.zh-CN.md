# 上下游增量审查与修复记录

## 范围和基线

本轮按照用户要求，额外安排五个审查代理，检查 `codex-chatgpt-web` 与下游 `llm-for-zotero-papers` 的错误路径，再由不同代理实施和复审。四个并发名额包括主代理，因此五路审查分批完成；没有把同一代理换名计作多个独立审查。

- 上游 main：`fbabf15c49a4c11862b88eaf6268845c85808665`。
- 上游已有 PR [#17](https://github.com/Molaison/codex-chatgpt-web/pull/17)：`2fb04127933a575eefee18ffd1378d00d668e6f6`。本分支以它为基线，追加修复及行为回归。
- 本轮上游增量交付为 [PR #18](https://github.com/Molaison/codex-chatgpt-web/pull/18)，以 PR #17 的分支为目标。源码发布提交 `9696909281a072cd80993ae8073d267b0648fa89` 的 tree `c7083c28fe047096e8bf24af384add57d12a00f9` 与本地复审提交 `610162926c3a390c30848d090967d3672174331d` 完全一致；随后单独补齐审计文档。
- 上游已有 PR [#13](https://github.com/Molaison/codex-chatgpt-web/pull/13)：`620d41e53e5ba856177d16cbe409ba4985983b73`。其事件背压和物理退出工作保留为独立依赖，既有证据不冒充本轮新跑的结果。
- 下游 `codex/papers`：`0b9e0774f4e675963c6fd77a1dd5b4844fc10e1d`。
- 下游修复已发布为 [PR #9](https://github.com/Molaison/llm-for-zotero-papers/pull/9)，提交 `7f30576336f57198ed0d9b6571ce503f791d42a0`。发布 tree `a620e5da1a3e1f4fc944b7ac2af7fd519d13c734` 与本地通过测试的 `013c1b8eb88d135dca9db238bfa35db25ba41ffb` 完全一致。
- pstack 源码：`cursor/plugins@88d47514b82e7c44f00f2b2a72ff6dd12158038c`。已阅读并应用 `poteto-mode`、`figure-it-out` 及相关幂等、领域建模、行为验证原则。当前工具不提供 Cursor 原生代理或指定模型组合，没有声称完成跨模型审阅。

全局 pstack 安装被环境自动审批明确拒绝：禁止修改 `/root/.codex` 的后代路径。未绕过此限制。本轮使用下载的原始技能指令协作，但不能将其描述为已经完成持久安装。

## 五路审查与去重

| 审查方向 | 证据与处理 |
| --- | --- |
| 上游传输、容量、重放 | 真实 pool/SQLite 配合受控 upstream，复现发送前容量拒绝将论文错误标为 uncertain；新增 [MOL-240](https://linear.app/molaison/issue/MOL-240)。重放契约缺口补回 MOL-201。 |
| 下游后台请求与上传状态 | 实际生产准备和调用函数复现同 PDF 并发认领、迟到结算、本地取消错误锁定；新增 [MOL-238](https://linear.app/molaison/issue/MOL-238)。 |
| Responses 协议和同类实现 | 实际 parser/adapter 复现 EOF、failed/incomplete、旧工具参数、保持连接开放及多个文本片段；新增 [MOL-239](https://linear.app/molaison/issue/MOL-239)。对照 OpenAI SDK 的终态处理，不以连接结束推断成功。 |
| 论文内容身份与隔离 | 实际账本复现 ready 和同请求 DOI 快捷路径跳过内容读取、复用不同 PDF；新增 [MOL-241](https://linear.app/molaison/issue/MOL-241)。 |
| 已有候选修复复审 | 检查 PR #17：工具 schema 示例被误判为媒体、项目聊天导航漏识别、租约发出后页面仍可用、schema 键顺序改变重放身份。分别补回 MOL-199/200/201，没有重复建票。 |

以上四个新票均关联原有 Zotero 接口与跨设备续聊总票 [MOL-40](https://linear.app/molaison/issue/MOL-40)。既有 Done 票的阶段边界和证据保留，没有重新打开或重写旧结论。

## 上游修复与行为

| Issue | 处理 |
| --- | --- |
| [MOL-194](https://linear.app/molaison/issue/MOL-194) | 通过真实 JSON/SSE Responses 入口验证 custom `exec`、bare `tool_search` 与同名 namespaced function 不串类；保留完整名称、参数及调用标识。 |
| [MOL-195](https://linear.app/molaison/issue/MOL-195) | 保留 PR #17 的 readiness 退出修复；真实未就绪 helper 子进程回归证明所有等待请求与重复 close 均可结束。 |
| [MOL-196](https://linear.app/molaison/issue/MOL-196) | namespace 选择器、工具清单和 MCP 专用/通用入口采用一致策略；无法保证的 required/forced 选择明确拒绝。独立复审追加 raw JavaScript 执行入口的限制，避免把可反射的 Proxy 冒充沙箱。 |
| [MOL-197](https://linear.app/molaison/issue/MOL-197) | 保留 PR #17 的 socket 清理与启动代际检查；真实 Unix socket 覆盖 idle、半帧、陈旧 socket 探测与 close 的竞态。 |
| [MOL-198](https://linear.app/molaison/issue/MOL-198) | 按观察到的 file ID 或 conversation+sandbox_path 区分产物，同时比较 MIME 与字节；同名不同产物、同来源变化内容均保留。签名变化不产生重复，重复来源保留可用下载地址。部分失败继续抛错。 |
| [MOL-199](https://linear.app/molaison/issue/MOL-199) | 只检查真实内容块的媒体能力；工具 schema 示例和 metadata 不再被当作输入媒体。真实不支持的音频及缺少可读取内容的图片仍明确拒绝。 |
| [MOL-200](https://linear.app/molaison/issue/MOL-200) | 支持项目聊天 URL；跨聊天导航清除上下文和 connector binding。租约已发出时关闭对应原生页面，并保留准确退出 ACK 所有权。Full/native 临时聊天即使没有保存 ID，也有明确的已保留状态。 |
| [MOL-201](https://linear.app/molaison/issue/MOL-201) | 分开逻辑请求身份、不可变执行契约和每轮工具契约；对象属性顺序等价，数组顺序保留。冲突在替换观察者或启动 runtime 前返回 409；真实工具发现后续轮次仍可扩展工具。 |
| [MOL-240](https://linear.app/molaison/issue/MOL-240) | 仅对明确的发送前错误代码保留安全重试，不把任意 HTTP 429 当成未发送。session 容量已满时返回 typed 429，并保留已有记录供精确重放。 |

### 复审实际改变了什么

修复后由新的代理审查，进一步发现并处理了：临时 native 会话没有 URL ID 时被当作首次建聊；同一下载地址不同字节被丢掉；签名更新形成重复文件；developer 指令变化没有进入不可变契约；raw exec 绕过受限工具策略。对应回归先复现旧行为，再验证修复。

MOL-200 的未知 ID 守卫限定于原票的 connector-bound Full/native 范围。对照测试只证明既有 connector-free QA 保存/恢复流程未被新守卫阻断，不证明所有 connector-free 导航模式已完整验收。原生页面关闭在测试中是受控 Electron 边界，不等同真实 ChatGPT 错误 Send 的现场证据。

## 验证

下游整合验证为 **224 passing / 0 failing**，主项目及 workflow 两套 TypeScript 检查均通过，详细命令和边界见 [下游记录](downstream.zh-CN.md)。上游验证记录如下：

| 验证组 | 结果与范围 |
| --- | --- |
| Launcher host 与导航回归 | **145 passing / 0 failing / 0 skipped**。包含项目聊天 URL、已发出租约的物理关闭、临时 native 无 ID、同聊天 reload 与 QA 升格对照。 |
| PR #13 组合验证 | **106 passing / 0 failing / 0 skipped**，11 个文件、543 次断言。独立工作树从 `2f4ddc1c025a9a548cfa32dcb63cce9dd8afdd96` 合并 `620d41e53e5ba856177d16cbe409ba4985983b73`，合并提交 `efb5bbb3e063f07b05b594a0a7d18339d70fa479`，无冲突。 |
| 首轮上游扩大回归 | 16 个文件共 **356 pass / 2 skip / 3 fail / 3 errors**。失败均在 MCP stdio harness，具体原因及补修后的结果见下文；没有隐藏这次失败或直接称为环境波动。 |
| 夹具补修后的同进程回归 | 在 `610162926c3a390c30848d090967d3672174331d` 上，整份 harness 加两个新增 contracts 文件 **141 passing / 0 failing**，942 次断言。实际顺序为 tool-contract-boundaries → harness → chatgpt-request-contract，未再出现未处理错误、连接关闭或残留子进程清理。 |
| 最终上游类型检查 | 最终源码 `610162926c3a390c30848d090967d3672174331d` 的 `bun node_modules/typescript/bin/tsc --noEmit` **退出 0**。执行器连接中断导致前一次检查结果不可恢复；连接恢复后重新执行，并保存独立退出码，未用空日志推断成功。 |

这些验证组存在重叠，不将测试数量简单相加。首轮两个 skip 分别为需要真实浏览器的下载测试，以及当前平台不适用的 Windows 路径测试。[验证输出摘录](verification.txt) 保留首轮失败和后续通过结果；[决策记录](decisions.tsv) 保留范围、判断与交付过程。

首轮三个失败项按原 timeout 定点运行得到 **3 passing / 0 failing**。进一步检查发现一个既有测试夹具在 `client.connect()` 前注册仅 3 秒有效的 token；整合失败日志显示该 token 在第一次 claim 前已被回收，随后 claim 为 `valid=false`，没有 queued invocation。夹具等待 `nextToolBatch()` 时没有同时观察 `callTool()` 早退。以上两点是直接证实的夹具缺陷；日志中的首项超时、Bun 清理残留子进程、后续拒绝和连接关闭支持清理级联的推断，但不据此声称已独立复现三个产品缺陷。PR #17 基线存在同一注册顺序。本分支将短期 token 注册移至连接建立后，并同步观察调用早退，保留原超时和产品断言。

可重复的新增测试入口：

```bash
bun test tests/paper-admission.test.ts tests/shutdown-readiness.test.ts tests/download-identity.test.ts
bun test tests/chatgpt-request-contract.test.ts tests/tool-contract-boundaries.test.ts
bun test tests/chatgpt-web-harness.test.ts \
  tests/chatgpt-request-contract.test.ts tests/tool-contract-boundaries.test.ts
ELECTRON_OVERRIDE_DIST_PATH=/tmp node --test \
  launcher/tests/browser-host.test.cjs \
  launcher/tests/browser-host-saved-recovery.test.cjs \
  launcher/tests/browser-conversation-invalidation.test.cjs
bun node_modules/typescript/bin/tsc --noEmit
```

PR #13 组合验证命令：

```bash
bun test tests/event-queue.test.ts tests/server-event-pressure.test.ts \
  tests/server-real-adapter-pressure.test.ts tests/server-physical-shutdown.test.ts \
  tests/turn-execution-retirement.test.ts tests/turn-broker-lifecycle.test.ts \
  tests/chatgpt-request-contract.test.ts tests/tool-contract-boundaries.test.ts \
  tests/paper-admission.test.ts tests/qa-pool-admission-observer.test.ts \
  tests/shutdown-readiness.test.ts
```

组合验证固定于上述两个源码 SHA；后续仅补齐了未进入运行路径的 shutdown 测试夹具类型字段，以及 MCP 测试夹具生命周期。PR #13 的背压实现和巨量证据历史没有复制到本增量分支。

`ELECTRON_OVERRIDE_DIST_PATH` 仅允许 Node 加载 Electron 包的路径入口；这些 host 测试使用受控原生 API 夹具，不会启动一个真实 Electron 浏览器。回归中的 runtime、dispatch、Send 计数属于实际生产模块与受控边界，不能写成真实模型调用数。

## 尚未满足的验收条件

- [MOL-187](https://linear.app/molaison/issue/MOL-187)：仍缺少来自已有完成会话、可追溯且脱敏的真实 Pro 子代理 DOM/任务身份样本。没有凭空设计 DOM 或上游事件；本轮没有任何 GPT-6 Pro、别名或隐式 fallback 的真实调用。
- [MOL-40](https://linear.app/molaison/issue/MOL-40)：真实 Zotero、指定 ChatGPT 项目、跨设备续聊和进程崩溃落盘耐久性未在本轮验证。下游状态机和协议修复不能替代这些验收。
- 本轮没有部署、合入默认分支、触碰共享运行服务或写入真实 Zotero 数据。新增代码与受控测试可供独立审查，未把待审 PR 的存在等同问题已完成真实验收。

## 对照资料

- [OpenAI Node SDK streaming 文档](https://github.com/openai/openai-node/blob/main/docs/streaming.md)：连接结束与成功终态需要分别判断。
- [OpenAI Node SDK Responses 流实现](https://github.com/openai/openai-node/blob/main/src/lib/responses/ResponseStream.ts)：对照终态与输出项合并边界。
- [OpenAI Node SDK issue #2571](https://github.com/openai/openai-node/issues/2571)：对照部分工具身份和完整调用之间的边界；本轮缺陷结论以本仓库实际模块复现为准。
