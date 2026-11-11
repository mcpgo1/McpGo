#!/bin/zsh
set -euo pipefail
CONTROL_PLANE_API_KEY="$(/usr/bin/security find-generic-password -a "$(/usr/bin/id -un)" -s "com.chat-terminal-hub.openai.tunnel" -w)"
if [[ -z "$CONTROL_PLANE_API_KEY" ]]; then
  echo "Отсутствует ключ в Связке ключей. Сначала запустите save-tunnel-key.sh" >&2
  exit 1
fi
export CONTROL_PLANE_API_KEY
# Local health only: no publicly exposed listener.
umask 077
HEALTH_DIR="$HOME/Library/Application Support/McpGo/terminal"
/bin/mkdir -p -m 700 "$HEALTH_DIR"
/bin/chmod 700 "$HEALTH_DIR"
HEALTH_FILE="$HEALTH_DIR/tunnel-health.url"
/bin/rm -f "$HEALTH_FILE"
exec "${MCPGO_TUNNEL_CLIENT:-$(command -v tunnel-client)}" run --profile chat-terminal-hub \
  --health.listen-addr 127.0.0.1:0 \
  --health.url-file "$HEALTH_FILE"
