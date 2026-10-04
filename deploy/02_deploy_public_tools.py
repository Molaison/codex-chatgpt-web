#!/usr/bin/env python3
"""Stage 2: one isolated authenticated CPR provider route per ChatGPT account.

Run on the Linux admin host that owns the CPR stack and the ChatGPT Web runtimes:

    python3 02_deploy_public_tools.py --home <runtime home> [--color '#RRGGBBAA']

Adds, per account, a private CPR provider account + group + client key that reaches the
local Full runtime through a loopback-only socat bridge:

    public CPR origin -> 127.0.0.1:1797N -> provider.sock -> cpr-provider.mjs -> 127.0.0.1:1795N

Existing QA routes, keys, groups and projects are untouched and no shared service is
restarted; the DB change is announced through runtime_settings.config_revision.

Retry safety (observed during the first deployment):
  * account/group/key identifiers are deterministic, so a re-run cannot allocate duplicates;
  * the client key and provider key are written to the private recovery record
    <home>/full-N/public-test.json (0600) before any DB write and are reused on retry;
  * the insert transaction is idempotent (ON CONFLICT DO NOTHING), so a retry after a
    partial or failed commit converges instead of failing on the primary key;
  * account_groups.color is taken from an existing valid row (the column is NOT NULL and
    constrained to ^#[0-9A-F]{8}$) and --color is validated before the transaction starts.
Keys are never printed; read them from the recovery record when handing them to a client.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

GROUP_COLOR = re.compile(r"^#[0-9A-F]{8}$")  # account_groups_color_ck
BRIDGE_IMAGE = "docker.io/alpine/socat@sha256:24220ef2c80a2a421ea08e4624488e985330c421b6aa3329bae14b0933a1d403"
PROVIDER_PORT_BASE = 17970


def default_units() -> str:
    return str(Path.home() / ".config" / "systemd" / "user")


parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--home", default=str(Path.home() / ".local" / "share" / "codex-chatgpt-web"), help="runtime home root (default: ~/.local/share/codex-chatgpt-web)")
parser.add_argument("--accounts", default="1,2", help="comma-separated account numbers (default: 1,2)")
parser.add_argument("--source-name", default="chatgpt-web-linux-{account}", help="existing provider_accounts.name to clone per account (default: chatgpt-web-linux-{account})")
parser.add_argument("--source-prefix", default="account", help="existing QA profile directory prefix for models.json, <home>/<prefix>-N (default: account)")
parser.add_argument("--namespace", default="molaison/full-public-test", help="UUIDv5 namespace keeping the allocated identifiers stable across retries")
parser.add_argument("--color", help="account_groups.color to use; default copies a valid color from the existing table")
parser.add_argument("--units", default=default_units(), help="systemd user unit directory (default: ~/.config/systemd/user)")
parser.add_argument("--provider-script", default=str(Path(__file__).resolve().parent / "cpr-provider.mjs"), help="authenticated local provider to serve in front of the Full runtime")
parser.add_argument("--node", default=shutil.which("node") or "/usr/bin/node", help="node interpreter for the provider unit")
parser.add_argument("--podman", default=shutil.which("podman") or "/usr/bin/podman", help="podman binary for the bridge unit")
parser.add_argument("--sql-container", default="codex-proxy-rs_postgres_1", help="podman container running the CPR PostgreSQL instance")
parser.add_argument("--cpr-container", default="codex-proxy-rs_codex-proxy-rs_1", help="podman container providing the CPR network namespace")
args = parser.parse_args()

os.umask(0o077)
home = Path(args.home)
units = Path(args.units)
accounts = [int(value) for value in args.accounts.split(",")]
psql = [args.podman, "exec", "-i", args.sql_container, "sh", "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At']


def query(sql: str) -> str:
    return subprocess.check_output(psql, input=sql.encode()).decode().strip()


def execute(sql: str) -> None:
    subprocess.check_output(psql, input=sql.encode())


color = args.color
if color is None:
    color = query("SELECT color FROM account_groups WHERE color ~ '^#[0-9A-F]{8}$' ORDER BY created_at LIMIT 1")
if not GROUP_COLOR.match(color):
    sys.exit(f"account_groups.color must match ^#[0-9A-F]{{8}}$; got {color!r}. Pass --color with a valid value.")

results = []
for account in accounts:
    target = home / f"full-{account}"
    record = target / "public-test.json"
    if record.exists() and json.loads(record.read_text())["state"] == "configured":
        results.append({"account": account, "state": "already configured"})
        continue
    source_name = args.source_name.format(account=account)
    if "'" in source_name:
        sys.exit(f"provider account name must not contain a quote: {source_name!r}")
    source_id = query(f"SELECT id FROM provider_accounts WHERE name = '{source_name}'")
    if not source_id or "\n" in source_id:
        sys.exit(f"Expected exactly one provider_accounts row named {source_name!r}")
    # 确定性标识：重复执行不会生成第二套账号、分组或 key。
    ident = uuid.uuid5(uuid.NAMESPACE_URL, f"{args.namespace}/{account}").hex
    account_id, group_id, key_id = "acct_" + ident, "grp_" + ident, "key_" + ident
    provider_key = os.urandom(32).hex()
    client_key = "sk-" + os.urandom(32).hex()
    if record.exists():
        # 沿用恢复记录中的同一凭据；任何后续失败只允许重放，不允许重新分配 key。
        provider_key = (target / "provider.key").read_text()
        client_key = json.loads(record.read_text())["key"]
    (target / "cpr").mkdir(parents=True, mode=0o700, exist_ok=True)
    (target / "provider.key").write_text(provider_key)
    models = home / f"{args.source_prefix}-{account}" / "models.json"
    if not (target / "models.json").exists():
        (target / "models.json").symlink_to(models)
    record.write_text(json.dumps({"account": account_id, "group": group_id, "key_id": key_id, "key": client_key, "state": "allocated"}))
    record.chmod(0o600)
    provider_unit = f"chatgpt-web-full-provider-{account}"
    bridge_unit = f"chatgpt-web-full-bridge-{account}"
    port = PROVIDER_PORT_BASE + account
    (units / f"{provider_unit}.service").write_text(
        "[Unit]\nDescription=Isolated Full API authenticated provider\n[Service]\n"
        f"ExecStart={args.node} {args.provider_script} {target}\nRestart=on-failure\nUMask=0077\n"
        "[Install]\nWantedBy=default.target\n")
    (units / f"{bridge_unit}.service").write_text(
        f"[Unit]\nDescription=Private Full API CPR bridge\nAfter={provider_unit}.service\n[Service]\n"
        f"ExecStart={args.podman} run --rm --name {bridge_unit} --network container:{args.cpr_container} "
        f"--security-opt label=disable --security-opt no-new-privileges:true --cap-drop ALL --read-only "
        f"-v {target}/cpr:/run/provider:ro {BRIDGE_IMAGE} "
        f"TCP-LISTEN:{port},fork,reuseaddr,bind=127.0.0.1 UNIX-CONNECT:/run/provider/provider.sock\n"
        "Restart=on-failure\n[Install]\nWantedBy=default.target\n")
    subprocess.check_call(["systemctl", "--user", "daemon-reload"])
    subprocess.check_call(["systemctl", "--user", "enable", "--now", provider_unit, bridge_unit])
    execute(f"""BEGIN;
