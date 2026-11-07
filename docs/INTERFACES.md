# McpGo — сетевые интерфейсы, данные и контракты

Актуально: 06.11.2026. Фактические тела запросов и обработка ошибок определяются исходным кодом указанных HTTP handlers. Таблица — карта навигации, а не формальная OpenAPI schema.

## Локальные порты

| Порт | Протокол и сервис | Основные маршруты |
|---|---|---|
| 12847 | HTTP Terminal command MCP | отдельный stateful endpoint, GET /health |
| 12848 | HTTP Terminal OneShot MCP | MCP tools + GET /health |
| 8931 | HTTP MCP Playwright backend | POST /mcp; raw backend, только локально |
| 8940 | HTTP MCP Safe Proxy | POST /mcp; MCP session sharing / tool filtering |
| 8969 | HTTP Dashboard | GET /api/status, POST /api/action |
| 8971 | HTTP Messaging | GET /api/status, /api/agents, /api/inbox, /api/history; POST /api/messages, /api/ack и управление агентами |
| 8972 | HTTP AutoSend | GET /api/status; POST /api/tasks; legacy /api/extension/* для совместимости |
Все listener-порты назначены loopback 127.0.0.1. Наличие legacy extension routes **не** означает, что расширение остаётся текущим каналом доставки; в работающем AutoSend используется `cdp-delivery.mjs`.

## Терминальный MCP

`terminal_exec({command,cwd?,timeout_ms?})` — единичная команда, 90 секунд максимум, проверка `exit_code`, `timed_out`, `spawn_error`. Не хранит постоянную оболочку.

`job_start({command,cwd?,timeout_ms?})` — асинхронная detached-задача до 4 часов, возвращает идентификатор; `job_status({job_id})` сообщает состояние/exit code, `job_logs({job_id,tail_lines?,max_chars?})` возвращает ограниченные последние сообщения. Успешный start не является PASS, а повтор после timeout/unknown может дать побочный эффект.

## Браузерный MCP

Основные операции: `browser_tabs({action:"list"|"select"|"new", index?, url?})`, `browser_navigate`, `browser_snapshot` и другие разрешённые инструменты Playwright MCP. Таблица индексов вкладок может обновляться между вызовами, поэтому сначала list, потом select; proxy прогревает индексы при смене сессии. Отдельный список запрещённых инструментов задаётся в `playwright/restricted-proxy.mjs`.

## Messaging

`messaging/hub.py` содержит команды `agents`, `inbox --as`, `send --as --to --text`, `report --as --text`, `ack --as MESSAGE_ID`, `history --as`, `archive`, `restore`, `replace`. Локальная БД `messaging/data/messages.sqlite3`, SQLite WAL и явные отметки доставки. Веб-пути и поля сверять с функциями HTTP handler в `hub.py`. Уровень доступа локальных вызовов — не криптографическая изоляция агентов с полным shell-доступом.

## AutoSend

Точный URL обычного или проектного чата — обязательная идентичность адресата. Система проверяет DOM, не перехватывает внутренний ChatGPT API. Стадии: подготовка → проверка браузера/цели → проверка редактора → click-committed → наблюдение результата. `verified` не означает завершение ответа. `busy` откладывает попытку; `unknown` запрещает автоматическое повторение после возможной отправки.

## Persistency

- `messaging/data/messages.sqlite3`: реестр, отправленные сообщения, отчёты, подтверждения и архивирование.
- `~/Library/Application Support/MCPHub/AutoSend`: расписания и журнал попыток; старое имя каталога оставлено для совместимости.
- `playwright/.cache/tunnel.id` и настройки tunnel-client: конфигурация подключения Playwright.
- `~/Library/Application Support/ChatTerminalHub/run-tunnel.sh`: исполняемый скрипт terminal tunnel.
- `~/Library/LaunchAgents/*.plist`: действующие настройки запуска; project templates не заменяют их автоматически.
- `McpGo.app/Contents/Resources/skills/*/SKILL.md`: встроенные тексты, приоритетные в интерфейсе.

## Контракты совместимости

Не изменять без миграции: `com.mcphub.*` labels, `local.mcphub.native` bundle ID, `X-MCPHub-Client` заголовок, Keychain service identifiers, абсолютный путь исходного каталога и исходные имена баз/каталогов. McpGo — публичное имя проекта и UI; внутренние legacy ID не являются ошибкой переименования.


---

## Подробные HTTP-контракты (проверены по исходным обработчикам)

### Dashboard — `dashboard/server.mjs`, порт 8969

**Read-only запрос:**

```http
GET /api/status HTTP/1.1
Host: 127.0.0.1:8969
```

Успешный ответ — JSON:

```json
{
  "busy": false,
  "terminal": {
    "server": {"loaded": true, "running": true, "pid": 123},
    "oneshot": {"loaded": true, "running": true, "pid": 124},
    "tunnel": {"loaded": true, "running": true, "pid": 125}
  },
  "playwright": {
    "browser": {"loaded": true, "running": true, "pid": 126},
    "proxy": {"loaded": true, "running": true, "pid": 127},
    "tunnel": {"loaded": true, "running": true, "pid": 128},
    "backend": true,
    "proxyReady": true,
    "configured": true
  },
  "updatedAt": "2026-11-07T00:00:00.000Z"
}
```

Значения PID/времени **иллюстративные**. `loaded` означает launchd registration, `running` — обнаруженный PID, `backend/proxyReady` — результат TCP connect, `configured` — наличие конфигурации. **Это не успешный внешний MCP tools/call.**

Управление:

```http
POST /api/action HTTP/1.1
Host: 127.0.0.1:8969
Origin: http://127.0.0.1:8969
X-MCP-Hub: dashboard
Content-Type: application/json

