# 有界队列与物理退场：基线和候选证据

基线 main `2efe57f522f7e5e82af196256d2d360753f6c91c`。候选源代码提交 `ee43d5568725a78be0f8d9af8ae053dc07dbd6f0`，由两个独立提交组成：`360c8f4` 物理退出追踪、`ee43d55` 队列失败终态。它们与安装优化 PR12 分支分开，未部署共享服务。

所有网络请求都是真实 loopback HTTP，后端是受控 adapter/runtime；没有启动 ChatGPT 页面或真实模型。新模型物理提交为零。**这里不能作为真实 ChatGPT 或完整原生 CLI 验收。** `results.csv` 保留 17 行：两平台各 4 项基线、各 4 项候选，以及一个额外单忙线程压力场景。受控拒绝只表示失败处理正确，不算成功输出吞吐。

| 场景 | 基线观察 | 固定候选观察 |
|---|---|---|
| 同步 10001×256B，流式 | Linux/Windows 均在 10000 次 emit 后溢出；catch 再次入满队列，产生 1 次 unhandledRejection；最终 incomplete | 两平台均为唯一 response.failed、代码 adapter_event_backlog_exceeded、一个 DONE；0 次 unhandledRejection、0 completed |
| 同步 10001×256B，非流式 | 两平台 HTTP500、HTML 错误页、无 Responses 终态、Bun 进程 exit1 | 两平台 HTTP502 JSON，唯一 failed；0 次 unhandledRejection。候选 collect 先消费第一个事件，因此溢出可能发生在最终 done 入队；原始 emit 数不强行做相同解释 |
| 中断后延迟 physicalSettlement，再 drain | Linux health/drain 误报 active_browser=0，实际 retirement 仍 pending；Windows 首轮触及20秒 guard，未定位 | 两平台中断及 drain 时 active_browser=1，物理释放后为0；替换等待/信号停机等待另由针对性单元测试覆盖 |
| 慢读 256×32KiB | Linux 旧探针仅250ms暂停、完整 wire 收到，但未校验最终文本哈希；Windows 增强探针首轮20秒 guard，未定位 | 两平台真实暂停至少3秒，暂停期间 data 字节增量0；限速恢复后最终文本8388608字节，SHA256与全x预期一致，唯一completed/DONE |
| Windows 慢读 + 1个忙线程 | 本轮未做该压力基线 | 同样完整哈希和唯一completed；忙线程CPU约9.14秒，测试结束立即退出，未用满30秒上限 |

Windows 先前两次 guard 中止仍留在分母，不能用候选通过解释其原因；那两次无阶段日志。后续仅导入 config/server/state 的诊断约0.95秒正常退出，候选探针增加了阶段日志。候选各场景只跑一次，未盲试转绿。Linux 的慢读基线与增强候选暂停时长/哈希检查不同，因此不冒充严格等输入的性能 A/B。

## 环境、资源与清理

Linux 与 Windows 均使用既有 Bun1.4.0 / revision 34cbb9a40b4bd1bd767d134a7065e66c2432a676。Windows使用 main CI 安装包内完整6.1.10 runtime依赖；具体包/helper指纹在同仓库 PR12 的 `docs/evidence/runtime-install-20261017/cold-summary.json`。候选通过源码执行，不声称生成了新打包安装程序。`candidate-sources-sha256.txt` 绑定三个产品文件。

每个有限探针20秒外部停止线、512MiB进程RSS停止线，串行执行；只启动隔离端口与临时home。Linux候选四项监督器峰值约160/166/161/306MiB；Windows约157/151/144/328MiB。外部25ms采样可能漏过瞬时峰值，探针内另保存RSS曲线和阶段峰值，不能把某次采样当系统绝对峰值。HTTP客户端与服务端在同一探针进程，RSS包含解析和保存fixture的成本，不能据此称产品内存泄漏。Windows正常慢读内采样峰值约352MiB；单忙线程场景监督器约325MiB。

Windows保留原有tee生命周期实现：adapter完成后即使客户端仍暂停，active_http可能已归零。这里验证了完整性和有限资源范围，未证明所有慢客户端组合均有背压，也未认定存在泄漏。没有修改整机网络、认证、权限或共享服务。

