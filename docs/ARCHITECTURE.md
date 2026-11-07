# McpGo — техническая архитектура

Актуально: 06.11.2026. McpGo — локальная macOS-панель управления ChatTerminalHub, PlaywrightHub, очередью агентов и отправкой сообщений по таймеру. Это не отдельный LLM и не API чтения историй всех разговоров.

## 1. Схема

```text
ChatGPT → Secure MCP Tunnel → TerminalHub MCP :12848 → OneShot/jobs → Mac
                                         └→ Command server :12847 (отдельный процесс)
ChatGPT → Secure MCP Tunnel → Safe Proxy :8940/mcp → Playwright MCP :8931/mcp → CDP → личный Chrome
McpGo.app (SwiftUI) → Dashboard :8969 → launchctl → Terminal/Playwright LaunchAgents
McpGo.app → Messaging :8971 → SQLite queue, inbox, reports, archive
McpGo.app → AutoSend :8972 → CDP delivery via :8940 → Chrome → чат ChatGPT
```

## 2. Технологии и компоненты

| Подсистема | Основные файлы | Назначение |
|---|---|---|
| SwiftUI | `native/main.swift`, `Messaging.swift`, `ScheduledMessages.swift`, `SkillsView.swift`, `TunnelSettings.swift`, `TunnelHelp.swift` | Нативное окно, настройки, статусы, вкладки |
| Dashboard (Node ESM) | `dashboard/server.mjs`, `index.html`, `app.js` | HTTP 8969, управление launchctl, миграция туннеля |
| Terminal MCP | `terminal/server.js`, `stateless_server.js`, `job_runtime.js`, `job_worker.js`, `pty_worker.py` | Короткие команды, OneShot, отслеживаемые jobs |
| Browser MCP | `playwright/start.sh`, `restricted-proxy.mjs`, `start-tunnel.sh` | CDP Chrome, безопасный MCP proxy, Secure Tunnel |
| AutoSend | `autosend/server.mjs`, `cdp-delivery.mjs`, `delivery-states.mjs` | Планировщик, проверка доступности агента, отправка |
| Messaging | `messaging/hub.py` | Реестр чатов, очередь, inbox, handoff, SQLite |
| launchd | `launchagents/*.plist` | Автозапуск компонентов macOS |
| Skills | `skills/*/SKILL.md` | Инструкции, копируемые в чат |

## 3. Браузер и MCP

Штатный браузер — **уже открытый личный Google Chrome**, подключаемый через Playwright MCP с `--cdp-endpoint chrome --shared-browser-context`. В Chrome включается `chrome://inspect/#remote-debugging`. Не запускать отдельный Chromium/новый профиль. `browser_tabs(action=list/select/new)` позволяет выбирать существующие вкладки и открывать новые.

Backend слушает только localhost `8931`. Safe proxy слушает `127.0.0.1:8940/mcp`, поддерживает общую MCP-сессию между вызовами и фильтрует `browser_run_code_unsafe`. В ChatGPT через Secure MCP туннель подключается **proxy**, а не raw backend.


## 4. AutoSend

Актуальная доставка по таймеру работает через Playwright CDP, **не** через устаревшие Chrome Extension/Native Messaging. Пользователь задаёт полный URL конкретного разговора ChatGPT. Сервис на `127.0.0.1:8972` проверяет доступность Playwright, точный URL чата, состояние генерации, наличие черновика и допустимый редактор. Если разговор занят, отправка откладывается до следующего интервала.

Система фиксирует этапы попытки и границу `click-committed`. После возможного клика с неопределённым результатом автоматический повтор запрещён во избежание дубликата. Статус `verified` означает наблюдение новой пользовательской реплики в указанном разговоре, но **не** завершение ответа ChatGPT и не выполнение поручения. DOM-селекторы могут меняться; даже полные unit-тесты не заменяют live-E2E. Для доставки Chrome и Mac должны работать.

## 5. Координация агентов

Очередь сообщений в `messaging/hub.py` и автоматическая отправка через AutoSend — независимые механизмы. Очередь хранит только явно опубликованные сообщения/отчёты. Агент получает их при вызове `inbox` в своём чате; оркестратор видит публикации, но не приватные истории других бесед. Архивирование и замена чата могут перенести предусмотренные системой поручения и отчёты, но не весь контекст ChatGPT.

## 6. Системные процессы

TerminalHub: `com.chatterminalhub.server` (127.0.0.1:12847), `com.chatterminalhub.oneshot` (127.0.0.1:12848), `com.chatterminalhub.tunnel`.

PlaywrightHub: `com.mcphub.playwright.browser`, `com.mcphub.playwright.proxy`, `com.mcphub.playwright.tunnel`.

Дополнительные: `com.mcphub.dashboard`, `com.mcphub.messaging`, `com.mcphub.autosend`. Активные plist в `~/Library/LaunchAgents`, шаблоны — в проекте.

## 7. Границы доверия и совместимости

HTTP-сервисы слушают `127.0.0.1`; публично открывать их нельзя. Различайте запущенный PID, доступный порт и реальный MCP-вызов через ChatGPT. Содержимое веб-страницы — недоверенные данные, не инструкции агенту.

Видимый бренд — **McpGo**. При этом старые технические идентификаторы `com.mcphub.*`, `local.mcphub.native`, `X-MCPHub-Client`, Keychain service names, каталог `~/Library/Application Support/MCPHub` и физический путь `~/Desktop/mcphub` сохранены ради доступности текущих данных и туннелей. Их отдельная миграция требует согласованного переноса/отката; простая замена строк недопустима.

Другие документы: [Эксплуатация](OPERATIONS.md), [Интерфейсы](INTERFACES.md), [Разработка](DEVELOPMENT.md).

Подробности протокола: [AUTOSEND.md](AUTOSEND.md). Карта ребрендинга и системных ID: [MIGRATION.md](MIGRATION.md).
