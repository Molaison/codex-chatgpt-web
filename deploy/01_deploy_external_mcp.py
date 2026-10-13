#!/usr/bin/env python3
"""Stage 1 for the isolated per-account External HTTP MCP route.

Run on the Linux admin host that owns the ChatGPT Web runtimes:

    python3 01_deploy_external_mcp.py --stage prepare --release <bundle> --origin <public origin>
    python3 01_deploy_external_mcp.py --stage ingress --release <bundle> --origin <public origin>

prepare
    Creates one isolated Full profile per account from the existing QA profile
    (config.json, client/config.toml and the full/mcp systemd user units). QA configs,
    keys and browsers are read-only inputs and are never rewritten.

ingress
    Points the public gateway at /local-mcp/account-N/mcp for every account and writes a
    dropin for the public-ingress unit. The shared public-ingress service is NOT restarted
    automatically: pass --restart-public-ingress only after confirming that no public
    request is in flight.

Prerequisites: a built runtime bundle at --release (bin/, app/download-gateway.js,
runtime/bun) and a working QA profile per account at --home/--source-prefix N.
The control token stays in the private home at 0600; this script never prints credentials.
"""
import argparse
import json
import secrets
import shutil
import subprocess
from pathlib import Path

# Local loopback port layout of the deployed stack (QA, Full runtime, local MCP).
QA_PORT_BASE = 17850
FULL_PORT_BASE = 17950
MCP_PORT_BASE = 17960
INGRESS_SERVICE = "chatgpt-web-public-ingress.service"

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--stage", required=True, choices=["prepare", "ingress"])
parser.add_argument("--release", required=True, help="built runtime bundle root (contains bin/, app/download-gateway.js, runtime/bun)")
parser.add_argument("--origin", required=True, help="public origin serving /local-mcp/account-N/mcp, for example https://cpr.example.org")
parser.add_argument("--home", default=str(Path.home() / ".local" / "share" / "codex-chatgpt-web"), help="runtime home root (default: ~/.local/share/codex-chatgpt-web)")
parser.add_argument("--units", default=str(Path.home() / ".config" / "systemd" / "user"), help="systemd user unit directory (default: ~/.config/systemd/user)")
parser.add_argument("--accounts", default="1,2", help="comma-separated account numbers (default: 1,2)")
parser.add_argument("--source-prefix", default="account", help="existing QA profile directory prefix, <home>/<prefix>-N (default: account)")
parser.add_argument("--restart-public-ingress", action="store_true", help="restart the shared public ingress at the end of the ingress stage")
args = parser.parse_args()

home = Path(args.home)
release = Path(args.release)
units = Path(args.units)
origin = args.origin.rstrip("/")
accounts = [int(value) for value in args.accounts.split(",")]
workdir = str(Path.home())

if args.stage == "prepare":
    services = []
    for account in accounts:
        target = home / f"full-{account}"
        target.mkdir(mode=0o700, exist_ok=True)
        (target / "runtime").mkdir(mode=0o700, exist_ok=True)
        config_path = target / "config.json"
        if not config_path.exists():
            # 从现有 QA 资料派生；已存在的资料原样复用，重试不会重新生成 control token。
            config = json.loads((home / f"{args.source_prefix}-{account}" / "config.json").read_text())
            config.update(mode="full", mcpProvider="external-http", port=FULL_PORT_BASE + account,
                          appName="Codex Cloudflare", automaticAppName="Codex Cloudflare",
                          brokerSocketPath=str(target / "runtime/turn-broker.sock"),
                          controlToken=secrets.token_urlsafe(32),
                          runtimeCommand=[str(release / "bin/codex-chatgpt-web")],
                          conversationStoreDirectory=str(target / "runtime/conversations"),
                          useSavedChats=False, autoApproveToolCalls=False)
            # 生成文件下载改走公网 gateway 的账号路径前缀，不再使用单机 downloadBaseUrl。
            config.pop("downloadBaseUrl", None)
            config_path.write_text(json.dumps(config, indent=2) + "\n")
            config_path.chmod(0o600)
        client = target / "client"
        client.mkdir(mode=0o700, exist_ok=True)
        client_config = client / "config.toml"
        if not client_config.exists():
            client_config.write_text(
                'model = "chatgpt-web/gpt-5.6-sol"\nmodel_provider = "qa"\n'
                'model_reasoning_effort = "high"\n'
                f'[model_providers.qa]\nname = "Existing QA account {account}"\n'
                f'base_url = "http://127.0.0.1:{QA_PORT_BASE + account}/v1"\n'
                'wire_api = "responses"\nrequires_openai_auth = false\n'
                f'[model_providers.tools]\nname = "Cloudflare Full account {account}"\n'
                f'base_url = "http://127.0.0.1:{FULL_PORT_BASE + account}/v1"\n'
                'wire_api = "responses"\nrequires_openai_auth = false\n')
            client_config.chmod(0o600)
        for service, command in (
            (f"chatgpt-web-full-{account}", f"{release}/bin/codex-chatgpt-web --home {target} serve"),
            (f"chatgpt-web-mcp-{account}", f"{release}/bin/codex-chatgpt-web --home {target} mcp --transport http --port {MCP_PORT_BASE + account} --contract native --public-origin {origin}"),
        ):
            (units / f"{service}.service").write_text(
                f"[Unit]\nDescription=ChatGPT account {account} isolated external MCP {service}\n"
                f"After=chatgpt-web-launcher-{account}.service\n\n[Service]\n"
                f"ExecStart={command}\nWorkingDirectory={workdir}\nRestart=on-failure\nRestartSec=5\n"
                f"UMask=0077\nStandardOutput=append:{target}/{service}.log\n"
                f"StandardError=append:{target}/{service}.log\n\n[Install]\nWantedBy=default.target\n")
            services.append(service + ".service")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", *services], check=True)
    print(json.dumps({"stage": args.stage, "services": services, "qa_configs_changed": False}))

if args.stage == "ingress":
    path = home / "public-ingress.json"
    backup = home / "public-ingress.before-external-mcp.json"
    if not backup.exists():
        shutil.copy2(path, backup)
    config = json.loads(path.read_text())
    # 精确映射：/local-mcp/account-N/mcp -> 本账号的本机 MCP 端口，其他路径行为不变。
    config["mcpAccounts"] = {f"account-{account}": f"http://127.0.0.1:{MCP_PORT_BASE + account}" for account in accounts}
    path.write_text(json.dumps(config, indent=2) + "\n")
    dropin = units / f"{INGRESS_SERVICE}.d/zzzz-external-mcp.conf"
    dropin.parent.mkdir(exist_ok=True)
    dropin.write_text(f"[Service]\nExecStart=\nExecStart={release}/runtime/bun {release}/app/download-gateway.js {path}\n")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    restart = f"systemctl --user restart {INGRESS_SERVICE}"
    if args.restart_public_ingress:
        subprocess.run(["systemctl", "--user", "restart", INGRESS_SERVICE], check=True)
    print(json.dumps({
        "stage": args.stage,
        "mcp_urls": [f"{origin}/local-mcp/account-{account}/mcp" for account in accounts],
        "backup": str(backup),
        "restarted": bool(args.restart_public_ingress),
        "restart_command": restart,
    }))
