#!/bin/bash
set -euo pipefail
MCP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -L "$MCP/node_modules" || -L "$MCP/.cache" ]]; then echo 'Unexpected symlink' >&2; exit 22; fi
MODE=shared
PORT=8931
mkdir -p "$MCP/.cache/tmp" "$MCP/.cache/browsers" "$MCP/artifacts/shared"
export PWTEST_SOCKETS_DIR="/private/tmp/mcpgo-playwright-$(id -u)"
if [[ ! -e "$PWTEST_SOCKETS_DIR" ]]; then
  (umask 077; mkdir "$PWTEST_SOCKETS_DIR")
fi
if [[ -L "$PWTEST_SOCKETS_DIR" || ! -d "$PWTEST_SOCKETS_DIR" || ! -O "$PWTEST_SOCKETS_DIR" || "$(stat -f %Lp "$PWTEST_SOCKETS_DIR")" != 700 ]]; then
  echo 'Unsafe Playwright socket directory' >&2; exit 22
fi
export PLAYWRIGHT_BROWSERS_PATH="$MCP/.cache/browsers"
set -- --host 127.0.0.1 --port "$PORT" \
  --cdp-endpoint chrome --shared-browser-context --caps vision,devtools --block-service-workers --no-webmcp \
  --output-dir "$MCP/artifacts/shared" --timeout-navigation 45000
cd "$MCP"
echo "Starting McpGo Playwright CDP MCP ($MODE) at http://127.0.0.1:$PORT/mcp"
echo "Browser navigation: unrestricted origins"
# Apply/verify the pinned Playwright compatibility patch after every install.
node "$MCP/patch-playwright.mjs"
exec node "$MCP/node_modules/@playwright/mcp/cli.js" "$@"
