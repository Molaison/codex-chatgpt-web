# PR13 本地 Chrome 任务 fixture（待审核，未运行）

这是真实本地 Chrome 加受控页面，不是真实 ChatGPT、模型或完整 helper 验收。准备阶段只读元数据、编写任务文件和做静态语法转译；没有启动浏览器、测试、HTTP fixture、模型或安装。

候选源码：`cb12f370feb558002c7416ffe0087a9814e1b091`。任务脚本位于旁边候选目录的 `tests/pr13-local-chrome.fixture.test.ts`，生产源码未修改。`freeze.json` 绑定脚本、Chrome/Node/Bun 二进制、生产源码保守闭包、依赖 package 元数据及复用输入的 SHA-256。

所有生产模块均在新建 CODEX_HOME、CODEX_SQLITE_HOME、CODEX_CHATGPT_WEB_HOME、TMPDIR/TEMP/TMP 后才动态 import；其模块缓存只能绑定本任务新 home。该候选归档没有 launcher/electron 目录，清单明确标记其缺席，不声称使用完整 Launcher/helper。实际 fixture 使用的生产 src 全部冻结（含非必要源文件的保守超集）。

## 实际与替换边界

- 实际调用生产 `startServer`、`createChatGptWebAdapter`、journal、registry 和 `runBrowserTurn` DOM 快照/Markdown/健康/完成循环。
- 仅替换 `worker.run` 外部边界及准备页面、模型选择、提交、当前 assistant 绑定。使用既有 `qa-file-only-completion.test.ts` 的小接缝及 `chatgpt-dil-smoke.html`，不复刻完整站点。
- 队列场景先由真实 DOM 循环取得完整 10001 字符，再受控拆为字符事件。首发 SSE 由真实 HTTP reader 累计确认门控；生产缓存同步重放保持原样。这不是模型 token generation。
- detach 场景验证同一运行期 journal 可重连取得完整结果，不声称重启后的持久化。
- 关闭门控只控制开始关闭的时刻；物理完成必须等 `BrowserServer.process()` 的实际 `close` 事件。PID 存在仅作辅助证据。

## 四项与断言

1. 队列：JSON/SSE 首发完整成功；exact replay 为 JSON 502 或 SSE 唯一 failed，明确 backlog 代码且不可重试；每种模式一次 worker/模拟提交。
2. 正常 detach：真实 Stop DOM 下读取前缀；取消 HTTP 后 owner 未取消、PID 仍在；改尾部、移除 Stop 并完成后，重连取得完整答案，无第二次 worker。
3. 物理退役：取消后旧 Chrome 仍在，active_browser_turns 为 1；同 owner 新请求进入实际 adapter，但旧进程实际退出前不能启动第二个 Chrome；退出后替换成功，时间顺序被记录。
4. shutdown：只派发本 fixture 注册的处理函数；慢关闭期间监听/health 仍可用、shutdown 拒绝空闲声明；实际 child 退出后监听关闭。

只保存三张截图：detach 前缀/最终结果、退役 pending 页面。页面标题和 banner 都是 `Local fixture, not ChatGPT`。输出在候选 `output/playwright/`，运行时写 `screenshots-sha256.json`；未运行时不存在截图。

## 安全与资源

Windows 已安装 Chrome 155.0.8059.80、Playwright Core 1.62.0。`chromiumSandbox:true`，实际自有 child spawnargs 必须含 `--disable-gpu` 且不能含 `--no-sandbox`/`--disable-setuid-sandbox`。仅新临时 profile，不读/复制既有用户 profile、cookie 或登录状态。WS 和生产 fixture server 都绑定 127.0.0.1，所有页面网络请求 abort，背景网络/更新/sync 关闭，DNS 仅限本进程 fail-closed 配置。若 sandbox 启动失败，保留失败，不改安全设置。

串行、同一时刻最多一个自有 Chrome；替换启动前额外拒绝重叠进程。每例 30 秒、suite 外层 180 秒；由 root 的既有 supervisor 执行 proxy 512 MiB、tree 2 GiB、disk 2 GiB 停止线。脚本不创建另一套 supervisor，也不修改生产 source、服务或认证。模型提交为 0，不使用会隐式安装的 npx wrapper。

## root 放行后的命令（此阶段未执行）

```powershell
$taskRoot = '<WIN_WORKSPACE>\.codex-tasks\20261017-windows-ci-crash'
$env:CHATGPT_DOM_TEST_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:PR13_CHROME_FIXTURE_RUN = 'authorized'
# 每次用新的输出目录，保留上次的失败与证据。
$env:PR13_CHROME_FIXTURE_OUTPUT = "$taskRoot\overnight-source-candidate\output\playwright\pr13-local-chrome-reviewed-1"
Set-Location "$taskRoot\overnight-source-candidate"
& "$taskRoot\overnight-current-runtime\runtime\bun.exe" test tests/pr13-local-chrome.fixture.test.ts --timeout 30000
```

执行前先核对 `freeze.json` 的脚本/源码/二进制哈希。该命令必须在 root 完成串行 CLI 并明确放行后，由既有资源 supervisor 包裹；不能直接宣称四项通过。全套类型检查尚未运行；已有静态语法转译只证明可解析，不代替测试或 typecheck。
