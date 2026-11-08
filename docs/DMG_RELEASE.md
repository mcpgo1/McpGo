# McpGo — выпуск DMG для macOS (вне Mac App Store)

## Статус

DMG собирается из отслеживаемых исходников `native/` и других whitelisted файлов в отдельном `release/` и **не модифицирует** рабочее `McpGo.app` на компьютере разработчика и не трогает установленные пользовательские LaunchAgents.

Незаверенный файл с суффиксом `UNSIGNED-TEST-ONLY` — **только локальный тестовый артефакт**, не раздавать посетителям сайта. Для обычного открытия на чужом Mac нужно подписать приложение **Developer ID Application**, включить hardened runtime, пройти **notarytool** и прикрепить ticket к DMG.

## Что включено

- Нативная SwiftUI `McpGo.app` (Apple Silicon, macOS 14+).
- Встроенный установочный runtime в `Contents/Resources/RuntimeSeed`: Node.js 20.20.2 (официальный архив Node.js), Python 3.12.16 (python-build-standalone), tunnel-client v0.0.17 (официальный архив OpenAI) и `@playwright/mcp` (зависимости из lockfile).
- Выбранные по белому списку исходные runtime-файлы, служебные plist и четыре навыка.
- Лицензии Node.js, tunnel-client и его компонентов.

В DMG **нет** ключей, конфигурации вашей установки, пользовательских переписок, профилей Chrome, кэша, логов, данных AutoSend и служебных состояний.

При первом запуске `RuntimeSeed` копируется в `~/Library/Application Support/McpGo/Runtime`. Дальше мастер настройки работает с этим каталожным runtime, а не с исходной папкой проекта.

## Сборка на Mac

```bash
cd <path-to-McpGo>
python3 scripts/build_release_dmg.py
```

Понадобятся Xcode Command Line Tools, сеть для первой загрузки архивов, npm для сборки Playwright. Архивы проверяются по SHA-256. `release/cache` сохраняет официальные скачанные архивы, `release/build` — временную сборку, `release/dist` — результирующий DMG.

Режим без Developer ID подписывает Mach-O локальной ad-hoc подписью и помечает DMG **UNSIGNED-TEST-ONLY**. Он не обходит Gatekeeper на Mac пользователя.

## Как включить публичную подпись и нотарификацию

1. В Apple Developer **Certificates, Identifiers & Profiles** получить сертификат **Developer ID Application**. Это сертификат распространения **вне App Store**; обычный `Apple Development` не годится. Сертификат нужно установить в Keychain вместе с приватным ключом.
2. Проверить `security find-identity -v -p codesigning`: должна присутствовать строка типа `Developer ID Application: ...`. Не копировать приватные ключи и пароли в репозиторий.
3. Создать в Keychain профиль `notarytool` для Apple, например `McpGoNotary`, используя доступные у владельца Apple Developer credentials. `xcrun notarytool store-credentials McpGoNotary ...` предоставляет интерактивные варианты. Не сохранять API-key или пароль в исходниках.
4. Выпустить релиз:

```bash
python3 scripts/build_release_dmg.py \
  --developer-id 'Developer ID Application: YOUR NAME (TEAMID)' \
  --notary-profile McpGoNotary
```

Скрипт подписывает встроенные исполняемые файлы, затем приложение, загружает DMG в Apple Notary Service, требует успешный результат, выполняет `stapler staple` и `stapler validate`. Только после этого создаётся DMG без пометки TEST/NOT-NOTARIZED.

**Не использовать** `Apple Development` для такого выпуска и не обходить защиту системы через `xattr -d com.apple.quarantine` в пользовательской инструкции.

Источники: [Apple Developer ID](https://developer.apple.com/developer-id/), [Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

## Пользовательская установка после нотарификации

1. Скачать `McpGo-2.0.0-macos-arm64.dmg` с GitHub Releases или сайта McpGo.
2. Открыть DMG и перетащить `McpGo.app` на ярлык `Applications`.
3. Открыть McpGo из «Программы» и пройти мастер первого подключения.
4. Разрешить первоначальную настройку локальных служб, подключить OpenAI Secure MCP Tunnels и ChatGPT, проверить безопасные тестовые MCP-вызовы.

Приложение не должно требовать `git clone`, Node.js, Python или Homebrew. Google Chrome требуется отдельно, если нужна работа Playwright с личными вкладками.

## Обязательная проверка перед публикацией

- Проверить скачанный DMG на **отдельном чистом** Mac Apple Silicon (macOS 14+) либо в VM с обычным пользователем **без Homebrew**.
- Проверить подпись, нотарификацию и отсутствие предупреждений Gatekeeper о неопознанном разработчике. Системный запрос подтверждения первого запуска возможен.
- Проверить копирование RuntimeSeed в Application Support, preflight мастера, установку LaunchAgents **только после подтверждения**, права на каталоги, Terminal MCP, Playwright MCP, туннели и реальный ответ инструмента из ChatGPT.
- Проверить повторный запуск/идемпотентность, конфликт с другой установкой, сохранение состояния и возможность удаления без уничтожения данных.
- Перед публичной публикацией подтвердить перечень встроенных зависимостей, лицензии и provenance.

**Важно:** macOS 14+ и Apple Silicon — текущая заявленная совместимость; Intel не поддерживается. До успешных clean install E2E нельзя утверждать, что проверен сценарий «скачал и сразу настроил» на чужом Mac.
