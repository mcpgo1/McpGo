#!/bin/bash
set -eo pipefail
MCP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -L "$MCP/.cache" ]]; then echo 'Unexpected symlink'; exit 22; fi
umask 077
if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  CONTROL_PLANE_API_KEY="$(/usr/bin/security find-generic-password -a "$(/usr/bin/id -un)" -s 'com.mcphub.playwright.openai.tunnel' -w 2>/dev/null || true)"
fi
mkdir -p "$MCP/.cache/home" "$MCP/.cache/tmp"
export HOME="$MCP/.cache/home"
export TMPDIR="$MCP/.cache/tmp/"
if [[ -z "${CONTROL_PLANE_TUNNEL_ID:-}" && -f "$HOME/Library/Application Support/McpGo/playwright/tunnel.id" ]]; then
  CONTROL_PLANE_TUNNEL_ID="$(cat "$HOME/Library/Application Support/McpGo/playwright/tunnel.id")"
fi
if [[ -z "${CONTROL_PLANE_API_KEY:-}" && -f "$HOME/Library/Application Support/McpGo/playwright/tunnel.key" ]]; then
  PERM="$(stat -f '%Lp' "$HOME/Library/Application Support/McpGo/playwright/tunnel.key")"
  if [[ "$PERM" != 600 && "$PERM" != 400 ]]; then echo 'Tunnel key file must be chmod 600'; exit 26; fi
  CONTROL_PLANE_API_KEY="$(cat "$HOME/Library/Application Support/McpGo/playwright/tunnel.key")"
fi
if [[ -z "${CONTROL_PLANE_TUNNEL_ID:-}" || -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  echo 'Tunnel is not configured. Run playwright/configure-tunnel.sh interactively on Mac.' >&2
  exit 2
fi
export CONTROL_PLANE_API_KEY
printf '{}\n' > "$MCP/.cache/tunnel-empty-config.yaml"
echo 'Verifying safe local Playwright MCP endpoint before running outbound-only tunnel...'
PLAYWRIGHT_MCP_URL='http://127.0.0.1:8940/mcp' PLAYWRIGHT_MCP_REJECT_UNSAFE=1 node "$MCP/probe.mjs"
echo 'Starting outbound OpenAI Secure MCP Tunnel; no public inbound port.'
exec tunnel-client run \
  --config "$MCP/.cache/tunnel-empty-config.yaml" \
  --control-plane.tunnel-id "${CONTROL_PLANE_TUNNEL_ID:-}" \
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \
  --mcp.server-url 'http://127.0.0.1:8940/mcp' \
  --health.listen-addr 127.0.0.1:0
