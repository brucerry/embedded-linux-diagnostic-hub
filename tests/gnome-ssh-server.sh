#!/usr/bin/env bash
# CI-only real OpenSSH/Bash fixture; never run against a user's existing SSH installation.
set -euo pipefail
[[ ${HUB_GNOME_ISOLATED:-} == 1 && $EUID == 0 ]] || exit 1
account=hubengineer
id "$account" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$account"
root=$(mktemp -d /tmp/hub-gnome-ssh.XXXXXX)
chmod 700 "$root"
password=$(openssl rand -hex 24)
printf '%s:%s\n' "$account" "$password" | chpasswd
ssh-keygen -q -t ed25519 -N '' -f "$root/host-key"
mkdir -p /run/sshd
cat >"$root/sshd.conf" <<EOF
Port 22223
ListenAddress 127.0.0.1
HostKey $root/host-key
PidFile $root/pid
PasswordAuthentication yes
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
AllowUsers $account
StrictModes yes
LogLevel ERROR
ForceCommand /usr/bin/python3 $root/gnome-ssh-command.py
EOF
# Public software inventory and dispatcher: no credentials are passed to Node or command lines.
node node_modules/tsx/dist/cli.mjs tests/fixtures/gnome-inventory.ts "$root/inventory.wire"
cp tests/fixtures/gnome-ssh-command.py "$root/gnome-ssh-command.py"
chmod 644 "$root/inventory.wire" "$root/gnome-ssh-command.py"
/usr/sbin/sshd -f "$root/sshd.conf" -E "$root/server.log"
# Credentials exist only in an owned private fixture file, never an artifact or build log.
# Send the random fixture credential through stdin, never process arguments or messages.
printf '%s' "$password" | python3 -c 'import json, pathlib, sys; pathlib.Path(sys.argv[1]).write_text(json.dumps({"host":"127.0.0.1","port":22223,"username":"hubengineer","password":sys.stdin.read(),"fixture":"gnome-software-continuity-v1"}))' "$root/connection.json"
unset password
chown hubengineer:hubengineer "$root/connection.json"
chmod 600 "$root/connection.json"
chmod 711 "$root"
printf '%s\n' "$root/connection.json" > /tmp/hub-gnome-connection-path
