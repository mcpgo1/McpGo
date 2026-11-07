# Contributing to McpGo

Спасибо за интерес к проекту. Этот файл описывает инженерные правила будущего публичного репозитория. **Важно:** отдельный файл `LICENSE` ещё не выбран; до его появления текст CONTRIBUTING не предоставляет лицензионных прав третьим лицам. Maintainer должен выбрать лицензию до открытия кода для внешних вкладов.

## Зона ответственности

McpGo — самостоятельная macOS-платформа:
- `native/`: SwiftUI/AppKit;
- `dashboard/`: локальная панель и управление launchd;
- `terminal/`: command/OneShot/job API;
- `playwright/`: CDP browser MCP + shared-session safe proxy;
- `autosend/`: расписания и подтверждение отправки в браузерном чате;
- `messaging/`: SQLite очередь;
- `launchagents/`: lifecycle служб;
- `skills/`: инструкции для агентов;
- `docs/`: техническая документация.

Изменения в других приложениях не входят в область этого репозитория. Ни одна задача по документированию или тестированию McpGo не должна требовать изменения кода стороннего проекта.

## Подготовка локального окружения

Убедитесь в наличии Xcode/macOS SDK, Node.js, Python 3 и обычного Google Chrome. Установите зависимости Playwright через `npm ci` в `playwright/`. Проверяйте запуск без жёстко зашитого имени пользователя: часть существующих LaunchAgents пока не переносима, поэтому новый installer должен учитывать пути явно.

Не коммитьте из локальной референс-установки SQLite, пользовательские расписания, Chrome-профили, `.cache`, журналы и скомпилированные бинарники. Прежде чем открывать репозиторий публично, сформируйте и проверьте `.gitignore`, исходные файлы, лицензии зависимостей и отсутствие приватных артефактов.

## Формат изменений

1. Опишите проблему, ожидаемое поведение и затронутые подсистемы.
2. Дайте минимальный воспроизводимый сценарий без рабочих данных других пользователей.
3. Сохраните контракт совместимости `com.mcphub.*`, Bundle ID, локальных API headers и путей хранилищ либо добавьте полноценную миграцию с откатом.
4. Дополните тестами те ветви кода, которые меняются; отдельно фиксируйте unknown outcome после возможного browser click.
5. Обновите соответствующие `docs/*.md` и `skills/*/SKILL.md`.
6. Укажите команды проверки и реальный результат, а также что **не** проверено. Live-публикации в рабочие чаты не входят в безопасную регрессию.

## Локальные тесты

```bash
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s messaging/tests -v
(cd autosend && node --test tests/*.test.mjs)
node --check dashboard/server.mjs
node --check autosend/server.mjs
node --check autosend/cdp-delivery.mjs
node --check playwright/restricted-proxy.mjs
bash -n playwright/start.sh playwright/start-tunnel.sh playwright/configure-tunnel.sh
```

### SwiftUI

```bash
cd native
xcrun swiftc -parse-as-library -sdk "$(xcrun --show-sdk-path)" \
  -target arm64-apple-macosx14.0 -O -o MCPHub \
  main.swift Messaging.swift TunnelSettings.swift TunnelHelp.swift \
  InteractiveButtonStyle.swift SkillsView.swift ScheduledMessages.swift
```

Не используйте test exit 0 как доказательство живой MCP-связи. Для полного E2E необходимы контроль процесса/порта, реальный MCP-вызов из клиентского чата и изолированный тест отправки только после явного разрешения.

## Pull requests

Включайте краткое описание, обоснование обратной совместимости, список модифицированных компонентов, тесты и ограничения. Изменение схемы состояния AutoSend требует описания отказа после commit-клика; изменения Git/LaunchAgent/setup требуют инструкций rollback. Не помещайте приватные истории чатов и содержимое чужого Chrome в примеры.

## Релизы

До публичного релиза нужны: выбранная лицензия, чистая сборка на новой машине, воспроизводимая подпись, автоматизированный installer/uninstaller, CI-matrix, обновлённые зависимые лицензии, portable paths, security contact, changelog и проверка работы с существующими данными.
