# QA 与 papers 源码整合

2026-10-05 源码交付完成，未部署。基线为 main `f79e5fc3510a04aaf653459d5203b822e06be2ef`，
分支为 `feat/qa-persistence-papers-integration`。下一步由总体集成 owner 决定合并与部署，不能直接覆盖现役数据或配置。

## 已整合

| 范围 | 实现与边界 |
|---|---|
| QA 提示词与上传 | 按原生 content kinds 过滤运行时内容，保留用户文件和图片；当前 composer 附件选择；大 PDF 等待 300 秒、阶段 360 秒 |
| 持久会话与账号 | 固定账号/thread 身份、原生保存映射、previous-response 别名、增量续聊、分叉、取消及并发合同 |
| 项目与临时模式 | 可信项目路由与独立 namespace；原生 Temporary Chat、私有 48 小时历史、保存后加入项目；持久聊天不倒退 |
| papers | 原 SQLite 登记、DOI/SHA 别名、预留 token、ready 后不重传 PDF、uncertain 拒绝自动重放、明确发送前失败可恢复 |
| 下载 | 文件和图片归档、原生形状链接、过期重新下载；main 的 MCP 精确 ingress 路由不变 |
| 构建与文档 | runtime 包增加 QA pool 和部署示例、QA 文档；main 的下载网关继续构建；四语言 README 区分 QA 与 Full |

24 个运行时依赖文件与旧 mixed 工作树的本次源快照逐字一致，列表见 `dist/qa-integration/07_source-coverage.log`。
来源是 `/home/zzp/codex-chatgpt-web-molaison` 的选定文件，不是整树复制。
已对照现役项目/临时模式和 papers 大 PDF 任务记录；本次不重新执行其线上模型验收。

## 冲突决定

1. `scripts/build-runtime-bundle.ts`：合并 QA pool 与 download gateway 构建，保留 main 的其余构建、依赖锁定与 manifest 逻辑。
2. `tests/composer-insert.test.ts`：保留 main 已拆分的跨平台测试 deadline，未缩短或放宽。
3. `tests/dev-chat.test.ts`：保留 main 的显式注入工具 adapter 测试，不用旧 QA-only 断言覆盖。
4. `tests/server-compaction.test.ts`：保留 main 对 external-http Full 的两处工具能力断言。
5. `tests/qa-download-gateway.test.ts`：保留 main 的精确 MCP ingress 测试。真实文件存储/HTTP 合同由导入的 `qa-downloads.test.ts` 覆盖。
6. main 的 MCP、provider 鉴权、严格 `-tools`、inventory 解析、管理员部署脚本未替换。`qa-pool-catalog.patch` 保留供旧源码使用，新源码已含实现，文档不再要求重复应用。

新增断言验证 pool 发布原 QA 元数据且拒收 `standard-tools`，拒收前不会转发后端。

## 实际验证

| 验证 | 结果 |
|---|---|
| 定向 Bun 测试，30 文件 | 407 通过，28 跳过，0 失败，2885 断言，39.81 秒 |
| QA pool 新增目录/工具边界后重跑 | 原 4 项通过，47 断言；不是新增 4 个样本 |
| Node launcher 生命周期 | 6 项通过，无真实 Electron 窗口或浏览器 |
| Node 本地化合同 | 10 项通过，包含四语言 README 链接/命令一致性 |
| TypeScript | `tsc --noEmit` exit 0 |
| Runtime bundle | `bun run build` exit 0，Bun 1.4.0，app 6.1.3 |

28 项跳过均要求 `CHATGPT_DOM_TEST_BROWSER`。本轮未连接或修改浏览器，未发模型、语音请求，
未运行线上验证脚本，未修改服务、CPR、用户配置或生产数据库。没有运行完整无关测试套件。

