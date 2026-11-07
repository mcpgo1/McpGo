# Быстрый старт и первая настройка McpGo

## Новый мастер первого запуска

Откройте McpGo.app или дважды нажмите «Запустить McpGo.command».
Вкладка «Первое подключение» проведёт через проверки, управление
OpenAI Secure MCP Tunnel, Chrome и подключение ChatGPT.
Все устанавливающие действия требуют явного подтверждения.
Restricted runtime key сохраняется в Keychain, административный — нет.
При другой установленной копии автоматическая перезапись заблокирована.

Полный runbook: [ONBOARDING.md](ONBOARDING.md).

## Поддерживаемая среда

- **macOS 14+**, текущая сборка `arm64`. Другие платформы в исходниках не заявлены.
- **Xcode с macOS SDK** для нативной SwiftUI сборки; `xcrun swiftc`, `codesign`, `iconutil`.
- **Node.js** для Dashboard, AutoSend, terminal components и Playwright wrapper. Точный поддерживаемый диапазон Node пока не объявлен отдельной CI-матрицей; зафиксируйте его перед переносимым публичным релизом.
- **Python 3** для SQLite messaging и вспомогательных процессов.
- **Обычный Google Chrome** с поддержкой CDP через встроенную страницу remote debugging.
- `@playwright/mcp` в `playwright/node_modules`, установленный через `npm ci`.
- OpenAI `tunnel-client` и **два зарегистрированных Secure MCP tunnels** для удалённого MCP-доступа. Сам McpGo не создаёт ChatGPT workspace автоматически.

## Текущая установка и переносимость

В существующей установке McpGo физическая рабочая директория — `<INSTALL_ROOT>`, а `McpGo.app` использует старый совместимый `CFBundleIdentifier`. **Сейчас это рабочая локальная сборка, а не готовый универсальный дистрибутив**. Прежде чем пытаться копировать приложение на другой Mac, необходимо параметризовать оставшиеся абсолютные пути в SwiftUI, dashboard и шаблонах launchd (см. [MIGRATION.md](MIGRATION.md)).

Код Playwright больше **не проверяет Git-проект или ветку внешнего приложения**: `playwright/start.sh`, `start-tunnel.sh` и `configure-tunnel.sh` вычисляют свой каталог по расположению скрипта. Для установки зависимостей:

```bash
cd /path/to/McpGo/playwright
npm ci
bash -n start.sh start-tunnel.sh configure-tunnel.sh
node --check restricted-proxy.mjs
```

Это подготовка браузерного модуля, **не** установка всей программы. В общей установке дополнительно должны быть зарегистрированы LaunchAgents из `launchagents/`, установлены terminal runtime и подходящий tunnel-client. Перед регистрацией plist проверьте и замените существующие абсолютные пути и пользователя, затем выполняйте `plutil -lint`. Не создавайте параллельно второй экземпляр AutoSend на той же базе.

## Запуск приложения

Откройте `McpGo.app` или `Открыть McpGo.command`. В разделе «Обзор» проверьте три службы TerminalHub и три PlaywrightHub. Служба Dashboard автоматически обслуживает `http://127.0.0.1:8969`; статусы обновляются из локального API.

Терминальные LaunchAgents:
- `com.chatterminalhub.server` — команды Mac;
- `com.chatterminalhub.oneshot` — OneShot и jobs;
- `com.chatterminalhub.tunnel` — внешний Secure MCP Tunnel.

Браузерные LaunchAgents:
- `com.mcphub.playwright.browser` — backend 8931;
- `com.mcphub.playwright.proxy` — safe proxy 8940;
- `com.mcphub.playwright.tunnel` — внешний Secure MCP Tunnel.

Дополнительные службы: `com.mcphub.dashboard` (8969), `com.mcphub.messaging` (8971), `com.mcphub.autosend` (8972).

## Chrome CDP

1. Откройте **обычный Chrome со своими вкладками**.
2. Перейдите на `chrome://inspect/#remote-debugging`.
3. Включите **Allow remote debugging for this browser instance**.
4. Запустите три компонента PlaywrightHub через McpGo.
5. Подключите PlaywrightHub в ChatGPT и выполните безопасный `browser_tabs({action:"list"})`.

По умолчанию Playwright использует общий контекст Chrome (`--shared-browser-context`). Новая вкладка создаётся только при необходимости; существующую можно выбрать через `browser_tabs`. При каждом новом attach Chrome может запрашивать подтверждение. Proxy сохраняет общую MCP-сессию, уменьшая повторные предупреждения; обходить системный запрос разрешения нельзя.

## Настройка Secure MCP tunnels

Для каждого из двух контуров:
1. Создайте или выберите отдельный Secure MCP Tunnel в соответствующей организации OpenAI и свяжите его с нужным workspace.
2. Задайте Tunnel ID и runtime key через вкладку «Настройки туннелей».
3. Проверьте профиль tunnel-client и локальный адрес endpoint: браузерный tunnel направляется на **`http://127.0.0.1:8940/mcp`**, не на 8931.
4. Проверьте подключение вызовом реального MCP-инструмента из ChatGPT, а не только зелёным статусом процесса.

Существующая установка использует macOS Keychain/локальные настройки и сохраняет идентификаторы совместимости. Подробные текущие пути — [CONFIGURATION.md](CONFIGURATION.md).

## Проверка готовности

```bash
launchctl list | grep -E 'com.chatterminalhub|com.mcphub'
curl -fsS http://127.0.0.1:8969/api/status
```

Для Messaging/AutoSend локальный native API принимает специальный заголовок и ограничивает обращения по Host/Origin. Не рассматривайте отказ `curl` без подходящего контекста как отказ самого сервиса.

**Функциональное подтверждение:** `terminal_exec` из ChatGPT возвращает exit 0 для безопасной команды; `browser_tabs(action=list)` из PlaywrightHub показывает реальные вкладки. Для планировщика отдельно проверяйте статус CDP и только с явным разрешением выполняйте тестовую отправку в специально выделенный чат.

## Что не делает первый запуск

Он не мигрирует автоматически чужие браузерные профили, не импортирует содержимое ChatGPT, не регистрирует новые workspace и не включает ранее выключенные расписания AutoSend. Все эти действия требуют отдельной настройки.
