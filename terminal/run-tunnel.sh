#!/bin/zsh
set -euo pipefail
CONTROL_PLANE_API_KEY="$(/usr/bin/security find-generic-password -a "$(/usr/bin/id -un)" -s "com.chat-terminal-hub.openai.tunnel" -w)"
if [[ -z "$CONTROL_PLANE_API_KEY" ]]; then
  echo "Отсутствует ключ в Связке ключей. Сначала запустите save-tunnel-key.sh" >&2
  exit 1
fi
export CONTROL_PLANE_API_KEY
exec "${MCPGO_TUNNEL_CLIENT:-$(command -v tunnel-client)}" run --profile chat-terminal-hub
