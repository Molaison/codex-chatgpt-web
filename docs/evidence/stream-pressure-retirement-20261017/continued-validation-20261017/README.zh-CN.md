# 第三批：实际 HTTP、原生 CLI 与本地真实 Chrome 补验

本目录是 PR13 的追加证据，**已测试产品源码固定为 `cb12f370feb558002c7416ffe0087a9814e1b091`**。发布本目录不修改产品、测试或依赖文件，不触发新的模型请求，也不合并或部署。上两批原始失败、中止、未归因超时及其历史判定均保留，没有将后来通过的结果回写成首次全绿。

完整中文交接见 [本轮报告](overnight-continuation-final.zh-CN.md)，逐项输入、预期、结果、分母和未测项见 [cases.csv](overnight-continuation-cases.csv)。本批新增 **39 次受控 Responses HTTP、0 次真实模型提交**：独立 HTTP 2、原生 CLI 27、本地 Chrome 10。基线 main `fbabf15` 仅作为祖先和版本参照；本批没有新增同层基线实跑，不能据此称全面零回归。

## 三种覆盖必须分开读取

| 层次 | 精确版本及实际分母 | 结论与证据入口 |
|---|---|---|
| 实际 Codex CLI + 生产 server/adapter，只有 worker.run 替换 | 当前 cb12；准备执行2次，第一次在启动 CLI/HTTP 前失败；第二次24个实际 native 子进程、25个逻辑轮次、27次 Responses。20次清理循环全部保留 | 新建、同 home resume、已接受后两次部分 SSE EOF、真实 app-server Interrupt target/peer、20/20清理通过。[原始结果](cli/overnight-cli-completion-cb12-2-result.json)、[原生重连 stdout](cli/overnight-cli-completion-cb12-2-reconnect.jsonl)、[app-server 原协议](cli/overnight-cli-completion-cb12-2-app-server.jsonl)、[20行清理记录](cli/overnight-cli-completion-cb12-2-cycle-cleanup.csv)、[1123点资源曲线](cli/overnight-cli-completion-cb12-2-guard.json) |
| 本机真实 Chrome + 本地受控页面 + 生产 DOM 响应循环，准备/选模型/提交/绑定等为替身 | 当前 cb12；首次4项/107断言、6次Chrome启动、9次Responses；shutdown补强后只复验1项/17断言、1次Chrome、1次Responses，另外3项按名称过滤 | JSON/SSE正常首次及同步缓存过载、HTTP观察者退场后后台完成、真实child退出屏障成立；shutdown以单项严格证据补足。[首次观测](chrome/output/playwright/pr13-cb12-run1/observations.json)、[严格shutdown观测](chrome/output/playwright/pr13-cb12-run2/observations.json)、[首次guard](chrome/pr13-cb12-run1-guard.json)、[单项guard](chrome/pr13-cb12-run2-guard.json) |
| 实际 ChatGPT/浏览器/工具链路的历史回合 | **较早 d02a881 组合，不是 cb12**；保守模型额度24/24封账，观察到21次Send激活/接受，ChatGPT物理POST未独立抓取；本批没有追加调用 | 正式CLI的工具计数1→2、一次工具结果流终态丢失后恢复、历史续问曾通过；缺item ID的API入口两项实际失败等仍在该版本分母。[历史报告](historical-d02/REPORT.zh-CN.md)、[历史逐项记录](historical-d02/results.csv)、[保守预算](historical-d02/model-budget.json)、[历史问题](historical-d02/ISSUES.zh-CN.md)。其中“PR仍draft”等是当时快照，非本次状态；旧通过与失败都不自动转移为当前候选结论 |

另有不经过 CLI/Chrome 的实际 loopback SSE 对照：[JSON结果](http/overnight-real-adapter-http-sse-gated-cb12-1.json)、[独立核验](http/overnight-real-adapter-http-sse-gated-cb12-1-verification.json)、[冻结输入](http/overnight-real-adapter-http-sse-gated-cb12-1-manifest.json)。正常首次由实际 reader 的 created/delta 消费确认控制，收到10001字符完整回答和唯一completed/DONE；精确补读仍同步过载，唯一failed/DONE、backlog代码、不可重试，两请求只启动一次受控worker/Send。没有把合成字符relay说成真实模型逐token生成。

## 首次失败、修正和独立复核

1. **CLI准备失败保留**：[run1原日志](cli/overnight-cli-completion-cb12-1-harness.log.txt) 与 [诊断](cli/overnight-cli-completion-cb12-1-setup-diagnosis.json)。新home在Bun初始化自身缓存后不再空，suite的“目录必须不存在”检查先失败；CLI/HTTP/模型均0。改为外层在启动前创建任务所有权marker并绑定源SHA，仍拒绝任意既有home；不删除新目录保护。run2再执行并完成，见 [累计账本](cli/overnight-cli-completion-cb12-ledger.json)。更早的CLI监控中止与SSE首次假设失败仍在 [第二批](../real-path/README.zh-CN.md)，没有覆盖。
2. **Chrome准备阶段的红测保留**：[首次真实TS日志](chrome/attempt1-typecheck.stdout.txt)；后续类型修正与必要ambient声明加入后才通过。非作者在执行前要求断流后先证明 `active_http_turns=0/browser=1`，才允许改变DOM完成回答；[实际首次观测](chrome/output/playwright/pr13-cb12-run1/observations.json)记录该因果顺序。旧fixture和freeze均另名保留。
3. **首次shutdown代码断言绿、证据仍有限**：[首次独审](chrome/reviews/overnight-chrome-independent-review.md)保留原判定。原测试把任意health异常视为监听关闭，而最后TCP拒绝在fixture显式stop之后，不能独立证明生产shutdown自然关闭。补强仅将该检查改为fresh TCP，只有ECONNREFUSED可通过；CONNECTED继续等待、超时/其他错误失败。保留run1输入、原日志及其有限判定，然后只复验shutdown一次。[静态修正审阅](chrome/reviews/overnight-chrome-shutdown-fix-review.md)、[补充非作者实证复核](chrome/reviews/overnight-chrome-shutdown-supplemental-review.md)。不是产品修复，也没有删断言或增加原case超时。
4. 旧Windows基线guard中止、c6 CI红例和malformed-stream超时继续在 [第一批](../README.zh-CN.md) / [第二批](../real-path/README.zh-CN.md)。当前CI成功不能回溯解释旧超时，亦未据此将旧失败改成通过。

