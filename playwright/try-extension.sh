#!/bin/bash
# Read-only standalone smoke test. Does not touch the running :8931 backend, proxy or tunnel.
set -euo pipefail
MCP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(dirname "$MCP")"
PORT="${MCPGO_PLAYWRIGHT_TRIAL_PORT:-8999}"
TOKEN_FILE="$HOME/Library/Application Support/McpGo/playwright/extension-token"
if [[ ! "$PORT" =~ ^[0-9]{4,5}$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo 'Invalid trial port' >&2; exit 2
fi
if [[ ! -f "$TOKEN_FILE" || -L "$TOKEN_FILE" ]]; then
  echo 'First configure a Playwright Extension token with: bash playwright/configure-extension.sh' >&2
  exit 2
fi
if [[ ! -f "$MCP/node_modules/@playwright/mcp/cli.js" ]]; then
  echo 'Run npm ci in playwright/ before the trial.' >&2; exit 2
fi
if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  echo "Port $PORT is already in use; existing process left untouched." >&2
  exit 2
fi
LOG="$(mktemp "${TMPDIR:-/tmp/}mcpgo-playwright-trial.XXXXXX")"
PID=''
cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT
MCPGO_BROWSER_MODE=extension MCPGO_PLAYWRIGHT_PORT="$PORT" node "$ROOT/launchers/browser.mjs" > "$LOG" 2>&1 &
PID=$!
READY=0
for _ in {1..30}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo 'Trial backend exited before becoming ready.' >&2
    tail -n 12 "$LOG" >&2
    exit 1
  fi
  if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    READY=1
    break
  fi
  sleep 1
done
if (( READY == 0 )); then
  echo 'Trial backend did not open its local port.' >&2
  tail -n 12 "$LOG" >&2
  exit 1
fi
echo "Trial Playwright Extension connected on localhost:$PORT. Checking real browser tabs..."
PLAYWRIGHT_MCP_URL="http://127.0.0.1:$PORT/mcp" PLAYWRIGHT_MCP_PROBE_MODE=direct PLAYWRIGHT_MCP_VERIFY_TABS=1 node "$MCP/probe.mjs"
echo 'Extension smoke test passed; live McpGo backend was not changed.'
