# 第二轮修复的独立复放证据

这些脚本保存本轮独立审查的可执行断言。它们从指定的本地工作树导入实际产品模块，不复制产品逻辑，也不启动服务。

## 固定候选与本次结果

本次整合复放使用 Bun `1.4.0 (34cbb9a40)`，日期为 2026-10-21。

| 代码范围 | 本次整合复放 HEAD |
| --- | --- |
| `codex-chatgpt-web` | `233a38f90f0575df0a4feeb2a547e692148a3d34` |
| `llm-for-zotero-papers` | `a257c7dc6e79a4b81c0a605989365de58978c3eb` |

原始独立审查候选为：上游 PDF 身份修复 `d16f0c62d8566ef583a84034d3468fd2688c18b6`、上游终态修复 `4637adf1d9493735e1d8bb304eef8650928c816f`、下游 PDF 身份修复 `cb1ec6a9da2722b0dac575a4ca5fcb52a1117463`。上表记录的是本目录脚本实际重跑的整合提交，不把原始候选的测试结果冒充整合结果。

| 脚本 | 本次结果 | 原始输出 |
| --- | --- | --- |
| `paper-joint-replay.ts` | 13 项场景检查通过；9 次受控 backend 调用；仅 1 次 fixture PDF 传入 backend | `paper-joint-replay.result.json` |
| `paper-terminal-counterexamples.test.ts` | 6 pass / 0 fail；713 assertions；包含 170 个字节切分位置 | `paper-terminal-counterexamples.result.txt` |
| `smoke-guard-replay.ts` | 20 组允许请求的额外字段变体仍解析为非 Pro，10 组拒绝请求零转发，未知 previous response 返回 409 | `smoke-guard-replay-result.json` |

模型限制复放固定在候选 `93ba34b61e5163f398aeaa010788621cb4a559d5`，原始 JSON 还记录实际读取的六个 source 文件 SHA256。它经过实际 `responseRequest`：21 次 handler 请求中，20 次到达受控 adapter，剩余一次以未知 continuation 拒绝；真实模型和网络调用均为零。

## 复放命令

准备好两个本地 Git 工作树及其所需依赖，把下面两个路径换成实际根目录；脚本不会下载代码或安装依赖。若要精确复放上述证据，工作树应位于上表提交。若使用后续提交，输出会记录实际 HEAD，结果仅证明该次传入代码。

在本 README 所在目录执行：

```sh
export PAPER_AUDIT_UPSTREAM_ROOT=/path/to/codex-chatgpt-web
export PAPER_AUDIT_DOWNSTREAM_ROOT=/path/to/llm-for-zotero-papers

bun paper-joint-replay.ts
bun test paper-terminal-counterexamples.test.ts

export SMOKE_AUDIT_UPSTREAM_ROOT=/path/to/codex-chatgpt-web
bun smoke-guard-replay.ts
```

`paper-terminal-counterexamples.test.ts` 只需要上游环境变量。未设置必要路径时，脚本直接报错。各脚本必须作为独立 Bun 进程运行；终态测试不要启用 `--concurrent`，因为受控 fetch 边界在单进程内依次安装和恢复。逐字节测试有 30 秒总时限；单次响应的 1 秒时限用于识别等待 EOF 或 cancel 挂起，不是性能基准。

模型限制复放使用单独的 `SMOKE_AUDIT_UPSTREAM_ROOT`，同样单独运行。它在临时目录隔离 bridge 配置，并将实际 guard 转发接入生产 `responseRequest` 和受控 adapter；仅允许一个合成 loopback URL，未打开 HTTP listener。请求中的 Pro 标记和别名仅是被检查的测试数据，不会联系模型服务。

该修复的独立复审结论、采纳的反例和固定版本的官方 V1 schema 来源见 [smoke-guard-review.md](smoke-guard-review.md)。

## 实际覆盖的断言

联合复放连接下游 `prepareCprPaperRequest` 与上游 `createQaPool().fetch`，使用真实 registry、会话映射持久化与 SQLite。它检查首次带 PDF 的请求、独立 Prefs 实例模拟的新设备重复访问、同路径替换文件、显式选择不同附件、没有附件或本地路径、DOI 与 SHA256 别名、绕过 resolve 的直接 chat、没有可信旧 hash 的 legacy DOI，以及 pool 重启后仍沿用同一会话。断言同时核对请求中的文件数量、hash、线程身份、registry 状态和受控 backend 调用次数。

终态复放检查以下六组行为：

1. 已经排队且通过映射验证的 completed 与观察者取消竞争时，可正常保存 ready。
2. 缺少 ID 的 JSON completed 保持 uncertain，后续 chat 返回 409，不能再次转发。
3. JSON completed 缺少保存的会话映射时，不能进入 ready。
4. SSE completed 缺少保存的会话映射时，不能进入 ready。
5. 对包含中文和 emoji 的前缀及 completed，在终态前每个字节位置切分两段；冲突终态和坏 JSON 同处第二段时，输出仍精确截止到首个终态。
6. 第一轮 cancel 延迟拒绝时，第二轮 owner 仍为 pending，重叠 chat 被 `paper_busy` 拒绝，第二轮自身完成后正常 ready。

## 受控边界和现有差异

所有脚本在导入产品模块之前，把全局 fetch 设置为拒绝调用；fixture 随后只允许明确的模拟 backend URL，所有其它 URL 均断言失败，不委托给真实 fetch。下游到 pool 的调用直接使用 `pool.fetch`，没有 HTTP listener。Zotero 接口是内存对象，Prefs 仅写入 Map；PDF 是字符串生成的合成字节，不读取真实论文。SQLite、密钥和 conversation store 只在新建临时目录中创建并在退出时删除。真实模型调用、ChatGPT Send、网络 PDF 上传和 Zotero 写入均为零。

这些证据证明上述模块与受控边界间的行为，不能代替真实浏览器、真实 TCP 断连或真实模型服务的验收。

本轮保留已有的 JSON / SSE 错误呈现差异：缺 ID 的 JSON completed 原样以 HTTP 200 返回，但 registry 保持 uncertain；相同形状的 SSE completed 则导致流消费失败。这里没有扩大产品修复范围，也没有把 HTTP 200 当作 registry 成功。
