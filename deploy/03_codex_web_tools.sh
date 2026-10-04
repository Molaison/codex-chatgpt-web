#!/usr/bin/env bash
# Client side: codex-web-tools <1|2> [Codex arguments].
# Selects one isolated Full client home and the tools provider on this machine.
# Sandbox and approval flags are not overridden; the caller keeps control of them.
set -euo pipefail

usage() {
  printf '%s\n' \
    '用法：codex-web-tools <1|2> [Codex 参数]' \
    '示例：codex-web-tools 1' \
    '环境变量：CODEX_WEB_TOOLS_HOME 隔离资料根目录（默认 ~/.local/share/codex-chatgpt-web）' \
    '          CODEX_WEB_TOOLS_BIN  Codex 可执行文件（默认 codex）' \
    '纯聊天继续使用原来的入口。本命令只选择隔离的工具服务。'
}

case "${1:-}" in
  1|2) account=$1; shift ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

home_root="${CODEX_WEB_TOOLS_HOME:-$HOME/.local/share/codex-chatgpt-web}"
codex_bin="${CODEX_WEB_TOOLS_BIN:-codex}"
export CODEX_HOME="$home_root/full-${account}/client"
exec "$codex_bin" -c model_provider=tools "$@"
