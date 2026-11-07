#!/bin/bash
set -eo pipefail
MCP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -L "$MCP/.cache" ]]; then echo 'Unexpected symlink'; exit 22; fi
umask 077
mkdir -p "$HOME/Library/Application Support/McpGo/playwright"
printf 'Enter dedicated Playwright MCP tunnel ID: '
IFS= read -r TUNNEL_ID
if [[ ! "$TUNNEL_ID" =~ ^tunnel_[a-z0-9_]+$ ]]; then echo 'Invalid tunnel ID prefix'; exit 2; fi
printf 'Enter runtime API key (input hidden, never paste into ChatGPT): '
IFS= read -rs CONTROL_PLANE_API_KEY
printf '\n'
if [[ -z "$CONTROL_PLANE_API_KEY" ]]; then echo 'Empty key'; exit 2; fi
printf '%s' "$TUNNEL_ID" > "$HOME/Library/Application Support/McpGo/playwright/tunnel.id"
printf '%s' "$CONTROL_PLANE_API_KEY" > "$HOME/Library/Application Support/McpGo/playwright/tunnel.key"
chmod 600 "$HOME/Library/Application Support/McpGo/playwright/tunnel.id" "$HOME/Library/Application Support/McpGo/playwright/tunnel.key"
unset CONTROL_PLANE_API_KEY
echo 'Credentials saved only within ignored project-local .cache/ (permissions 600).'
