---
name: tunnel-diagnostics
description: Диагностировать Secure MCP Tunnel, LaunchAgents, Chrome CDP и доставку по таймеру.
---
# McpGo — диагностика туннелей

## Назначение
ChatGPT не видит плагин, tunnel-client не подключается, не появляются инструменты после изменения Tunnel ID или runtime-ключа.

## Актуальные контуры
- **ChatTerminalHub**: профиль `~/.config/tunnel-client/chat-terminal-hub.yaml`, runtime API-ключ в macOS Keychain, server + OneShot + tunnel. Исполняемый скрипт `~/Library/Application Support/ChatTerminalHub/run-tunnel.sh`, а не прежний путь на Desktop; Dashboard исправляет старый LaunchAgent.
- **PlaywrightHub**: ID в `mcphub/playwright/.cache/tunnel.id`, ключ в Keychain (в старых настройках — защищённый файл); личный Chrome через CDP на MCP 8931, Safe proxy `127.0.0.1:8940/mcp`, tunnel-client.
- Имена плагинов ChatGPT и идентификаторы `tunnel_...` — разные сущности.

## AutoSend
Сообщения по таймеру доставляет отдельная служба `com.mcphub.autosend` (`127.0.0.1:8972`) через Playwright CDP MCP (`127.0.0.1:8940/mcp`). Это **не третий туннель** и не Chrome Extension / Native Messaging. Перед отправкой проверяются полный URL чата и занятость ответом. При занятом агенте следует ждать нового интервала, после неясного клика автоматически не повторять отправку.

## Безопасная проверка
1. В McpGo → Обзор проверь статус процессов и портов; это ещё не значит, что внешний туннель подключён.
2. В Настройках туннелей проверь наличие ID и индикатор сохранения ключа **без чтения самого секрета**.
3. Для TerminalHub допустима проверка профиля: `tunnel-client doctor --profile chat-terminal-hub --explain`, вывод очистить от токенов.
4. Прочитай журналы McpGo и минимальные ошибки, не копируй секреты/целиком логи в чат.
5. Для TerminalHub проверь `launchctl print "gui/$(id -u)/com.chatterminalhub.tunnel"` и `ProgramArguments:0` в `~/Library/LaunchAgents/com.chatterminalhub.tunnel.plist`; путь должен вести в Application Support. Проверь разрешения Tunnels Read + Use, ассоциацию ChatGPT workspace, HTTPS к api.openai.com:443, локальный MCP endpoint.
6. После устранения причин сделай безопасный вызов инструмента из ChatGPT и только тогда ставь PASS.

## Восстановление
- Новый ключ вводится только локально в защищённое поле Настроек туннелей.
- Переподключай только нужный туннель и только с разрешения: TerminalHub может прервать текущий доступ к Mac.
- PlaywrightHub должен использовать Safe proxy `8940`, не открывать raw browser MCP `8931` наружу.

## CDP — единственный режим браузера

PlaywrightHub использует `--cdp-endpoint chrome` и уже открытый личный Google Chrome, без расширения, токенов Extension и отдельного профиля. При сбоях проверь `chrome://inspect/#remote-debugging` и статус сервисов McpGo; не запускай новый Chromium.

## Chrome запрашивает «Разрешить удалённую отладку» на каждом шаге

Chrome требует согласие на **новую** CDP-сессию. Не отключай защиту браузера: McpGo переиспользует общую upstream MCP-сессию через `playwright/restricted-proxy.mjs`. При повторном предупреждении проверь, не перезапускаются ли `com.mcphub.playwright.proxy`, browser MCP или сам Chrome; не создавай отдельные MCP-подключения к порту `8931` в обход прокси. После настоящего перезапуска может понадобиться однократное подтверждение.


## Долговременные задания после MCP disconnect

Перезапуск tunnel не является повторным запуском пользовательской команды. Если агент потерял ответ от `job_start`, сначала запроси `job_recent`, затем `job_status`/`job_watch`. Только `job_result` с достоверным `exit_code=0` позволяет считать локальную команду завершённой успешно. Для browser action ID используй `mcpgo_action_status`; после неизвестного результата Send не нажимай кнопку повторно.

## Восстановление McpGo 2.0.4

После ручного успешного запуска Dashboard сохраняет право контроля
именно этого туннеля. /healthz проверяет liveness, /readyz — readiness.
Живой, но non-ready tunnel-client автоматически не убивается.
При трёх liveness-ошибках включается ограниченный reconnect/backoff;
Chrome, PTY и ранее запущенные команды не повторяются.
Для поиска заданий после обрыва: mcpgo_recover, затем job_status.