首次构建缺少 launcher `motion` 依赖；首次 launcher 生命周期测试缺少 `electron`。
复用旧树已有 `launcher/node_modules` 后两者通过，没有安装新的构建环境。
根与 launcher 的临时依赖链接、临时测试目录已经移除，旧树依赖未写入。
首次脚本把 Git worktree 的 `.git` 当目录，写入前失败；随后仅在本树 `dist/qa-integration` 保存日志。
初次三方合并在两处冲突时提前结束，已从未处理文件继续，没有重复覆盖已合并内容。

原始输出与失败证据保留在本工作树 `dist/qa-integration/`，状态为 `status.txt`。
构建成品在 `dist/runtime/`，bundle ID 为
`b2dd7f866448d802cb6e6861e591e08b5245173eaca7f34162e9539a1f0b7812`。
manifest 已包含 CLI、browser helper、QA pool、download gateway、QA 示例及部署文档。
这些生成物不提交 Git；源码与下列命令构成重建入口。

## 重建和定向测试

需要 Bun 1.4.0 和 Node 22。全新机器先按仓库流程安装根目录和 launcher 的锁定依赖。
本次 ywl 使用既有 Bun：

```bash
export PATH="/home/zzp/.local/lib/codex-chatgpt-web/molaison-estuary-20261001/runtime/runtime:$PATH"
# 已有、只读复用的依赖。只在链接不存在时执行，不对旧树运行 install。
ln -s /home/zzp/codex-chatgpt-web-molaison/node_modules node_modules
ln -s /home/zzp/codex-chatgpt-web-molaison/launcher/node_modules launcher/node_modules
mkdir -p .t dist/qa-integration/home dist/qa-integration/cache
export TMPDIR="$PWD/.t" CODEX_CHATGPT_WEB_HOME="$PWD/dist/qa-integration/home"
export BUN_INSTALL_CACHE_DIR="$PWD/dist/qa-integration/cache"
unset CHATGPT_DOM_TEST_BROWSER
bun test tests/qa-*.test.ts tests/paper-registry.test.ts tests/question-answer-bridge.test.ts \
  tests/external-http-full-harness.test.ts tests/cpr-provider.test.ts tests/mcp-http.test.ts \
  tests/mcp-http-broker.test.ts tests/chatgpt-web-harness.test.ts tests/prompt-contract.test.ts \
  tests/zero-risk-prompt-contract.test.ts tests/server-compaction.test.ts tests/runtime-layout.test.ts \
  tests/responses-text-controls.test.ts tests/retained-compaction.test.ts tests/skill-attachments.test.ts \
  tests/browser-response-dom.test.ts tests/composer-insert.test.ts
node --test launcher/tests/browser-host-saved-recovery.test.cjs launcher/tests/localization.test.cjs
bun node_modules/typescript/bin/tsc --noEmit
bun run build
```

## 未纳入与未验证

- 旧树的 `scripts/verify-cpr-qa-dom.ts` 与四个 `scripts/verify-qa-*-live.ts` 是部署专用线上驱动，未整合也未执行。
- 旧 `docs/qa-validation-2026-09-28.md`、`docs/qa-durable-validation-2026-09-28.md` 及 QA 文档内历史运行流水未复制为本次验收。旧源完整保留。
- `src/qa-pool.ts.before-papers` 是备份，不是现役实现，不纳入。
- 旧部署脚本和重复 Full 修改不覆盖 main 的现有版本。已核对的 24 个 QA 运行时文件没有未整合差异；这不是对仓库外所有现役定制的审计。
- Zotero 客户端安装包、Codex 动态模型目录、CPR 修复、部署与用户数据迁移属于其他 owner，不在本提交内。
- 未验收 Windows/macOS 构建、真实浏览器 UI、生产重新部署后的业务请求或长期并发稳定性。

提交时仓库未配置 Git 作者身份，首次 commit 在写入前失败。最终提交仅通过命令行 `git -c`
复用现有源码提交 `72c4615` 的作者名和邮箱，未修改全局或仓库用户配置。
