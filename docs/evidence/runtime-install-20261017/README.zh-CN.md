# Windows 同包安装函数对照（2026-10-17）

这里保留两类各 10 个原始交错样本、完整扫描计数、实际测量脚本与提交/包指纹。没有删除样本，也没有把缓存命中计入首次安装组。

基线：`2efe57f522f7e5e82af196256d2d360753f6c91c`，runtime-install Git blob `f516eace38b9d81bd351f2097b69857d186c2019`。候选：`bfdfb40e10dca24fa685e9ba0288ac6d21671dad`，blob `a180d477b757ff62796a7c69f7bcb9b7eb201451`。`measurement-manifest.json` 同时记录实际脚本/源码副本 SHA256。基线经 PowerShell 传输增加 BOM/CRLF；去除 BOM 并规范换行为 LF 后的 SHA256 已与对应 Git 提交内容独立比对一致，候选原字节一致。

环境：Windows x64、Node 22.15.0、28 逻辑 CPU、约 32 GiB 内存。输入为 main CI 39039850505 的 artifact 12103444248 内安装包，runtime 6.1.10、Bun 1.4.0、Playwright 1.62.0，6041 个清单文件、172098308 字节。ZIP SHA256 `ec9619e35bf144b5000f45c570f0814af27959e49c0c578a9940fe655e110319`；bundleId、manifest、cli、browser-helper、Bun 二进制哈希在 `cold-summary.json`。

| 路径 / 毫秒 | 基线中位数（最小–最大） | 候选中位数（最小–最大） |
|---|---:|---:|
| 目标不存在：readiness + ensure | 13429.76（13136.67–13587.30） | 12665.81（12164.56–13084.22） |
| 目标不存在：cpSync | 6527.43（6443.41–6716.93） | 6613.76（6525.13–7878.16） |
| 目标不存在：完整扫描累计 | 6816.53（6429.02–7130.29） | 5602.85（5168.56–6131.54） |
| 已有有效安装：readiness + ensure | 3770.41（3738.39–3817.97） | 3756.28（3725.15–3894.42） |

首次安装每个版本 5 次；顺序 AB、BA、AB、BA、AB。每个样本使用新的 coreHome，完成后只清理该样本目录。完整扫描固定为基线 5 次、候选 4 次：readiness source、installer source、temporary、published destination，基线额外再扫描 destination。总时中位数约少 764ms（5.69%），五对差值均为正，但第四对仅快 52ms，复制波动明显。该观察支持少一次扫描；不证明所有机器均有同等提升。

已有安装另行预置 baseline/candidate 各一个有效目标；预置记录在 `warm-setup.redacted.jsonl`，不混入缓存命中样本。随后同样 5 对交错。每次都是 3 次完整扫描、零复制，候选和基线范围重叠，视为无可区分改善。保留该结果，不将噪声称为加速。

未清操作系统文件缓存；“首次”只表示目标安装目录不存在。两组同一 Windows 会话、相同磁盘/源包，计时未同时施加 CPU 压力。Windows loadavg 按平台实现为零，不能用它推断机器完全空闲。RSS 是测量进程值。没有 app ready / exit 的端到端计时，不声称修复原 45 秒 package-smoke 超时。

## 脚本与复现布局

`cold-benchmark.cjs` 和 `warm-benchmark.cjs` 是实际执行脚本，归档只改文件名，内容未变。计时调用产品的 `waitForPackagedRuntimeSource`、`ensurePackagedRuntime`；VM 只包裹 inspectRuntimeBundle 与 fs.cpSync 记录时间和扫描次数，对两个版本对称。源码由 manifest 中的两个固定提交提取，没有改校验逻辑。

准备一个独立目录，将 `cold-benchmark.cjs` 重命名为 `benchmark.cjs`，并把第二个脚本保持 `warm-benchmark.cjs`。准备以下相对布局：

```text
benchmark.cjs
warm-benchmark.cjs
atomic-file.cjs              # 固定基线 launcher/electron/atomic-file.cjs
runtime-command.cjs          # 固定基线 launcher/electron/runtime-command.cjs
baseline/runtime-install.cjs # 从固定基线提取
candidate/runtime-install.cjs# 从固定候选提取
payload/unpacked/resources/runtime/ # 同一安装包中的完整 runtime
```

在 Windows Node 22.15.0 下，依次运行 `node benchmark.cjs`、`node warm-benchmark.cjs`，每个脚本独立完成其 5 对；不会执行产品 EXE 安装程序、不会启动应用服务或调用模型。输出 JSONL 写到脚本上级目录，文件名见脚本常量。脚本拒绝冷样本预存目标，warm 脚本拒绝预置目标已存在，避免混淆路径。

完整包获取方式：已校验的 Actions ZIP 中，展开的 build/runtime 因 artifact 隐藏文件过滤缺 87 项，被原清单/30 秒检查拒绝（`preflight-failure.json`）。没有补造文件或绕过验证。用本机既有 7-Zip 只提取 ZIP 内 `artifacts/codex-web-gpt-6.1.10-win-x64.exe` 的 `$PLUGINSDIR/app-64.7z`，再提取 `resources/runtime/*`。没有运行安装程序。该完整嵌入包经原校验后才用于所有正式样本。

Windows 最终安装回归日志为 `windows-correctness.tap.txt`，14/14，包括发布后同长度损坏的新装清除/旧包恢复，以及已有安装同长度篡改后的修复。所有证据为本地文件/受控安装，模型物理提交为零。
