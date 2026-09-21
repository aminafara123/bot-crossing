#!/usr/bin/env bash
# Serve Bot Crossing to your own network, for the phone. Binds every interface and tells
# the server which names a phone may arrive with. Only ever run this on a network you own,
# or over a private mesh like Tailscale. The README section "Keeping it local" says why.
set -euo pipefail
cd "$(dirname "$0")"

# Started from a launcher there may be no interactive shell to find node for us.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

HOSTS=""
add_host() { [ -n "$1" ] && HOSTS="${HOSTS:+$HOSTS,}$1" || true; }

# Under WSL2 the phone dials the Windows side, so that address must be on the list.
if command -v powershell.exe >/dev/null 2>&1; then
  add_host "$(powershell.exe -NoProfile -Command \
    '(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway} | Select-Object -First 1).IPv4Address.IPAddress' \
    2>/dev/null | tr -d '\r[:space:]' || true)"
fi

# Tailscale, on Windows or on this machine, makes it reachable from anywhere you are.
TS_WIN="/mnt/c/Program Files/Tailscale/tailscale.exe"
if [ -x "$TS_WIN" ]; then
  add_host "$("$TS_WIN" ip -4 2>/dev/null | head -1 | tr -d '\r[:space:]' || true)"
  add_host "$("$TS_WIN" status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
elif command -v tailscale >/dev/null 2>&1; then
  add_host "$(tailscale ip -4 2>/dev/null | head -1 || true)"
fi

# Anything else you want allowed, comma separated.
add_host "${BOT_CROSSING_EXTRA_HOSTS:-}"

export BOT_CROSSING_HOST=0.0.0.0
export BOT_CROSSING_ALLOWED_HOSTS="$HOSTS"
echo "Allowed phone hosts: ${HOSTS:-(none found, set BOT_CROSSING_EXTRA_HOSTS)}"
exec npm run serve
