#!/bin/zsh
set -euo pipefail
D="$HOME/Applications/ChatTerminalHub"
if [[ ! -x "$D/keychain_save" ]]; then
    echo "Ошибка: Keychain helper не скомпилирован" >&2
    exit 1
fi
exec "$D/keychain_save"
