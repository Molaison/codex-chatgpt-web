# Remaining recovery work

These are open outcomes, not completed features. The authoritative task records remain in the deployment project. Production authorization does not mark these tests passed.

| Task | Outcome | Status |
|---|---|---|
| `bd_203_install_codex_proxy_rs_ywl-2ph` | [UX01] 恢复已输出正文并支持原客户端断线或退出后接回 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-7y0` | [UX02] 工具结果恢复后在同一用户意图中继续完成后续工作流 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-jg1` | [UX03] 统一服务端恢复预算及客户端非错误状态呈现 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-vtq` | [UX04] 闭环长工具、stdin、自定义工具和混合批次的真实断链恢复 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-yud` | [UX05] 验收并修复steer、interrupt及压缩后的会话连续性 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-6v5` | 落实CPR到Web负载分担与账号3密钥隔离 | blocked |
| `bd_203_install_codex_proxy_rs_ywl-7rb` | [UX07] 实现认证、目录和异常实例的服务端自动维护闭环 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-65t` | [UX08] 交付cwd、权限形态和旧证明升级的连续性 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-b1z` | [UX09] 验收并补齐附件与多段输入中断后的完整恢复 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-6ap` | [UX10] 验证并补齐多调用者写入同一聊天的隔离 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-xml` | [UX11] 交付全部稳定性能力的配套生产发布与在途任务保护 | in_progress |
| `bd_203_install_codex_proxy_rs_ywl-tur.3` | [恢复验收] 闭环旧Pro Ultra兼容与真实Full工具能力 | open |
| `bd_203_install_codex_proxy_rs_ywl-tur.4` | [性能] 验证并降低预热后的实际首字延迟 | open |

## Production cutover result (2026-10-25)

The approved maintenance exception was executed by the existing coordinated release owner. Fourteen Web/MCP listeners accepted traffic after the cutover; four paired Launchers retained their profiles and partitions. The old MCP inventory remains unreconciled: the native gate was not passed and no old request was replayed.

**Production business acceptance failed.** Full1 public canary162 (`f5e5d05c3a59`) activated Send but did not bind a saved conversation URL. Native tools executed zero times; the pending mapping is preserved. No second turn was sent and no request was replayed. A healthy listener is not a successful tool turn.

The first failed cutover and its recovery evidence remain failed. The second original-record resume completed the cutover. Do not repeat deployment or blindly roll back live durable state to an incompatible old package.

Next: repair saved-conversation binding and interrupted-stream completion in the isolated account-2 candidate. Production stays read-only; do not navigate its pages or send new test requests. The eleven UX outcomes remain open. Deployment adapter and reproducible canary are archived under `patches/deployment/02_production_handover_and_canary.patch`.

## Isolated follow-up: candidate168

Production is frozen at the earlier qualified 145 backend. Later changes are only deployed to the existing account-2 recovery42 API, not production or dd.

A real combined fault now passes: opening the actual model menu after prompt preparation and delaying the real saved conversation route by 28 seconds. The server reselects the same model/effort once and requires a fresh strict proof before Send; it waits for the original saved route under the existing Send budget. One Native execution produced exactly one test-file line and one exact final. A fresh no-tool follow-up in the same Codex thread recalled the nonce on the same saved URL. Specific wait/model notices survived real helper IPC and were absent from canonical response items and all three actual model inputs. Evidence: `168_recovery_verification.json`.

Original failures remain failed: delayed-save164, pre-Send model167, production162 and interrupted145. The interrupted145 continuation contains six identical 386-character assistant items and lacks terminal confirmation; its original saved-page read did not prove a complete answer. This remains the next P0, not a completed feature. R43 and main's independent Mol185 work have not been silently merged.