通过场景均记录自己的清理完成和子进程退出。两次被guard终止的Windows基线遗留目录已按已知绝对路径验证位于任务TEMP后精确清理，任务runtime进程扫描为空。单忙线程由监督器在测试结束后立即终止，未使用GPU。

## 回归与审查

组合89项焦点测试、478条断言通过；另3项既有stall回归通过。作者较窄的65项、retirement30项验证与根线程组合验证分别保留，不相加冒充互不重复的覆盖数。最终TypeScript5.9.3检查通过。

两个非作者独立审查分别覆盖queue/server和retirement。审查发现的拒绝型同owner提前解除屏障问题已先红复现、再修为allSettled后统一报错，并确认关闭；当前生产index把worker拒绝归一化，因此未把该兼容边界称为线上复现。原clear断言保留，等待物理退出后才断言空闲。

测试覆盖异步正常长输出、同步溢出、观察回调抛错、已交付部分文本后的失败、容量保持、clear/native cancel、TTL、同owner替换、拒绝后等待其余helper，以及明确shutdown保持监听直到物理退出。没有把普通HTTP observer detach当取消。

## 文件与复现

原始结果 JSON、监督器 JSON（含RSS曲线）、stderr/TAP 文本和脚本逐项保留，文件清单及脱敏后SHA256在 `evidence-files.json`。仅对用户目录做占位替换；输入/终态/错误码/计数/采样未改。RSS曲线不是性能提升证据。

在隔离工作区，用已存在的依赖和Bun，依次运行 `queue-probe.ts count <out.json>`、`queue-probe.ts count-json <out.json>`、`retirement-probe.ts <out.json>`、`queue-probe.ts bytes <out.json>`，外层设置本报告的20秒/RSS停止线。脚本内部导入 `./src/*`，需放在仓库根；只允许本地fixture，fetchUpstream直接拒绝。Windows脚本另加阶段快照，监督器中的目录布局对应本次任务提取包，复现时应明确绑定自己的已校验runtime，不安装或复制认证。

本轮真实CLI证据另存既有任务证据目录：取消契约通过；两个内置provider interrupt设置失败；首轮实际adapter fixture的账户能力设置错误/保守资源阈值停止均未删。候选CLI有限对照尚在进行，未纳入上述HTTP通过结论。真实浏览器/真实ChatGPT预算此前已关闭，未重开。

## 后续阻塞（本证据批次之后）

PR13 的 Windows push CI39058704408/job117471974288 为1350通过、110跳过、10失败：8项生命周期活动数稳定多2，随后2项停机超时。正在诊断前序共享fixture物理清理，未删除断言或加时限。独审另指出真实createChatGptWebAdapter会包装queue.push异常，本批自定义adapter通过不能证明实际adapter错误分类。正在追加该真实adapter接缝回归。此批只绑定ee43d55，不能代表最终分支或全套通过。PR12已由父线程合并，main更新至fbabf15c49a4c11862b88eaf6268845c85808665；后续整合会明确绑定新main。

## 第二批追加证据

实际 createChatGptWebAdapter 的 writer-boundary 修复、有限真实 HTTP/CLI、Windows 原12项fixture前后对照及最终消费端门控测试，见 [real-path/README.zh-CN.md](real-path/README.zh-CN.md)。该批保留原始失败与中间结果，区分自定义adapter、实际adapter、实际HTTP与实际CLI；新模型提交仍为零。上文“后续阻塞”是第一批发布时状态，第二批说明 c6 Windows 的旧10项消失、首发同步假设和额外malformed超时等后续发现；不能将第一批候选矩阵当当前分支全套通过。


## Third evidence batch: exact cb12 controlled HTTP / native CLI / local Chrome

See [continued-validation-20261017/README.zh-CN.md](continued-validation-20261017/README.zh-CN.md). This batch preserves earlier failures and adds exact-source-bound native resume/reconnect/Interrupt/20-cycle evidence plus local real-Chrome checks. It is not current real-ChatGPT acceptance. No product code or model request is part of this publication.
