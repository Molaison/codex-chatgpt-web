# Codex ChatGPT Web 实测与上游整合结果

本轮不能判为全面验收：正式 CLI 的三项组合场景通过，QA CPR provider 的缺指令 ID 调用仍有两项真实失败；多项 CLI 边缘路径未在额度内覆盖。

## 真实 CLI 已通过

使用本机已登录身份，未复制认证文件、未执行登录或切换认证。当前真实 Codex CLI 0.162.0，经项目正式内置 openai provider 与仅本次 openai_base_url 覆盖，进入精确候选 source/runtime/helper。严格唯一模型 GPT-6 Sol Instant，Pro 能力关闭；没有 Astra/6Pro。

1. 新建：真实执行一次专属计数文件命令，文件从不存在变为1；CLI 收到 stdout、最终回答并退出0。
2. exec resume：同一会话重复完全相同的新指令，文件只变为2。主动在真实工具结果的输出 delta 后、完成信号前断开本任务连接，CLI 显示 Reconnecting 1/5 后恢复并退出0；没有再次执行工具、没有额外 Send。
3. 再 resume 改口、收紧为只读并禁止工具：回答 COUNTERS 1,2; CURRENT 2，未调用工具，文件保持2，退出0。

工具后的模型续跑与有变化的重连请求均保守占用额度，硬账本24/24。21次 Send 激活/接受不能代替模型续跑预算；ChatGPT 物理 POST 总数未独立抓取，不能写成已独立证明的物理计数。全过程串行。真实调用已停止，所有自启测试服务已关闭；现有四个 QA/Full 服务仍为6.1.8且健康。

## 后端／浏览器集成证据（不是 CLI 验收）

固定 main 的真实新建非流式与续聊流式，以及候选对应路径都通过。候选精确重试不新增 Send；缺 ID 歧义在直连 pool 被拒，原请求仍重放，不同稳定指令 ID 的相同文本各执行一次。

真实读流中断后，后台完整保存。部分输出场景断开时收到5085字符、尚无后缀和终态，重连取回5100字符，逐字保留前缀、补齐后缀、一个明确完成事件，没有新增 Send，随后追问仍保留合成标记。另两次第一增量已含全文，只作为终态丢失恢复，不冒称部分输出恢复。

LIVE-02/03：真实浏览器生成历史后，仅对本任务 SQLite 注入过期时间；同一 pool 首次/重复续接、仅重启本任务实例后的首次/重复续接均409 temporary_history_expired，新增Send为0，内容清除而标记保留。不是自然等待48小时，也不是 CLI resume 测试。

LIVE-04：新独立线程正常回答UNKNOWN，没有旧标记。LIVE-05：未过期 temporary 升级 persistent，完成后临时标记和内容清理，下一问仍正确续聊。LIVE-06仅覆盖有权威未提交证明的升级拒绝、保留历史标记；未覆盖不确定的 post-Send 失败升级。

真实 pre-admission draining 仅作用于本任务 runtime，返回全部明确 not_submitted/admission 证明，pool 释放 pending，零Send；恢复后原请求可安全重试，下一问上下文正常。旧头历史分支被明确拒绝且零Send；实际 Web 编辑、分支改写/同步未验收。

## 实测失败与归属

两项 QA CPR provider 缺调用方 item id 失败见 ISSUES.zh-CN.md：原生元数据保留、合法未压缩输入，候选官方provider本身完成正常化。A精确重试因HTTP传输号变化而409 request_identity_conflict；B新逻辑请求相同文本被200静默复用旧执行。它们没有经过后来出错的CLI观察代理，不是zstd夹具错误。适用范围为省略 item id 的API调用方，不是已保留ID的正式CLI。共享Rust CPR网关未改动/未验收。

零模型复核又证明：保留逐条归属字段，以及identity/gzip/zstd编解码，不改变该正常化缺陷；提供稳定item id的正向对照正常。上游整合后的相关五个生产文件哈希完全未变，原样十一场景仍8通过/3已知缺ID失败。

初期 custom/API-key provider 的CLI拒绝，以及观察代理漏处理zstd/保留内置provider配置项，是已定位并修正的入口/夹具错误。不得把它们误报为正式CLI共同产品缺陷。完整记录保留，正式CLI后来已真实通过。

## 固定版本与现有服务

main基线3be25ae；PR6 head2e1d3e3；PR7 headf1fde6f。两PR仍draft未合并，CI刷新仍PR6失败、PR7成功。本轮组合自动合并无冲突，冻结为 d02a881，tree d5162b3；没有把单个旧部署称为当前两PR验收。

ywl实际为<YWL_USER>，Rocky Linux8.10，Bun1.4.0；实际宿主 Chrome146.0.7680.216 / Electron41.10.7 / CodexWebGPT6.1.3。系统单独安装的Chrome149不是实际宿主。生产bundle6.1.8没有sourceCommit字段，部署SHA不可独立追溯，已保留bundleId/manifest摘要；候选源文件和helper构建有精确哈希。

初始离线127测试使用现有源依赖SDK1.30，不能充当冻结依赖验收。真实运行使用现有已安装SDK1.32.1，锁与目标bun.lock一致；没有安装软件。初始离线对照、默认AF_UNIX合成上游测试、所有已知红例保留，均不冒称真实模型/CLI结果。AF_UNIX旧包测试包含合成兄弟请求，本轮未以其证明真实并发能力。

## 上游已整合但未真实验收

支持的API输入边界与错误可操作性复核另见issue-applicability-review.json；正式CLI没有复现这两个身份失败。

GitHub parent/source确认上游 miuuyy/codex-chatgpt-web，最新8645a89（6.1.10，7项新增提交）。保留原候选与main后，在单独 integration/upstream-20261017 工作树整合，提交6459328，tree1880f43。唯一冲突是environment.ts两个不同用途的import，同时保留；没有整文件覆盖本地补丁。

新提交受影响回归280通过、14原有跳过、0失败；类型检查、版本检查、launcher tunnel检查、手动CLI/helper/pool构建通过。原样十一诊断8通过/3失败，未改断言或藏失败。没有运行会安装依赖的完整发布打包。该提交未推送、未合入远端main或PR、未部署。因预算耗尽，真实CLI和浏览器结果只属于原冻结候选，不能自动转移到新提交。

## 仍未验证

CLI旧/过期会话resume、仅重启pool后CLI续问、连续两次读流中断、CLI steer/rewind/fork、取消进行中工具后的恢复、真实broker ACK丢失、真实CDP/snapshot故障、真实adapter EOF、广泛跨客户端/账户/Web分支同步，均不作通过结论。普通工具和一次工具结果终态丢失不等于broker ACK丢失。Full真实链路复用现有6.1.8外部broker，未将该broker说成已部署PR7。

逐项输入/预期/结果/错误/Send边界/现实类别在results.csv，完整可重建哈希在manifest.json。导出移除了账号安装标识、实际线程UUID及潜在敏感日志行；原始自生成证据在任务私有目录保留。Linear建票由主线程协调，本执行器提供最小复现，未擅自创建重复票。
