# McpGo — сборка, пакетирование, подпись и установка

## 1. Что сегодня считается рабочей сборкой

В текущем локальном каталоге присутствует `McpGo.app` — приложение macOS для **arm64**, созданное из SwiftUI исходников. Это **не** подписанный Developer ID дистрибутив, не notarized DMG/PKG и не проверенный универсальный установщик для чужого Mac.

Система использует три технологии: SwiftUI/AppKit для GUI, Node.js для dashboard/TerminalHub/Playwright/AutoSend, Python 3 для Messaging/PTY. Для запуска всей платформы одного bundle без внешних runtime/dependencies недостаточно.

## 2. Native executable

```bash
cd native
xcrun swiftc -parse-as-library \
  -sdk "$(xcrun --show-sdk-path)" \
  -target arm64-apple-macosx14.0 -O \
  -o MCPHub \
  main.swift Messaging.swift TunnelSettings.swift TunnelHelp.swift \
  InteractiveButtonStyle.swift SkillsView.swift ScheduledMessages.swift
```

- `CFBundleName`: McpGo.
- `CFBundleDisplayName`: McpGo.
- `CFBundleExecutable`: **MCPHub**, legacy внутреннее имя Mach-O.
- `CFBundleIdentifier`: **local.mcphub.native**, legacy OS identity.
- `LSMinimumSystemVersion`: macOS 14.0.
- Иконка: `native/build-icon.py`, `McpGoMark.svg`, `AppIcon.iconset`, `AppIcon.icns`.

Не переименовывать legacy поля без миграции и проверки системных разрешений — это данные идентичности приложения, а не просто строка UI.

## 3. Структура bundle

```text
McpGo.app/
└── Contents/
    ├── Info.plist
    ├── MacOS/MCPHub
    └── Resources/
        ├── AppIcon.icns
        ├── McpGoMark.png
        ├── McpGoMark.svg
        ├── skills/
        │   ├── terminalhub-operations/SKILL.md
        │   ├── playwrighthub-qa/SKILL.md
        │   ├── agent-coordination/SKILL.md
        │   └── tunnel-diagnostics/SKILL.md
        └── прочие локальные ресурсы
```

В `SkillsView.swift` приоритет имеют `Bundle.main.resourceURL/skills`, а не локальные внешние файлы. Поэтому обновление внешних `skills/` без повторного bundle-sync может показать устаревшие навыки.

## 4. Правильная последовательность выпуска

1. Проверить исходный tree и зависимости.
2. Скомпилировать SwiftUI.
3. Подготовить iconset/`.icns`.
4. Собрать **весь** bundle, включая 4 навыка.
5. Проверить `Info.plist` (name, executable, identifier).
6. Только после копирования всех ресурсов выполнить codesign.
7. Проверить подпись.
8. Запустить приложение в чистом test profile без production data.
9. Проверить UI, службы, два MCP tool E2E.
10. Лишь затем выпускать архив/installer.

Проверка локальной ad hoc подписи:

```bash
codesign --force --deep --sign - McpGo.app
codesign --verify --strict McpGo.app
plutil -lint McpGo.app/Contents/Info.plist
```

`--sign -` — ad hoc; **не** доказательство идентичности издателя и не полноценная нотарификация Apple. Для распространения вне локального Mac потребуются отдельные release signing/notarization процессы с доказуемой цепочкой поставки.

## 5. Node.js зависимости

`playwright/package.json` включает `@playwright/mcp` и lockfile. `npm ci` следует выполнять в соответствующей папке. Наличие lockfile не означает, что все поставляемые файлы автоматически проходят SBOM/licensing audit.

До публикации необходимо: зафиксировать версии Node/Python/Xcode, создать зависимости для всех runtime, проверить provenance используемого `tunnel-client`, провести license scan и vulnerability audit.

## 6. LaunchAgents

Работающий McpGo использует пользовательские `~/Library/LaunchAgents`, а исходные шаблоны — `launchagents/*.plist`. Часть шаблонов содержит **абсолютный путь референс-установки**. На другом Mac это приведёт к ошибке даже при правильно собранном bundle.

В будущем installer должен:
- узнать текущий `HOME`, путь установленного приложения и runtime;
- установить compatible Node/Python или явно проверить их наличие;
- сформировать plist c актуальными путями;
- обеспечить owner-only permissions для рабочих папок;
- зарегистрировать службы через `launchctl bootstrap`;
- проверить readiness и выполнить smoke test;
- иметь идемпотентный повтор и rollback.

**Не** устанавливайте все plist от root ради простоты: они разработаны для пользовательского launchd domain.

## 7. Uninstaller — открытый пункт

Готового переносимого uninstaller текущая версия не имеет. Публичный uninstaller должен предложить выбор:
- остановить свои службы;
- удалить только свои installed plist и binaries;
- **сохранить или экспортировать** Messaging/AutoSend state;
- по отдельному явному действию удалить пользовательские данные;
- не удалять Chrome profile или данные сторонних приложений.

Нужно различать uninstall программы и delete personal data.

## 8. Source-only публикация

**Нельзя** копировать всю локальную папку прямо в публичный Git: там могут быть исторические `.app`, бинарники, `logs/`, `messaging/data/`, `playwright/.cache/`, диагностические файлы и рабочее состояние.

`.gitignore` предотвращает типичное **новое** добавление отдельных путей, но **не** гарантирует чистоту ранее включённых файлов или отсутствие чувствительного содержимого. Перед открытием нужно провести отдельный scan по результирующему source archive, в том числе бинарным артефактам, зависимостям, license metadata и примерам конфигурации.

## 9. Release artifacts будущего проекта

Рекомендуемая структура:
- `McpGo-x.y.z-macos-arm64.dmg` или `.pkg` — после signing/notarization;
- исходный архив с лицензией, checksum и SBOM;
- `CHANGELOG.md` и migration notes;
- конкретный список supported macOS/Chrome/Node combinations;
- provenance/хэши артефактов;
- инструкция clean install, upgrade, rollback, uninstall.

Пока это **критерии готовности**, не уже существующие опубликованные файлы.

## 10. Проверка приемки

- Bundle запускается без старых пользовательских каталогов.
- GUI не требует жёстко заданного логина/имени пользователя.
- Все LaunchAgents видны в `launchctl` под правильным uid.
- Локальные API health проходят.
- Оба MCP endpoint доступны из разрешённого ChatGPT клиента.
- Runtime данные после обновления сохранились.
- После удаления binaries пользовательская база не исчезает без подтверждения.
- Установщик не создаёт два экземпляра AutoSend на одном state.

См. [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md), [MIGRATION.md](MIGRATION.md), [VERIFICATION.md](VERIFICATION.md).