## 显式清理之前的端口证据

请读取 [run2 observations](chrome/output/playwright/pr13-cb12-run2/observations.json) 的以下顺序，而不是只看最终cleanup：

- child尚活，`exitObserved=false`；health为 `accepting_turns=false`、HTTP0/browser1，立即shutdown返回409。
- 真实Chrome child close并确认PID已不存在。
- `manualPhases` 中 **`shutdown-listener-refused-after-child-close-before-explicit-stop`**：fresh TCP 的 `refused=true`、`code=ECONNREFUSED`、child `alive=false/exitObserved=true`。
- 该专用note在 [运行fixture](chrome/scripts/pr13-local-chrome.fixture.test.ts.txt) 的 `try` 内，之后才进入 `finally -> f.close -> server.stop`；最终cleanupPort另记一次拒绝，两者不能混为一条证据。

[run2原日志](chrome/pr13-cb12-run2-owned/harness.log.txt) 为1pass/3filtered/0fail；[run2 guard](chrome/pr13-cb12-run2-guard.json)绑定255项前后输入SHA、exit0、无强杀/Job遗留。首次为245项；两个manifest和原fixture均保留。Windows Job在Bun主线程恢复前接管本任务子树，任务外进程不在其清理范围。CLI全部114个记录PID与两端口的结束检查见 [核验](cli/overnight-cli-completion-cb12-2-verification.json)。资源停止线为采样检查，不是硬内存/磁盘配额，也不证明永久无泄漏。

## 源码内容指纹与CI

[tested-source-binding.json](tested-source-binding.json) 保存103个src/package/lock文件SHA256及以下Git对象，供新文档提交独立复算：

- src tree：`4289bb9571aa5e7397d30aa8f28934c0847b1868`
- tests tree：`a793ff056cae4be68089399e117d9197bf891e45`
- 除本PR证据目录外，`git ls-tree -r` 条目的SHA256：`78bd00f5d8a1187bda4575be7c6dd7826e861841978f860018ac6909745d7878`（定义含排序/换行，见JSON）。

新发布commit应只增加本证据目录及其索引，且上述对象/指纹与已测cb12完全相等。整个Git tree会因文档增加而变化，不将其称为在新提交重新执行过整套验证。

已测cb12的 push CI [39061660121](https://github.com/Molaison/codex-chatgpt-web/actions/runs/39061660121) 与 PR CI [39061663512](https://github.com/Molaison/codex-chatgpt-web/actions/runs/39061663512) 均completed/success，证据为 [CI快照](overnight-final-ci-manifest.json)。它们属于cb12。发布后新文档commit的CI应另看对应commit检查，不自动继承旧绿色状态，也不为凑绿重跑失败。

## 脱敏、截图与复现范围

[redacted-files.json](redacted-files.json) 按文件列原始归档SHA、原始字节SHA、GitHub导出SHA及转换项。只替换用户目录/执行身份，以及任何字面token、capability或email；故障、终态、计数、受控identity、输入/输出哈希及资源采样不改。原archive内的SHA清单仍表示原字节；**验证GitHub文件请用导出SHA**。脚本路径占位符需在独立隔离环境显式映射；证据文件不授权任何新执行或模型请求。`.test.ts` 改为`.test.ts.txt`，`.log/.stderr`加`.txt`，防止证据被测试发现或忽略规则误处理。

导出保留原文件的Windows CRLF，以及历史CSV引用字段中回答的Markdown行尾双空格。默认 `git diff --check` 会把CR当尾空格；识别CRLF后剩余20处均在历史 `results.csv` 的观测字段。没有为了格式全绿而改写回答文本，见 [格式观察](format-observation.json)；这不是产品检查通过声明。

仅上传3张人工查看过的本地受控页面截图，醒目标注“Local fixture, not ChatGPT”：[断流前](chrome/output/playwright/pr13-cb12-run1/pr13-detach-prefix.png)、[后台完成](chrome/output/playwright/pr13-cb12-run1/pr13-detach-final.png)、[物理退出等待](chrome/output/playwright/pr13-cb12-run1/pr13-retirement-pending.png)。没有真实账户或私人信息截图，没有profile、cookie、认证、安装目录或浏览器/依赖二进制。

HTTP保留身份、正文哈希、终态及故障元数据，未记录完整HTTP双向字节；原生CLI stdout/stderr及app-server输出原协议保留，app-server stdin写入字节未另录。本批没有实际ChatGPT/helper登录、Send/选模型、工具ACK丢失、真实helper end握手/完成后滞留、OS信号投递、重启持久恢复或缺instruction ID新相同文本入口的最新版本实测；不作完整网站验收或零回归承诺。
