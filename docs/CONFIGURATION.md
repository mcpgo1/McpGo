# Конфигурация McpGo

Это карта **фактически используемых** настроек в исходниках. Значения здесь не являются универсальным установщиком: для переноса на другой компьютер нужно заменить абсолютные пути в legacy-компонентах.

## 1. macOS launchd

Каждый `launchagents/*.plist` — шаблон. Реальные службы пользователя регистрируются в `~/Library/LaunchAgents`, домен `gui/$(id -u)`. Нельзя считать правку шаблона применённой, пока не обновлён активный plist и не перезагружена соответствующая служба.

| Label | Точка входа | Назначение |
|---|---|---|
| `com.chatterminalhub.server` | `terminal/server.js` | Command server |
| `com.chatterminalhub.oneshot` | `terminal/stateless_server.js` | OneShot/jobs |
| `com.chatterminalhub.tunnel` | `~/Library/Application Support/ChatTerminalHub/run-tunnel.sh` | Secure terminal tunnel |
| `com.mcphub.playwright.browser` | `launchers/browser.mjs` | Запуск Playwright MCP CDP |
| `com.mcphub.playwright.proxy` | `playwright/restricted-proxy.mjs shared` | Safe proxy |
| `com.mcphub.playwright.tunnel` | `launchers/tunnel.mjs` | Secure browser tunnel |
| `com.mcphub.dashboard` | `dashboard/server.mjs` | Статус и control API |
| `com.mcphub.messaging` | `messaging/start.mjs` | HTTP для агентской очереди |
| `com.mcphub.autosend` | `autosend/server.mjs` | Планировщик |

Шаблоны используют `/opt/homebrew/bin/node`. На другом Mac проверьте точный путь Node, `ProgramArguments`, `WorkingDirectory`, `RunAtLoad`, `KeepAlive`, права и пути журналов. Туннель TerminalHub ранее завершался с кодом 127 при попытке читать скрипт прямо с Desktop; теперь Dashboard переносит его в Application Support и исправляет `ProgramArguments:0`.

Для инспекции без изменения состояния:

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.chatterminalhub.tunnel.plist"
launchctl print "gui/$(id -u)/com.chatterminalhub.tunnel"
```

## 2. Порты и адреса

| Порт | Процесс | Endpoint |
|---|---|---|
| 12847 | Terminal command server | `127.0.0.1:12847/health` |
| 12848 | Terminal OneShot/job server | `127.0.0.1:12848/health` |
| 8931 | Playwright MCP | `127.0.0.1:8931/mcp` |
| 8940 | MCP proxy | `127.0.0.1:8940/mcp` |
| 8969 | Dashboard | `127.0.0.1:8969/api/status` |
| 8971 | Messaging | `127.0.0.1:8971/api/status` |
| 8972 | AutoSend | `127.0.0.1:8972/api/status` |

Все перечисленные HTTP endpoints — loopback. Не настраивать `0.0.0.0` без отдельного анализа угроз.

## 3. Конфигурация браузера

`playwright/start.sh` вычисляет собственный каталог на основе `BASH_SOURCE[0]`, проверяет отсутствие нежелательных симлинков для `node_modules` и `.cache`, создаёт необходимые временные папки. Основные флаги:

```text
--host 127.0.0.1
--port 8931
--cdp-endpoint chrome
--shared-browser-context
--caps vision,devtools
--block-service-workers
--no-webmcp
--timeout-navigation 45000
```

Папка результатов — `playwright/artifacts/shared`; временные и browser caches — в `playwright/.cache`. Подключение к Chrome невозможно, пока пользователь не разрешит remote debugging в самом Chrome.

`playwright/restricted-proxy.mjs` по умолчанию работает в режиме `shared`, переиспользует одну upstream MCP session, фильтрует `browser_run_code_unsafe` и ограничивает возможные имена инструментов по своему исходному коду.

## 4. Переменные окружения

| Имя | Использование | Значение/оговорка |
|---|---|---|
| `MCPHUB_AUTOSEND_PORT` | AutoSend HTTP bind | По умолчанию 8972 |
| `MCPHUB_AUTOSEND_CHECK_MS` | Период опроса расписаний | По умолчанию 10000 мс |
| `MCPHUB_AUTOSEND_STATE` | Путь файла расписаний | По умолчанию `~/Library/Application Support/MCPHub/AutoSend/tasks.json` |
| `MCPHUB_PLAYWRIGHT_MCP_URL` | CDP delivery client | По умолчанию `http://127.0.0.1:8940/mcp` |
| `MCPHUB_AUTOSEND_TEST_RETRY_MS` | Тестовые отложенные повторы | Только при `NODE_ENV=test` |
| `MCPHUB_MESSAGE_DB` | Messaging SQLite | По умолчанию `messaging/data/messages.sqlite3` |
| `CONTROL_PLANE_TUNNEL_ID` | Browser tunnel | ID туннеля или значение из `.cache/tunnel.id` |
| `CONTROL_PLANE_API_KEY` | Tunnel client | Runtime key для действующего профиля |
| `PLAYWRIGHT_MCP_URL`, `PLAYWRIGHT_MCP_REJECT_UNSAFE`, `PLAYWRIGHT_MCP_VERIFY_TABS` | Browser diagnostics/probe | Используются при проверках backend/proxy |

Внутренние исторические имена переменных и сервисов сохранены ради существующих конфигураций; это не часть публичного бренда McpGo.

## 5. Данные и хранилища

| Данные | Место | Особенности |
|---|---|---|
| Очередь агентов | `messaging/data/messages.sqlite3` | SQLite + WAL, журнал сообщений и отметки ack |
| AutoSend | `~/Library/Application Support/MCPHub/AutoSend/tasks.json` | Атомарная запись во временный файл с rename, состояние заданий |
| Terminal tunnel wrapper | `~/Library/Application Support/ChatTerminalHub/run-tunnel.sh` | Отдельный запускаемый файл, owner-only |
| Browser tunnel ID | `playwright/.cache/tunnel.id` | Локальные настройки |
| Chrome профиль | Профиль пользователя Chrome | McpGo его не копирует |
| Skills | `skills/*/SKILL.md` и `McpGo.app/.../Resources/skills` | Встроенные файлы имеют приоритет в SwiftUI |

Резервное копирование SQLite с WAL следует выполнять через SQLite backup API или при остановленной службе. Не копируйте только основной SQLite файл, предполагая, что текущие транзакции уже записаны в него.

## 6. Подготовка переносимого релиза

Задайте платформенные пути через конфигурацию, исключите абсолютное имя пользователя, автоматизируйте plist installation, migration старых IDs, проверку правильного Node path, подпись приложения и smoke tests. До реализации этого McpGo документируется как **локальная референс-установка**, а не как полностью переносимый пакет.
