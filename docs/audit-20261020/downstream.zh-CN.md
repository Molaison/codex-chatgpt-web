# 论文上传与 Responses 终态增量修复

`papers/*` 路径的后续内容校验及实际上下游接线证据见 [2026-10-21 第二轮补修](followup-20261021.zh-CN.md)。本文记录第一轮直接 Web 账本及 Responses 消费者修复。

基线：`codex/papers@0b9e0774f4e675963c6fd77a1dd5b4844fc10e1d`。本轮与上游 `Molaison/codex-chatgpt-web` 联合开展五路增量审查，新增问题去重写入 Linear，并由不同实施与审查代理检查最终行为。

交付：[PR #9](https://github.com/Molaison/llm-for-zotero-papers/pull/9)，发布提交 `7f30576336f57198ed0d9b6571ce503f791d42a0`。本地测试提交为 `013c1b8eb88d135dca9db238bfa35db25ba41ffb`，逐文件 blob 与完整 tree `a620e5da1a3e1f4fc944b7ac2af7fd519d13c734` 已核对一致。GitHub API 生成新的提交身份，代码内容没有变化。

## 修复内容

### MOL-238：上传认领与取消的所有权

[MOL-238](https://linear.app/molaison/issue/MOL-238) 的原始复现通过实际 `prepareCprDirectRequest` 和 `callLLMStream` 路径进行：两个并发请求可以在异步文件读取前取得同一旧账本，随后都生成上传 payload；结算只按 paperId 匹配，旧回调还可能覆盖新请求的认领。本地读取期间取消也会错误进入 uncertain。

修复在异步读取、哈希完成后同步重新读取和检查账本，并将当前 turnId 作为 pending owner。从最终检查到写入认领之间没有 await。每个结算和释放操作都检查 owner，因此不同 PDF 准备可并行，同一个 PDF 最多一个请求取得上传权，迟到回调不能处理别人的认领。

准备和已分发是不同状态。获取 fetch、解析地址、序列化请求、再次检查取消信号后，才进入分发边界。本地取消释放自己尚未发送的认领；进入 fetch 后的失败继续保守标为 uncertain，不自动重传。历史没有 owner 的 pending 继续保守处理，不在升级时擅自恢复上传。

### MOL-241：DOI 复用前验证实际 PDF 内容

[MOL-241](https://linear.app/molaison/issue/MOL-241) 的原始 ready 和同请求去重快捷路径没有读取当前选中的 PDF。替换同 DOI 附件后，可能继续引用之前的论文。

所有选中的 PDF 现在先读取并计算哈希，然后判断 ready、pending、uncertain 或同请求去重。同 DOI 不同内容在发送前明确拒绝，不静默复用或重传。最终同步重验也覆盖初次检查时已经判为复用的身份，避免读取期间被另一请求替换。

这项正确性保证需要对复用文件重新读取和哈希；没有引入仅凭 mtime 的未经验证快捷路径。认领保证针对当前共享 JavaScript 执行域与同步 Zotero.Prefs API，不宣称新增跨进程分布式锁。

### MOL-239：完成终态决定工具和最终文本

[MOL-239](https://linear.app/molaison/issue/MOL-239) 的初始 15 个实际 parser/adapter 回归在旧实现全部失败。修复包括：

- EOF、failed、error 不再产生成功结果或可执行工具；incomplete 保持恢复状态，不能执行半成品调用。
- 收到终态立即结束读取；reader cancel 拒绝或持续 pending 不会覆盖、阻塞已确定结果。
- 消费者回调异常正常传播，不再被当作坏 JSON 吞掉。
- 最终工具参数覆盖流式占位参数；非法 JSON 和非对象工具参数明确拒绝。
- 文本按 output item 和 content part 累积，多个片段不会互相压制，重复快照不重复追加。
- 显式终态状态优先于残留的 incomplete reason；明确的空最终文本保持为空。

独立复审继续发现：同一 call_id 更换或省略 item id 会同时恢复新旧参数；最终 `output: []` 已移除的 done 工具也被追加。补修后，存在最终 output 数组时，该数组决定完整输出成员。id/call_id 只用于补回匹配项缺省的流式元数据，不能恢复已删除项。重复或冲突调用标识在进入 runtime 前拒绝。没有 output 数组的兼容终态仍可采用已 done 的流式项。

另两处 UI 消费入口曾把最终空文本回退为流式草稿。现共用 `resolveDirectChatResponseText`，完成态的最终文本包括空值都具有权威性。保留 document/planDocument 的显式输出分支和未完成流的证据文本；空结果使用既有提示。

## 验证

整合后的相关测试 **224 passing，0 failing**：

```bash
node --import tsx node_modules/mocha/bin/mocha.js --require ./test/register.cjs \
  test/cprDirectWeb.test.ts test/cprPapersRegistry.test.ts test/cprPapersConfig.test.ts \
  test/providerSessionId.test.ts test/responsesFinality.test.ts \
  test/directChatCompletion.test.ts test/codexResponsesAgentAdapter.test.ts \
  test/chatStreamingResponseWiring.test.ts test/llmClient*.test.ts \
  test/cprRichWidgets.test.ts test/providerRequestContract.test.ts \
  test/agentAdapterUsageReporting.test.ts test/codexDirectCatalogAuth.test.ts \
  --timeout 5000
```

扩大回归曾发现一项基线既有的 Codex 401 测试失败。独立确认原因是过时测试配置：只设置旧 migrationVersion，默认 provider 被公开 CPR 初始化替换，测试根本没有进入 Codex auth。该 fixture 现显式选择当前 Codex transport、初始化模型 catalog，并使用带成功终态的 stream。额外断言旧 token 收到 401 后仅重试一次且使用新 token；生产认证路由未为通过测试而改变。

最终整合源码的 `npm run typecheck` 已退出 0，顺序完成 `tsc --noEmit` 和 `tsc --noEmit -p tsconfig.workflow.json`。实施和复审已通过相关 lint、格式、架构与导入循环检查；架构检查的既有 type-only warnings 和 migration obligations 不作为本轮新增缺陷。

## 验收边界

所有测试使用实际生产模块，控制文件读取、偏好存储、fetch/stream 等外部边界。本轮没有真实模型调用、真实 PDF 上传或 Zotero 数据写入，没有使用 GPT-6 Pro 或隐式 fallback。

[MOL-40](https://linear.app/molaison/issue/MOL-40) 的真实指定项目、跨设备续聊及崩溃落盘验证仍未完成；不能用本轮状态机和协议测试替代这些条件。对应上游容量拒绝修复是 [MOL-240](https://linear.app/molaison/issue/MOL-240)，上游增量分支承接已有 PR #17；本下游 PR 不改动另一个已存在的 library-drop PR #8。

使用了 pstack `poteto-mode` 的分阶段协作、行为验证和独立复审原则。全局安装被当前环境禁止写入 `/root/.codex` 的自动审批规则拒绝；本轮应用下载的原始指令，没有声称完成持久安装或不可用的跨模型审阅。
