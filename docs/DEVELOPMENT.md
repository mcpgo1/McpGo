# McpGo — разработка, тесты и релиз

## Версии и границы

Текущая видимая марка — McpGo, но `CFBundleIdentifier=local.mcphub.native`, `CFBundleExecutable=MCPHub`, `com.mcphub.*` и physical path `~/Desktop/mcphub` сохранены как стабильные идентификаторы. Не меняйте их поиском и заменой без миграции и обратного отката. Это самостоятельное macOS-приложение.

## Сборка SwiftUI

```bash
cd <INSTALL_ROOT>/native
xcrun swiftc -parse-as-library -sdk "$(xcrun --show-sdk-path)" \
  -target arm64-apple-macosx14.0 -O -o MCPHub \
  main.swift Messaging.swift TunnelSettings.swift TunnelHelp.swift \
  InteractiveButtonStyle.swift SkillsView.swift ScheduledMessages.swift
```

Исполняемый файл скомпилирован под Apple Silicon macOS 14+, требует совместимый SDK. Скрипт сборки должен сначала компилировать исходники, затем копировать `native/MCPHub` в `McpGo.app/Contents/MacOS/MCPHub`, синхронизировать 4 навыка в `Contents/Resources/skills`, подписать bundle, после проверить подпись. Подписанные ресурсы нельзя менять после codesign.

```bash
codesign --force --deep --sign - "<INSTALL_ROOT>/McpGo.app"
codesign --verify --strict "<INSTALL_ROOT>/McpGo.app"
plutil -lint "<INSTALL_ROOT>/McpGo.app/Contents/Info.plist"
```

Сначала закрывайте приложение перед обновлением исполняемого файла. После обновления перезапустите UI; работающие серверы/туннели без отдельной необходимости не прерывайте.

## Тестирование

```bash
cd <INSTALL_ROOT>
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s messaging/tests -v
cd autosend
node --test tests/*.test.mjs
node --check server.mjs
node --check cdp-delivery.mjs
cd ../playwright
node --check restricted-proxy.mjs
```

Дополнительно: проверка HTTP status localhost 8969/8971/8972, loaded/running launchd, существующих CDP-вкладок, реальный `terminal_exec`/ `browser_tabs` из ChatGPT. Не считать успешный unit-test доказательством внешней доставки. E2E отправки делайте только в отдельный тестовый чат и с разрешения.

## Рекомендованный цикл изменения

1. Сначала зафиксировать наблюдаемое поведение и состояние служб; отметить активную конфигурацию.
2. Сделать backup изменяемого файла, соответствующих рабочих plist и критичного локального состояния.
3. Изменять минимальный набор файлов. Не удалять пользовательские расписания, историю сообщений и Chrome-профиль.
4. Тестировать синтаксис, unit, локальную интеграцию и, при необходимости, live-E2E.
5. Одновременно править `docs/`, навыки `skills/` и встроенные ресурсы приложения.
6. Сформулировать ограничения: verified delivery != completed agent task; PID != working tunnel; queued != processed.
7. На релизе сохранить возможность вернуть прежний бинарник и plist, не откатывая бездумно пользовательскую БД.

## Документы

- [ARCHITECTURE.md](ARCHITECTURE.md) — схема и состав.
- [AUTOSEND.md](AUTOSEND.md) — протокол браузерной доставки и recovery.
- [MIGRATION.md](MIGRATION.md) — ID, пути, совместимость.
- [INTERFACES.md](INTERFACES.md) — порты, MCP, API, данные.
- [OPERATIONS.md](OPERATIONS.md) — служебные проверки и восстановление.
- Директории `autosend/`, `playwright/`, `messaging/`, `terminal/` содержат подробности реализаций и исторические заметки. Старые инструкции про отдельный Chromium, Chrome Extension и Native Messaging следует считать историческими, если они противоречат текущему CDP-коду.

## Быстрая проверка SwiftUI без новой нотариализации

Во время работы над мастером не пересобирай DMG на каждое исправление.
Вместо этого после правки SwiftUI запусти:

    cd <INSTALL_ROOT>
    ./scripts/dev_preview_macos.sh --launch

Первый запуск копирует подписанный McpGo.app из /Applications в отдельный
release/dev/McpGo Dev.app (APFS copy-on-write), меняет Bundle ID на
local.mcphub.native.dev, компилирует SwiftUI в debug-режиме и подписывает
только эту локальную копию ad-hoc. Последующие запуски обновляют только
исполняемый файл и подпись, не копируя runtime заново.

Dev-версия помечена DEV PREVIEW, чтобы не путать её с обычным McpGo.
Скрипт корректно закрывает только предыдущую Dev-версию при пересборке;
приложение в /Applications, рабочие LaunchAgents, Keychain и пользовательские
данные не меняются.

Ограничение: Dev-просмотр работает с текущим пользовательским состоянием
~/Library/Application Support/McpGo/Runtime. Это не независимая «чистая»
установка. Для полной проверки нового пользователя остаётся тест в отдельном
профиле macOS с финальным DMG, подписью Developer ID и нотариализацией.
