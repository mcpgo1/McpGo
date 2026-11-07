#!/bin/sh
set -eu
LOG="$HOME/Library/Logs/ChatTerminalHub/oneshot-unlimited-restart.log"
for i in $(jot 120 1); do
  ACTIVE=$(/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:12848/health | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["active"])' 2>/dev/null || echo unknown)
  if [ "$ACTIVE" = "0" ]; then
    printf 'IDLE_CONFIRMED\n' >> "$LOG"
    /bin/launchctl kickstart -k "gui/$(/usr/bin/id -u)/com.chatterminalhub.oneshot" >> "$LOG" 2>&1
    printf 'RESTART_COMPLETE\n' >> "$LOG"
    exit 0
  fi
  /bin/sleep 1
done
printf 'RESTART_CANCELLED_NOT_IDLE\n' >> "$LOG"
exit 2
