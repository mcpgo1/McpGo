# McpGo PlaywrightHub

## Рабочая архитектура

PlaywrightHub запускает `@playwright/mcp` в **обычном уже работающем Google Chrome** через CDP. Вариант с запуском отдельного Chromium и отдельным профилем не используется в текущей конфигурации.

```text
ChatGPT → browser Secure MCP Tunnel → Safe Proxy :8940/mcp
                                         → Playwright backend :8931/mcp
                                         → Chrome CDP → открытые вкладки
McpGo AutoSend :8972 ───────────────────┘
```

## Исполняемые файлы

- `start.sh`: старт `@playwright/mcp` с `--cdp-endpoint chrome --shared-browser-context`, localhost 8931, navigation timeout 45000 ms.
- `restricted-proxy.mjs`: localhost 8940, единая upstream MCP session, фильтрация `browser_run_code_unsafe`, синхронизация индексов вкладок.
- `start-tunnel.sh`: проверка proxy, запуск tunnel-client на `http://127.0.0.1:8940/mcp`.
- `configure-tunnel.sh`: интерактивная настройка выделенного Browser Tunnel ID. Скрипты вычисляют расположение текущего модуля по своему пути и не зависят от Git checkout другого проекта.
- `probe.mjs`, `smoke.mjs`, `test-access.mjs`: проверочные сценарии.
- `package.json`, `package-lock.json`: Node пакет и закреплённая версия @playwright/mcp.

## Предусловия

1. В обычном Chrome открыть `chrome://inspect/#remote-debugging` и включить удалённую отладку.
2. Установить зависимости: `npm ci` в текущем каталоге.
3. Убедиться, что действующие LaunchAgents `com.mcphub.playwright.browser`, `com.mcphub.playwright.proxy`, `com.mcphub.playwright.tunnel` соответствуют активным путям.
4. В ChatGPT использовать **PlaywrightHub** через безопасный proxy, не raw backend.
5. Реальный тест: `browser_tabs({action:"list"})`, затем при необходимости `action:"select"`.

## Семантика сессий и вкладок

Backend работает в shared browser context. Safe proxy объединяет короткие внешние MCP-сеансы на одной backend-сессии, чтобы Chrome не просил разрешение отладки при каждом вызове. Таблица индексов вкладок может быть переинициализирована между запросами, поэтому proxy прогревает `browser_tabs list` перед select/close. Индекс — временная позиция, а не долговременный ID разговора.

## Неполадки

- Невозможно подключиться: проверьте running Chrome, разрешение CDP, порт 8931, затем 8940 и browser tunnel.
- Частые запросы разрешения Chrome: проверьте shared-session proxy; после его перезапуска один системный запрос может быть нормальным.
- Пустой список вкладок: убедитесь, что подключены к правильному личному Chrome, а не другому профилю/приложению.
- Если работает 8931, но ChatGPT не видит инструмент: проверьте proxy и туннель, затем workspace association.

Дополнительно: [архитектура](../docs/ARCHITECTURE.md), [API](../docs/INTERFACES.md), [операции](../docs/OPERATIONS.md), [AutoSend](../docs/AUTOSEND.md).
