# McpGo — эксплуатация и восстановление

Актуальность: 06.11.2026. Все команды ниже предназначены для Mac владельца; **не** запускайте на другом хосте без проверки путей.

## Требования

macOS 14+, arm64 для нативной сборки, Xcode/macOS SDK, Node.js для сервисов, Python 3 для обмена агентами, личный Google Chrome, Playwright MCP и OpenAI tunnel-client. LaunchAgents выполняются в `gui/$(id -u)` обычного пользователя, а не системного root-контекста.

## Папки

- Физический путь проекта: `<INSTALL_ROOT>`. Точка входа после ребрендинга: `McpGo.app`; старое `MCP Hub.app` оставлено как alias совместимости.
- Активные LaunchAgent plist: `~/Library/LaunchAgents`; шаблоны: `launchagents/`.
- Исполняемый скрипт терминального туннеля: `~/Library/Application Support/ChatTerminalHub/run-tunnel.sh`, с доступом владельцу.
- Агентская SQLite БД: `messaging/data/messages.sqlite3`.
- Данные AutoSend: `~/Library/Application Support/MCPHub/AutoSend` (старый идентификатор сохранён).
- Фактические логи — в путях `StandardOutPath`/`StandardErrorPath` соответствующих plist.

## Службы

| Служба | Назначение |
|---|---|
| com.chatterminalhub.server | Command server |
| com.chatterminalhub.oneshot | OneShot / jobs |
| com.chatterminalhub.tunnel | Secure MCP Terminal |
| com.mcphub.playwright.browser | Playwright MCP CDP backend :8931 |
| com.mcphub.playwright.proxy | Safe MCP proxy :8940 |
| com.mcphub.playwright.tunnel | Secure MCP Browser |
| com.mcphub.dashboard | Dashboard :8969 |
| com.mcphub.messaging | Agent messaging :8971 |
| com.mcphub.autosend | Scheduled messages :8972 |

## Стандартная диагностика

```bash
curl -fsS http://127.0.0.1:12847/health
curl -fsS http://127.0.0.1:12848/health
launchctl list | grep -E 'com.chatterminalhub|com.mcphub'
launchctl print "gui/$(id -u)/com.chatterminalhub.tunnel"
curl -fsS http://127.0.0.1:8969/api/status
curl -fsS -H 'X-MCPHub-Client: native' http://127.0.0.1:8971/api/status
curl -fsS -H 'X-MCPHub-Client: native' http://127.0.0.1:8972/api/status
```

Затем проверьте реальные read-only инструменты **из ChatGPT**: `terminal_exec` и `browser_tabs(action=list)`. Наличие процесса или открытого порта не доказывает работоспособность Secure MCP до ChatGPT.

## Исправление терминального туннеля

При коде `127` проверьте `launchctl print`, активный plist и stderr. Проблема 06.11.2026: LaunchAgent запускал `run-tunnel.sh` напрямую с Desktop, что приводило к ошибке открытия файла, хотя вручную скрипт работал. Теперь Dashboard обеспечивает миграцию: скрипт копируется в Application Support, `ProgramArguments:0` обновляется, `WorkingDirectory` Desktop удаляется, plist проверяется и служба перерегистрируется.

Используйте кнопку рестарта McpGo; для существующего процесса допустимо:
```bash
launchctl kickstart -k "gui/$(id -u)/com.chatterminalhub.tunnel"
```
Если изменён сам plist, может потребоваться `bootout` + `bootstrap`. Это может прервать действующий MCP доступ, поэтому делайте только когда можно восстановить управление. Не подставляйте путь в индекс `ProgramArguments:1`: единственный элемент — индекс 0.

## Ошибки Playwright

Проверьте `chrome://inspect/#remote-debugging` (Allow remote debugging for this browser instance), запуск обычного Chrome, процессы backend :8931, proxy :8940 и browser tunnel. Не запускайте отдельный Chromium. `PlaywrightHub` использует уже открытые пользовательские вкладки. Проверяйте end-to-end через реальный `browser_tabs`.

## Ошибки AutoSend

Проверьте `com.mcphub.autosend`, `127.0.0.1:8972/api/status`, подключение к `:8940/mcp` и точный URL разговора. Состояние busy — повод дождаться нового интервала; unknown после возможного клика не повторять автоматически. Расписание и историю не удалять ради проверки. Отправка в рабочий чат без согласования не является безопасным тестом.

## Резервные копии, обновление, откат

1. Сохраните bundle, существующие plist, messaging SQLite (для согласованного бэкапа — после остановки writers либо SQLite backup API), данные AutoSend и настройки туннелей.
2. Проверьте линтеры, unit-тесты, Swift сборку, подпись, синхронность встроенных SKILL.md.
3. Обновите подписанный bundle и перезапустите приложение. Перезапускайте службы по одной, проверяя реальные read-only вызовы.
4. При сбое верните bundle/plist из backup, сохраните данные пользователей и не перезаписывайте их старым форматом.
5. Менять старые системные ID без отдельного migration plan запрещено: они составляют часть действующего конфигурационного контракта.
