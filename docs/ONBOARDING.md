# McpGo — автоматический мастер первого запуска

Статус: реализован в публичной копии McpGo; remote provisioning проверен на mock OpenAI Platform, но не на действующих ключах пользователя. Реальные удалённые ресурсы не создавались.

## Пользовательский сценарий

1. Открыть McpGo.app или «Запустить McpGo.command». Лаунчер открывает интерфейс; ничего не ставит без согласия.
2. «Первое подключение» → системный preflight: macOS 14+, arm64, Node/npm, Python, tunnel-client, Playwright. Кнопка установки зависимостей выполняет npm ci только после подтверждения.
3. Ввести Platform Organization ID и при необходимости ChatGPT Workspace ID. Для создания нужны Tunnels Read + Manage. Для runtime нужны Tunnels Read + Use.
4. Создать два туннеля автоматически либо импортировать два существующих Tunnel ID. Поиск и создание выполняются только в явном scope.
5. Ввести restricted runtime API key. SwiftUI сохраняет его в macOS Keychain, не в исходниках или YAML.
6. Настроить локальные HTTP профили через официальный tunnel-client init. Terminal target — приватный маршрут OneShot на 127.0.0.1:12848; Browser target — Safe Proxy 127.0.0.1:8940/mcp.
7. После подтверждения — установка пользовательских LaunchAgents. Никакого sudo, никакой автоматической замены чужих labels.
8. В личном Chrome вручную разрешить CDP. Мастер не обходит системное согласие.
9. В ChatGPT Plugins добавить custom MCP server через Tunnel, выбрать нужный Tunnel ID, подтвердить полномочия.
10. Выполнить read-only диагностику MCP и tunnel-client doctor, затем проверку реального инструмента из ChatGPT. Локальные тесты не подменяют последнюю проверку.

## Распределение ответственности

| Модуль | Ответственность |
|---|---|
| native/OnboardingView.swift | Семь шагов, SecureField, progress, Keychain, явные действия |
| onboarding/cli.py | JSON stdin bridge; whitelist разрешённых действий |
| onboarding/setup_engine.py | Scope validation, remote create/list/get, import, local profiles, state machine, probes |
| scripts/setup_macos.py | Collision checks и установка LaunchAgents |
| scripts/launch-macos.sh | Только запуск интерфейса |
| terminal/stateless_server.js | Terminal MCP приватный route |
| playwright/restricted-proxy.mjs | Browser MCP с ограничениями инструментов |
| onboarding/tests/test_setup_engine.py | Регрессия provisioning, unknown outcome, state и permissions |

## State, безопасность и идемпотентность

Файл состояния: ~/Library/Application Support/McpGo/Onboarding/state.json.

Права: 0600, каталог 0700, запись через atomic replace. Привязан к физическому install root. Содержит случайный ID установки, фазу, tunnel IDs, происхождение каждого ресурса и pending remote operation. API keys в него не попадают.

Перед созданием туннеля выполняется admin tunnels list --json в точном org/workspace scope. Имя туннеля уникально для установки. Если create завершился ошибкой после возможного обращения к серверу, pending становится unknown. Повторный вызов сначала повторяет list; при отсутствии созданного ресурса новый create блокируется до ручной проверки в Platform. Это предотвращает бессмысленные дубликаты.

Важные Keychain services совместимы со старой установкой. До любой записи ключа мастер проверяет принадлежность действующих LaunchAgents через setup_macos.py --check. Если на Mac уже есть другая установка, профиль не перезаписывается.

Admin key вводится через SecureField, передаётся в отдельный Python-процесс через stdin и далее только во временном environment tunnel-client. Runtime key сохраняется в системном Keychain. Профили содержат ссылку env:CONTROL_PLANE_API_KEY.

Отмена мастера никогда не удаляет уже созданные удалённые туннели; удаление должно быть отдельным явным действием. Ошибки локальной установки не останавливают чужие процессы.

## Действия CLI bridge

| Action | Эффект |
|---|---|
| status, preflight | Read-only, без создания состояния |
| check-ownership | Read-only проверка принадлежности служб |
| discover | Admin Tunnels List с явным scope |
| provision | Подтверждённое создание/повторное использование удалённых ресурсов |
| import | Сохранение двух ID, remote-verified=false |
| verify-remote | Read-only Tunnels Get для каждого ID |
| configure | Профили terminal/browser и local Tunnel ID |
| install-deps | npm ci после подтверждения |
| install | User LaunchAgents после collision check |
| start-local | Явный запуск Terminal либо Playwright через локальный Dashboard |
| verify-local | MCP initialize, notifications/initialized, tools/list, browser_tabs(list) |
| doctor | Проверка terminal/browser через tunnel-client doctor |
| chatgpt-instructions | Записывает факт ознакомления, НЕ устанавливает chatgptVerified |

Вызовы происходят без передачи ключей в command-line arguments; stdout содержит JSON с результатом/ошибкой без raw stderr.

## Устройство профилей

Terminal: профиль chat-terminal-hub с private endpoint OneShot. Browser: профиль mcpgo-browser для команды doctor и локальный tunnel.id, используемый действующим browser launcher.

Локальные профили генерирует именно установленный tunnel-client init, а не вручную написанный YAML. Его текущую справку необходимо проверять после обновлений tunnel-client.

## Проверки и остаточные ограничения

Подтверждены 9 сценариев unit-тестов: идемпотентность, unknown-before-create, recovery, mode import, неверные ID, изоляция разных root, приватные права state, профили и отсутствие ложного ChatGPT verification. SwiftUI typecheck проходит на arm64 macOS.

Реальное создание в OpenAI Platform, права определённого workspace и пользовательское подтверждение custom MCP в ChatGPT не выполнялись. На Mac с действующей другой установкой мастер блокирует вмешательство. Полноценная E2E-приёмка должна проходить на отдельном чистом Mac либо после явной миграции действующих служб.

См. также GETTING_STARTED.md, SECURITY.md, PACKAGING.md, VERIFICATION.md, PUBLIC_RELEASE.md.


## Маркер владельца LaunchAgent

Во время установки scripts/setup_macos.py записывает переменную
MCPGO_INSTALL_ROOT в EnvironmentVariables каждого пользовательского plist.
Это особенно необходимо для терминального туннеля: его ProgramArguments
указывает на Application Support, а не исходный проект. На последующих
запусках установщик сверяет метку с каноническим root; несовпадение означает
конфликт, а не разрешение перезаписать службу.

## CI проверка

Workflow .github/workflows/verify.yml предназначен для нового публичного репозитория. Использует macOS, фиксированный Node 20 и Python 3.11, выполняет unit/integration тесты и SwiftUI typecheck. CI не создаёт OpenAI tunnels и не содержит пользовательских API keys. Пока репозиторий не опубликован, workflow не запускался на GitHub Actions.


## Добровольный выход из мастера

Статус verification означает ожидание настоящего вызова из ChatGPT,
а не завершение. Кнопка «Продолжить без подтверждения ChatGPT» записывает
только wizardDismissed=true. При следующем запуске откроется обзор,
но chatgptVerified останется false. Мастер всегда можно открыть из меню.
