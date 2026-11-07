#!/bin/bash
# Compatibility shortcut; opens the same portable first-run launcher.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec /bin/bash "$ROOT/scripts/launch-macos.sh"
