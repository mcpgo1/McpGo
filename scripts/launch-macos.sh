#!/bin/bash
# One-click launcher; all installation operations require UI approval.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'McpGo Desktop currently supports macOS.' >&2
  exit 2
fi
if [[ ! -d "$ROOT/McpGo.app" ]]; then
  echo 'McpGo.app is missing from the release.' >&2
  exit 2
fi
/usr/bin/open "$ROOT/McpGo.app"
echo 'Use the First Connection wizard in McpGo to finish setup.'
