#!/bin/zsh
set -euo pipefail
CONTROL_PLANE_API_KEY="$(/usr/bin/security find-generic-password -a "$(/usr/bin/id -un)" -s "com.chat-terminal-hub.openai.tunnel" -w)"
if [[ -z "$CONTROL_PLANE_API_KEY" ]]; then
  echo "Отсутствует runtime API key в Связке ключей" >&2
  exit 1
fi
export CONTROL_PLANE_API_KEY
exec /opt/homebrew/bin/tunnel-client doctor --profile chat-terminal-hub --explain
