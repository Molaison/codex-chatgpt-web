# 实际 adapter、CLI 与 Windows fixture 追加证据

这是 PR13 的第二批证据。第一批上一级 `README.zh-CN.md` 和 `results.csv` 仍绑定其原候选 ee43d55，原始失败及未定位的 guard 中止均保留。此批不启动真实 ChatGPT 浏览器，不调用模型，新增模型物理提交为零，也不代表完整浏览器验收。

## 已证明与未证明

| 层次 | 实际结果 | 明确限制 |
|---|---|---|
| 生产 createChatGptWebAdapter + responseRequest，替换 worker.run | 红测证明 adapter 会把 writer 抛错包装为 observer detach；6b3270a 在 server 回调内先保存原始失败原因。最终消费门控 fixture 的 JSON/SSE 两例在 Linux、Windows 各通过28断言：正常首发完整完成，缓存回放明确 backlog、不可重试、唯一失败终态，worker/模拟 Send 均一次 | 进程内 handler，不是网络或浏览器；首发正常负控限定为消费端逐批确认，不保证同步首次突发也成功。原 Windows 红测另列下文 |
| 生产 startServer + createChatGptWebAdapter，真实 loopback HTTP，替换 worker.run | JSON 首次200/completed、完整10001字节及哈希；完全相同请求的缓存回放502/failed、adapter_event_backlog_exceeded、retryable=false；两请求 worker/模拟 Send 合计一次 | 真实 HTTP 仅3个 Responses请求。SSE 首次同步 feed 自己触发了安全超限，返回唯一 failed/DONE；探针断言失败并停在回放前。**实际 HTTP 的 SSE 回放未测**，没有补跑凑绿 |
| 真实 Codex 0.162.0 exec + 生产 server/adapter，替换 worker.run | 有限候选共2次实际 CLI、2个 HTTP、2个 worker/模拟 Send、0模型。最后一次 exec exit0，收到 OVERNIGHT_CANARY_1，约10.72秒 | 第一次监控脚本报错后中止，不能算通过；resume 已取消、未测。局部自测复现可选磁盘采样的 ENOENT 竞态并修监控，但未记录最初异常，不能断言同因。使用本地 custom provider/虚拟本地 key，不是内置 provider 安装或账户浏览器验收 |
| Windows 原生命周期污染的前后对照 | 同12项原断言：清理前2通过/10失败，修复 fixture 后12通过/64断言。仅释放前序 observeLiveness 中两个永不结算的 fake worker；等待其物理退出后再离开 fixture | 首次修复执行遇执行器连接中断，只留部分日志，不计完整通过；恢复后完整一次结果独立保留。没有改生产计数、关闭物理追踪、增加原测试超时或删除失败项 |

真正 HTTP 的 JSON 首次文本 SHA256 是 `6e54d64dcefa6e734070adc72c1e29a67b369cd0d0a6a588578139c2672479cd`。CLI 最后成功项的 proxy 峰值约205.54MiB，整个 CLI 子树约867.86MiB，未触及 proxy512MiB/子树2GiB停止线；子树包括 CLI 和监控临时进程，不能据此推断代理内存泄漏。先前基线自行采用较低的总树512MiB停止线，不能拿该停止与候选直接作性能结论。任务进程退出、四个测试端口关闭的证据分别保留。

## 版本与 Windows CI

生产 server 的 writer-boundary 修复提交为6b3270a，其内容 SHA256 `c5c75ddc3a83702309f5204d5e729bf55df6bf8423117ae69ad2239415178455`。真实 HTTP 在当时 HEAD f60bd77 加此未提交文件上执行，前后哈希冻结；6b3270a 后提交相同内容，不能只拿当时 HEAD 声称无脏改动。CLI 最后运行报告 HEAD f60bd77，8个运行源文件的事后哈希/mtime支持它仍是 ee43d55 产品代码，但**没有启动时哈希快照**，不声称事后观察是加载源码的密码学证明。

