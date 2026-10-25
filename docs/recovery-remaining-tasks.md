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

## Production preflight result

The four existing production MCP owners return HTTP404 for the native release-status endpoint. They do not expose the new pending-tool, continuation or unresolved-result inventory. Web HTTP/browser counters are zero, but that is not proof that MCP/Native work is settled. No production owner has been stopped or restarted.

Safe activation remains pending compatibility takeover and authoritative in-flight reconciliation. Do not fabricate zero counters, discard old memory sessions, restore stale databases or force-stop unknown tool work. The existing independent coordinated release entry point must own stop/recovery together.
