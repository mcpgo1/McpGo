> **McpGo · 06.11.2026:** актуальные архитектура и процедуры: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), [docs/OPERATIONS.md](../docs/OPERATIONS.md), [docs/INTERFACES.md](../docs/INTERFACES.md). Дальнейший материал может описывать исторические версии. Рабочий AutoSend использует Playwright CDP в личном Chrome; системные идентификаторы mcphub сохранены для совместимости.

# Как получить Tunnel ID и runtime API key для MCP Hub

Актуализировано 30 октября 2026 года по [официальному руководству OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

В `MCP Hub.app` откройте **Настройки туннелей**, затем **Инструкция** рядом с TerminalHub или Playwright. В приложении есть отдельное пошаговое окно для каждого туннеля и активные кнопки со ссылками. Этот документ — локальная копия ключевых шагов для восстановления настроек.

## 1. Организация и права

Откройте [Organization roles](https://platform.openai.com/settings/organization/people/roles) и выберите нужную организацию OpenAI Platform и связанное рабочее пространство ChatGPT. Для управления туннелями нужны **Tunnels Read + Manage**, для запуска `tunnel-client` и выбора туннеля в ChatGPT — **Tunnels Read + Use**. Если права отсутствуют, попросите владельца организации назначить их через Roles/Groups. Применение новых ролей может занять до 30 минут.

## 2. Создайте два туннеля

На странице [Platform → Organization → Tunnels](https://platform.openai.com/settings/organization/tunnels) выберите **Create tunnel**. Для терминала используйте название **MCP Hub — TerminalHub**, для браузера — **MCP Hub — Playwright**. Описание, например, «Private MCP on my Mac». Ассоциируйте туннель с организацией Platform и правильным пространством ChatGPT. Скопируйте созданный `tunnel_…`. Если уже существует правильно привязанный туннель, повторно создавать его не требуется.

Туннель исходящий, **не требует публичного домена, проброса портов или нового локального MCP-сервера**. Для TerminalHub локальный MCP уже настроен в профиле `chat-terminal-hub`, для Playwright — Safe proxy `http://127.0.0.1:8940/mcp` (не 8931).

## 3. Создайте runtime API-ключ

На странице [Platform → Organization → Runtime API keys](https://platform.openai.com/settings/organization/api-keys) создайте два ключа с названиями **MCP Hub TerminalHub runtime** и **MCP Hub Playwright runtime**. Выберите **Restricted**, установите разрешения **Tunnels: Read + Use**. Не выбирайте All permissions. **Organization Admin API key** для обычной работы туннеля НЕ нужен и не должен использоваться вместо runtime-ключа. Секрет может быть доступен для копирования только при создании; вставляйте его напрямую в MCP Hub, не публикуйте в ChatGPT или в Git.

## 4. Сохраните значения в MCP Hub

В карточке соответствующего туннеля укажите его собственный `tunnel_id` и новый runtime API-ключ → **Сохранить**. API-ключ хранится в Связке ключей macOS, интерфейс не показывает действующий секрет. При смене только Tunnel ID оставьте поле нового ключа пустым. TerminalHub хранит ID в `~/.config/tunnel-client/chat-terminal-hub.yaml`, Playwright — в `mcphub/playwright/.cache/tunnel.id`. Старые значения изменяются только после явного нажатия «Сохранить».

## 5. Переподключите только нужный туннель

Нажмите **Переподключить туннель** и подтвердите. Через **Обзор** проверьте локальные процессы. Перезапуск TerminalHub может ненадолго прервать доступ текущего чата ChatGPT к Mac. На стороне сети необходим исходящий HTTPS `api.openai.com:443`.

## 6. Подключите туннели в ChatGPT

Откройте [ChatGPT → Plugins / Settings](https://chatgpt.com/#settings/Connectors), выберите **+ → Add custom MCP server**. Для имени укажите **ChatTerminalHub** или **PlaywrightHub**. В Connection выберите **Tunnel**, а не Server URL; выберите нужный туннель или вставьте `tunnel_…`. Настройки Authentication задаются по требованиям MCP-сервера — это **не** runtime API-ключ tunnel-client. Подтвердите предупреждение о рисках и завершите создание плагина. Если плагин уже существует, проверьте его привязку, а не создавайте дубликат.

## 7. Проверьте работу

В ChatGPT откройте соответствующий плагин и сделайте безопасный тестовый MCP-вызов. Если туннель не виден в ChatGPT, проверьте ассоциацию рабочего пространства и разрешения Tunnels Read + Use. Если инструменты не отображаются, проверьте готовность `tunnel-client`, журналы соответствующего туннеля и [официальное руководство](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Надпись «Процесс запущен» в панели — не гарантия подключения к OpenAI.

**Приватность:** не копируйте `*.key` или API-ключ в документацию и не отправляйте его через чат. Инструкции не раскрывают сохранённые ключи. Внешние страницы OpenAI могут менять формулировки интерфейса; сверяйте с официальной документацией.
