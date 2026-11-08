# McpGo 2.0.3 — macOS (Apple Silicon)

> Документ подготовлен для GitHub Releases. Наличие этого файла в репозитории не означает, что DMG уже опубликован.

## Что внутри

- Нативное McpGo.app для **macOS 14+ / Apple Silicon (arm64)**.
- Мастер первого подключения, локальные службы и два MCP-контура: Terminal и Browser.
- Команды терминала, длительные задания, Playwright/CDP для Chrome, отправка сообщений по расписанию.
- Runtime внутри приложения: Node.js, Python, tunnel-client и Playwright MCP.

## Где скачать

После появления релиза откройте [GitHub Releases](https://github.com/mcpgo1/McpGo/releases), выберите **v2.0.3** и скачайте **`McpGo-2.0.3-macos-arm64.dmg`** из раздела Assets. **Source code (zip)** — это исходники, не установщик.

1. Откройте DMG и перетащите McpGo.app в «Программы».
2. Откройте McpGo и пройдите мастер первого запуска.
3. Подключите Secure MCP Tunnels и два MCP-сервера в ChatGPT.

Подробности: [README](../README.md) · [Первый запуск](GETTING_STARTED.md).

## Проверки локального файла перед загрузкой в Releases

- Имя файла: `McpGo-2.0.3-macos-arm64.dmg`.
- SHA-256: `9ad013c37c1aca38054d2620b28c7cfd03d6e782da4b74f50c58a7527915506e`.
- macOS `spctl -a -vv -t open`: **accepted — Notarized Developer ID**.
- `xcrun stapler validate`: **The validate action worked**.
- Издатель: **Developer ID Application: Andrey Smotrov (PJQ8PP666S)**.
- Размер DMG: около 151 MiB.

Это результат локальной проверки. Сценарий установки на независимом чистом Mac проверяется отдельно. Публикуйте только тот же файл с той же контрольной суммой. Не заменяйте его тестовым `UNSIGNED-TEST-ONLY`.

## Для разработчиков

[Сборка и нотарификация](DMG_RELEASE.md) · [Тесты](VERIFICATION.md) · [Эксплуатация](OPERATIONS.md).
