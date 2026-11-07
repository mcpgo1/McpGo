# McpGo — компонентная архитектура (source-level)

Этот документ привязывает ответственность к **конкретным файлам**. Он не является перечнем обещаний на сайте. Путь каждого модуля указан относительно корня McpGo.

## 1. Runtime и границы

```mermaid
flowchart LR
  UI["native/*.swift"] --> DASH["dashboard/server.mjs"]
  DASH --> LAUNCH["launchd / installed plist"]
  LAUNCH --> TERM["terminal/*.js"]
  LAUNCH --> WEB["playwright/*.mjs"]
  LAUNCH --> AUT["autosend/server.mjs"]
  UI --> MSG["messaging/hub.py HTTP"]
  UI --> AUT
  AUT --> PX["restricted-proxy.mjs"]
  PX --> CDP["@playwright/mcp"]
  CDP --> CH["Личный Chrome"]
```

| Слой | Состав | Зона ответственности | Чего не делает |
|---|---|---|---|
| View | `native/main.swift` и View-файлы | UI, запроса status/action, выбор агента | Не управляет напрямую внешним MCP |
| Dashboard | `dashboard/server.mjs` | `launchctl`, проверка PID/портов, миграция terminal tunnel plist | Не является полным менеджером пакетов |
| Stateful terminal | `terminal/server.js` + `pty_worker.py` | PTY-сессии, input/read/interrupt/close | Не возвращает synchronous exit code на каждый send |
| Stateless terminal | `terminal/stateless_server.js` | Одноразовые команды и MCP job tools | Не сохраняет интерактивную оболочку |
| Job runtime | `terminal/job_runtime.js`, `job_worker.js` | Detached subprocess, status и лог-файлы | Не гарантирует success по факту создания job |
| Browser MCP | `playwright/start.sh`, `@playwright/mcp` | Работа с пользовательским Chrome CDP | Не запускает отдельный Chromium штатно |
| Browser proxy | `playwright/restricted-proxy.mjs` | Shared session, MCP filtering, tab-index warmup | Не является web firewall |
| AutoSend | `autosend/core.mjs`, `server.mjs`, `cdp-delivery.mjs` | Очередь расписаний, DOM state, клик, итог | Не проверяет завершение ответа агента |
| Messaging | `messaging/hub.py`, `start.mjs` | Локальный реестр агентов/очередь/ack | Не раскрывает закрытый transcript |
| Tunnels | `terminal/run-tunnel.sh`, `playwright/start-tunnel.sh`, launcher wrappers | Outbound MCP transport | Не выполняет CLI разрешения пользователя за него |
| OS lifecycle | `launchagents/*.plist` | Запуск и restart после входа/сбоев | Не гарантирует CDN/backend uptime |

## 2. Последовательности вызовов

**Проверка состояния из окна:**

```mermaid
sequenceDiagram
    participant U as User
    participant S as SwiftUI HubModel
    participant D as Dashboard :8969
    participant L as launchctl
    U->>S: Открывает «Обзор»
    S->>D: GET /api/status
    D->>L: print gui/UID/LABEL
    L-->>D: loaded, pid
    D->>D: TCP connect :8931/:8940
    D-->>S: JSON status
    S-->>U: Статус компонентов
```

**Команда через Terminal OneShot:**

```mermaid
sequenceDiagram
    participant G as MCP client
    participant T as Terminal Tunnel
    participant O as stateless_server :12848
    participant Z as zsh
    G->>T: tools/call terminal_exec
    T->>O: JSON-RPC
    O->>Z: spawn command
    Z-->>O: stdout/stderr/exit
    O-->>T: structured result
    T-->>G: tool result
```

**Расписание AutoSend:**

```mermaid
sequenceDiagram
    participant J as Scheduler
    participant P as Safe proxy :8940
    participant B as Playwright backend
    participant C as Chrome
    J->>P: tools/call browser_tabs(list)
    P->>B: MCP
    B->>C: CDP
    C-->>J: вкладки / DOM
    J->>J: URL + busy + editor gate
    J->>C: type(text, submit=false)
    J->>J: persist click-committed
    J->>C: click(send)
    C-->>J: observed DOM
    J->>J: verified OR unknown
```

## 3. Взаимодействие служб и отказов

- Если Dashboard не работает, уже запущенные terminal/browser services могут продолжать работать: Dashboard — control plane, не единственный data plane.
- Если browser proxy падает, backend 8931 может оставаться активным, однако внешний browser MCP и AutoSend теряют штатный путь.
- Если Chrome закрыт, Playwright MCP может быть активен как процесс, но browser-tools будут возвращать ошибки.
- Если AutoSend выключен, ручной browser MCP может работать: их lifecycle независим.
- Если Message service выключен, реестр недоступен UI, но terminal MCP остаётся отдельным сервисом.
- Если terminal tunnel разорван, локальные command/OneShot HTTP могут оставаться healthy, а ChatGPT tool invocation — нет.

## 4. Что означают «зеленые» статусы

`launchctl job.running` означает найденный PID; `proxyReady` означает только доступность TCP-слушателя; `configured` означает наличие необходимых значений конфигурации. Ни одно из этих полей не гарантирует успешного `tools/call` из ChatGPT.

Критерий доступности MCP — **реальный вызов инструмента через правильный подключённый tunnel**. Для AutoSend — ещё и точная проверка адресата/DOM на отдельном тестовом чате.

## 5. Исторические реализации

В `autosend/` могут сохраняться `chrome-extension/`, `native-messaging/`, `desktop.mjs`, `browser.mjs`, а также регрессионные тесты бывших транспортов. Они документируют миграцию, **не** доказывают, что extension является текущим способом доставки. Действующий scheduler зовёт `deliverViaPlaywright` из `cdp-delivery.mjs`.

В `native/` могут храниться backup binaries, bundle snapshots и исторические файлы. Для публичного source release это **артефакты разработки**, не часть рекомендуемой поставки.

## 6. Source ownership

| Изменяется | Проверяйте совместно |
|---|---|
| `dashboard/server.mjs` groups | SwiftUI state decoder, LaunchAgent labels |
| Browser proxy | `playwright/start-tunnel.sh`, browser MCP, AutoSend tests |
| Terminal job schema | `terminal/stateless_server.js`, `job_runtime.js`, Tool descriptions |
| AutoSend states | `core.mjs`, `server.mjs`, `cdp-delivery.mjs`, SwiftUI scheduled UI |
| SQLite schema | `messaging/hub.py` + tests + backup/migration docs |
| Skills | Исходники `skills/`, bundled `Resources/skills`, codesign |
| Приложение | `native/*.swift`, Info.plist, AppIcon, signatures |

См. [TERMINAL.md](TERMINAL.md), [BROWSER.md](BROWSER.md), [MESSAGING.md](MESSAGING.md), [AUTOSEND.md](AUTOSEND.md).