c599c21 仅修复 liveness fixture 清理；c6ab7bc 合入已由父线程合并的 main fbabf15。该组合94项焦点测试、517断言通过，TypeScript5.9.3检查通过。随后 Windows push CI39060022359/job117475879935 的旧10项生命周期/停机失败消失，但仍有1项新增真实 adapter 测试失败：首次同步10001 delta 在 Windows 先超过上限，测试假定首次必须 completed 不成立。同一提交 PR CI39060026776/job117475892798 则有2项失败：上述首发假设，以及 malformed stream 无保存终态测试在5586.34ms触原5000ms停止线。其相邻eof/cancel分支通过；该额外超时尚未归因，不能按单次通过或上次push未失败便删除。Linux/macOS/actionlint 通过，不能因此称全套绿。

保留失败后尝试仅调整正常首次 feed 的调度，所有内容/回放/错误分类/Send/终态断言不变：setImmediate 分批的 Linux 首版出现完成后通知竞态；Bun.sleep 加尾批同返的中间结果通过但改变了两变量，未作单因归因；随后只保留每100条 setImmediate、末101条同批 return，Linux2例/28断言和TS通过，文件哈希 `ab677ed96d5812e177b3d5bb2ae11da99ad59986462e57d1b43b4d44122f1f20`。**Windows 对此相同哈希实测仍为1通过/1失败：SSE首次明确超限**。原始失败及中间绿测均保留。

根因是 reader/pump 消费顺序不受 setImmediate 保证；bridge 初始 enqueue created 后按容量轮询，不能用循环让出次数推断已消费。最终仅对正常首发SSE采用真实 body reader 确认：解析 created 后开始，随后每100字符确认，再继续发下一批；末101字符与 authoritative return 同批。JSON恢复原同步feed；exact缓存回放不重新执行worker，因此仍是同步10001事件突发超限。最终文件 SHA256 `4673cf28f692265e20559422c8424128edac7bd85d14fdbba002acc9a5967a28`。Linux2例/28断言、TS各一次通过，Windows同哈希2例/28断言一次通过，外层exit0、无guard、RSS峰值251260928字节、own child退出。SSE日志实际解析10001字符、确认99批，首发notifications0、回放notifications1；所有原断言保留，无固定sleep或加超时。独审发现首发提前EOF后可能带未释放gate进入回放，已将全部原首发断言提前到回放之前，失败立即finally释放当前及后续gate；独审核对最终快照后关闭该项。此结果仍不补足实际HTTP SSE回放或任意慢消费者/完成-detach时序覆盖，亦未解释前述 malformed CI 超时。

## 文件、复现与边界

`raw-redacted-files.json` 记录原始与导出脱敏文件 SHA256。导出只替换用户目录及本地 Bearer 测试值，保留终态、错误码、断言、计数及资源曲线。`.tap.txt`/`.stderr.txt` 是原日志改扩展名，避免被仓库日志忽略规则漏收；原始私有 cases、临时 CODEX_HOME、认证及账户文件不导出。

`overnight-real-adapter-http-probe-original.ts`/监督器可在隔离仓库复现其有限 HTTP 场景；`overnight-cli-candidate-{last-,}fixture.ts` 记录当时实际 CLI 的本地 provider、限制和清理方式。复现会创建新的 CLI/HTTP 执行，本轮额度已用完，不据此自行追加执行。新单元 fixture 仅运行 `bun test tests/server-real-adapter-pressure.test.ts`，不产生模型调用；Windows 外层监督器绑定源文件哈希并保留512MiB进程/2GiB子树/60秒停止线，原单元超时未改。

真实浏览器/模型预算在此前24次上限关闭，未为本次后续修复重新开放。未重启共享服务、合并 PR13 或部署。


## Supplement after this batch

The untested HTTP SSE replay / native resume / real-browser gaps above describe this second batch. New exact-cb12 controlled validation is separately recorded in [the third batch](../continued-validation-20261017/README.zh-CN.md), including the initial shutdown telemetry limitation and its strict fresh-TCP follow-up. Original failures, aborts and source-binding limits above are unchanged. Actual ChatGPT coverage remains the older frozen round, not a new cb12 model run.