{"group":"playwright","action":"restart"}
```

Варианты `group`: `terminal`, `terminal-tunnel`, `playwright`; `action`: `start`, `stop`, `restart`. Отдельные локальные system actions для папки/журналов обрабатываются в том же endpoint. Записи блокируются при `busy`; ответ может быть `409` или `403` при неверном Origin/header, а реальный сбой запуска — `500`.

**Важное:** этот пример показывает формат, а не рекомендует менять работающий Browser Tunnel при любой проблеме.

### Messaging — `messaging/hub.py`, порт 8971

Локальный backend **не** является обычным публичным REST. Для доступа native UI указывает `X-MCPHub-Client: native`, `Host` должен быть loopback:8971, browser `Origin` отвергается.

Read-only пример:

```bash
curl -fsS -H 'X-MCPHub-Client: native' \
  http://127.0.0.1:8971/api/status
```

Ответ содержит `ok`, `agents`, `messages`, `orchestrator`. Для списков `GET /api/agents`, `GET /api/history?viewer=...`, `GET /api/inbox?agent=...`. Параметр `limit` ограничивает число записей и дополнительно нормализуется в backend.

Изменяющие операции передают `Content-Type: application/json` и тот же native header. Примеры тел:
- `POST /api/agents`: `{"id":"agent_a","label":"Agent A","role":"agent","chat_url":""}`.
- `POST /api/messages`: `{"sender":"agent_a","recipient":"agent_b","body":"...","kind":"message"}`.
- `POST /api/ack`: `{"agent":"agent_b","ids":[101]}`.
- `POST /api/agents/replace`: `{"old_id":"agent_a","id":"agent_next","label":"New chat","chat_url":"https://chatgpt.com/c/..."}`.

Соответствующие правила агента, роли, архива и подтверждения описаны в [MESSAGING.md](MESSAGING.md). Размер POST body ограничен **26000** байт. Invalid host/client: `403`; неверный Content-Type: `415`; неверный payload/запись: `400`; успешная регистрация: `201`.

### AutoSend — `autosend/server.mjs`, порт 8972

Тот же native client header: `X-MCPHub-Client: native`. Некоторые `/api/extension/*` маршруты остались от прежнего транспорта, но **текущий scheduler использует Playwright CDP** и не требует extension как пути доставки.

Read-only запрос:

```bash
curl -fsS -H 'X-MCPHub-Client: native' \
  http://127.0.0.1:8972/api/status
```

Ответ содержит `ok`, `tasks`, последние `attempts`, `deliverySupported`, `deliveryReason`, `busyTask`, `serverTime` и совместимые исторические поля об extension status. Текущий `extensionTransport` отображает `Playwright CDP`.

Запись производится `POST /api/tasks`, где `action` — одна из:
- `create`: `url`, `message`, `interval_seconds`; новая задача создаётся **paused**;
- `update`: `id` + новые настройки; переводит в paused;
- `start`: `id`; планирует следующий interval, запрещён при `unknown`;
- `pause`: `id`; недоступен в активной фазе sending/checking;
- `remove`: `id`; удаляет task (не обязательно прошлые attempts);
- `clear_history`: очищает `attempts`;
- `send_once`: `id`; ставит однократную отправку, **не** равен немедленному подтверждённому клику.

Формат нового расписания:

```json
{
  "action": "create",
  "url": "https://chatgpt.com/c/00000000-0000-0000-0000-000000000000",
  "message": "Нейтральное тестовое сообщение",
  "interval_seconds": 3600
}
```

URL здесь **синтетический и не является действующим разговором**. API validate: только `https://chatgpt.com/c/UUID` или `/g/g-p-.../c/UUID`; text длиной 1–8000 символов, interval 60–604800 секунд. Размер JSON request до **30000** байт. Создание/включение задачи — это запись в локальное хранилище, не отправка сообщения в ChatGPT.

### Terminal stateful — `terminal/server.js`

Слушает `127.0.0.1:12847`. Предоставляет `GET /health`, локальную dashboard UI и HTTP/MCP routing по private path из локальной конфигурации. Для доступа к `/api/sessions` используется отдельный admin capability, а для конкретной сессии — session key. Не копируйте активные private paths и session credentials в публичные примеры.

MCP tools: `terminal_create`, `terminal_send`, `terminal_read`, `terminal_interrupt`, `terminal_close`. Протокол JSON-RPC 2.0 и MCP initialize включают `tools/list` и `tools/call`.

### Terminal OneShot — `terminal/stateless_server.js`

Слушает `127.0.0.1:12848`, имеет `GET /health` и приватный MCP route. `terminal_exec`, `job_start`, `job_status`, `job_logs` возвращают отдельные структурированные результаты.

**Нельзя** предполагать публичный root `/mcp` только по номеру порта: точный путь зависит от локального конфигурационного файла.

### Browser backend и proxy — MCP over HTTP

`@playwright/mcp`: `127.0.0.1:8931/mcp`.
`restricted-proxy.mjs`: `127.0.0.1:8940/mcp`.

Proxy обрабатывает MCP `initialize`, `tools/list`, `tools/call` и связанные session operations. Он сохраняет upstream session ID, скрывает `browser_run_code_unsafe`, обновляет индексы перед select/close. Это **не публичный general-purpose HTTP proxy**.

## Ошибки и правильная интерпретация

| Код/состояние | Значение | Правильная реакция |
|---|---|---|
| HTTP 403 | Неверный Host/Origin/header либо forbidden tool | Не отключать защиту, проверить вызывающую сторону |
| HTTP 404 | Неизвестный маршрут | Сверить API и HTTP method |
| HTTP 409 | Dashboard action уже выполняется | Не дублировать команду |
| HTTP 415 | Некорректный Content-Type | Использовать JSON с правильным header |
| HTTP 502 | Не отвечает browser backend/инициализация proxy | Проверить upstream, Chrome CDP и logs |
| `job_status: unknown` | Нет достоверного completion receipt | Проверить побочный эффект |
| `AutoSend: unknown` | После потенциального клика нет подтверждения | Не повторять автоматически |
| `AutoSend: deferred` | До клика задача отложена | Проверить занятость/URL/DOM |
| `AutoSend: verified` | В нужной вкладке наблюдена пользовательская реплика | Не путать с завершением ответа агента |

### API versioning gap

У локальных HTTP API нет единой публичной OpenAPI/JSON Schema спецификации, покрывающей все endpoints и field validation. До первого открытого релиза требуется сгенерировать schema и контрактные тесты; текущие source handlers остаются нормативным описанием поведения.