INSERT INTO provider_accounts SELECT (jsonb_populate_record(NULL::provider_accounts, to_jsonb(a) || jsonb_build_object('id','{account_id}','name','Full tools isolated test {account}','enabled',true,'created_at',now(),'updated_at',now(),'concurrency_limit',1,'provider_credentials_json',a.provider_credentials_json || jsonb_build_object('base_url','http://127.0.0.1:{port}/v1','api_key','{provider_key}')))).* FROM provider_accounts a WHERE id='{source_id}' ON CONFLICT (id) DO NOTHING;
INSERT INTO account_groups(id,name,description,enabled,created_at,updated_at,disable_fast,color) VALUES('{group_id}','Full tools isolated test {account}','Private acceptance only; no existing keys changed',true,now(),now(),false,'{color}') ON CONFLICT (id) DO NOTHING;
INSERT INTO account_group_accounts(account_group_id,provider_account_id,created_at) VALUES('{group_id}','{account_id}',now()) ON CONFLICT DO NOTHING;
INSERT INTO client_api_keys(id,name,label,key,enabled,max_concurrency,requests_per_minute,created_at,updated_at,provider_request_profiles_json) VALUES('{key_id}','Full tools isolated test {account}','acceptance','{client_key}',true,1,10,now(),now(),'{{}}') ON CONFLICT (id) DO NOTHING;
INSERT INTO client_api_key_groups(client_api_key_id,account_group_id,created_at) VALUES('{key_id}','{group_id}',now()) ON CONFLICT DO NOTHING;
UPDATE runtime_settings SET config_revision=config_revision+1,updated_at=now(); COMMIT;""")
    data = json.loads(record.read_text())
    data["state"] = "configured"
    record.write_text(json.dumps(data))
    record.chmod(0o600)
    results.append({"account": account, "state": "configured", "provider_port": port, "recovery_record": str(record)})
print(json.dumps({"accounts": results, "color": color, "restarted_services": []}))
