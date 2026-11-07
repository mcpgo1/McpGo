# ChatTerminalHub — терминальный модуль McpGo

## Назначение

Предоставляет Mac-инструменты для команд и длительных задач через MCP. В текущей реализации доступны **два независимых локальных HTTP процесса**:

- `terminal/server.js` — stateful command server на `127.0.0.1:12847`, включая сессионные терминальные вызовы. Есть `GET /health`.
- `terminal/stateless_server.js` — OneShot/jobs MCP на `127.0.0.1:12848`, включая инструменты `terminal_exec`, `job_start`, `job_status`, `job_logs`. Есть `GET /health`.

Внешний доступ из ChatGPT организуется через **отдельный** Terminal Secure MCP Tunnel. Локальная служба OneShot и command server — не одно и то же; MCP-плагин может публиковать лишь предусмотренный профилем набор инструментов.

## OneShot

`terminal_exec({command,cwd?,timeout_ms?})` исполняет одну команду. Предельное время — 90 секунд. После вызова нет сохранённой интерактивной терминальной сессии. Анализируйте все поля результата: `exit_code`, `timed_out`, `spawn_error`, stdout/stderr. Результат с тайм-аутом нельзя интерпретировать как безопасный для автоматического повтора.

## Длительные jobs

`job_start({command,cwd?,timeout_ms?})`: detached runner, максимальная длительность 4 часа (14 400 000 мс), значение по умолчанию 20 минут, абсолютный cwd; возвращает случайный job_id и начальную очередь, а не итог.

`job_status({job_id})`: окончательное состояние процесса, включая `state`, `exit_code`, `timed_out`, `spawn_error` и диагностические поля. `unknown` возможен после потери runner/process receipt.

`job_logs({job_id,tail_lines?,max_chars?})`: ограниченный хвост stdout/stderr. По умолчанию 40 строк и 4000 символов на поток; допустимы 1–200 строк и 100–12000 символов. Это инструмент диагностики, не гарантия полного лог-архива.

Проверка PASS требует `state=exited`, `exit_code=0`, `timed_out=false` и отсутствия spawn_error.

## Сессионный command server

`server.js` реализует отдельный MCP-совместимый endpoint c `initialize`, `tools/list`, `tools/call` и управлением интерактивными терминальными сессиями. Вызовы stateful terminal API требуют создания собственной сессии и хранения выданных session credentials внутри разговора. Не путайте это с `terminal_exec`: последний не держит сессию между вызовами.

## LaunchAgents и tunnel

| Служба | Задача |
|---|---|
| `com.chatterminalhub.server` | Command server 12847 |
| `com.chatterminalhub.oneshot` | OneShot/job runtime 12848 |
| `com.chatterminalhub.tunnel` | Secure MCP tunnel |

Активный wrapper туннеля находится в `~/Library/Application Support/ChatTerminalHub/run-tunnel.sh` (owner-only), а шаблон в `launchagents/com.chatterminalhub.tunnel.plist`. Dashboard McpGo умеет исправлять существующие plist, ранее указывавшие на Desktop. При изменении активного plist может потребоваться `bootout` и `bootstrap`.

## Операционный сценарий

1. Прочитать `GET /health` для двух локальных служб.
2. Проверить `launchctl list` и `launchctl print` для tunnel.
3. В подключённом MCP-клиенте выполнить безопасную команду `terminal_exec`.
4. Для длительных операций использовать `job_start → job_status → job_logs`; не повторять потенциально неидемпотентную операцию при неизвестном исходе.

## Ограничения

Команды выполняются с правами владельца процесса. Отдельной песочницы всего Mac этот модуль не создаёт. Для опасных операций нужен контроль полномочий MCP-клиента, разрешение владельца и осмысленная проверка окружения. Продукт не должен вмешиваться в процессы других приложений без прямого запроса.

Дополнительно: [архитектура](../docs/ARCHITECTURE.md), [контракты](../docs/INTERFACES.md), [эксплуатация](../docs/OPERATIONS.md), [безопасность](../docs/SECURITY.md).
