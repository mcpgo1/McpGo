# McpGo — зависимости, supply chain и воспроизводимость

## 1. Почему отдельная глава

McpGo объединяет SwiftUI, Node.js, Python, Chrome и внешний tunnel-client. Для пользователя важно не только «что делает исходный код McpGo», но и **какой сторонний код он реально запускает**, какая версия закреплена и какие компоненты требуют доверия к отдельным разработчикам.

## 2. Runtime stack

| Компонент | Роль | Примечание |
|---|---|---|
| macOS | ОС и launchd | Текущий target нативной сборки: macOS 14+ arm64 |
| SwiftUI / AppKit | GUI | Используются стандартные Apple frameworks |
| Node.js | Dashboard, Terminal, Browser wrappers, AutoSend | Версию нужно явно pin в будущем installer/CI |
| Python 3 | Messaging SQLite и PTY worker | В текущем коде используются стандартные модули |
| Google Chrome | Реальные вкладки и CDP | Пользователь включает remote debugging |
| `@playwright/mcp` | Browser MCP backend | Закреплён в package-lock |
| OpenAI `tunnel-client` | Outbound Secure MCP Tunnels | Отдельный исполняемый компонент |

### Наблюдаемое окружение референс-установки

На Mac, где проверялись документы, обнаружены: Node.js `v20.20.2`, Python `3.9.6`, Xcode `26.3`, `tunnel-client` `0.0.17+a248b7f...`. Это **снимок окружения**, а не официальная матрица supported versions для всех пользователей. Перед публичной публикацией нужно зафиксировать tested supported range и воспроизводимо устанавливаемые версии.

## 3. Node dependency lock

`playwright/package.json`:

```json
{
  "name": "mcpgo-playwright-mcp",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@playwright/mcp": "0.0.83"
  }
}
```

`playwright/package-lock.json` использует lockfile v3 и фиксирует:

| Package | Lockfile version | Обозначенная лицензия в lock |
|---|---|---|
| `@playwright/mcp` | `0.0.83` | Apache-2.0 |
| `playwright` | `1.64.0-alpha-1790635538000` | Apache-2.0 |
| `playwright-core` | `1.64.0-alpha-1790635538000` | Apache-2.0 |

**Предупреждение о доверии:** alpha-версия транзитивной зависимости является фактом lockfile. Документация не утверждает её пригодность для долгосрочного публичного релиза без дополнительного review. Данные о лицензиях здесь взяты из lockfile и не заменяют юридическую проверку всех upstream notices.

Установка на разрешённой машине:

```bash
cd playwright
npm ci
npm ls --all
```

`npm ci` разрешает зависимости согласно lockfile. Но даже при pin version содержимое npm registry и lifecycle scripts — supply-chain фактор; нужны аудиты и контроль provenance.

## 4. Swift и системные бинарники

SwiftUI собирается `xcrun swiftc` с системным macOS SDK; `codesign`, `plutil`, `launchctl`, `iconutil` — системные утилиты Apple. Терминальный сервер использует `/bin/zsh` и `/usr/bin/python3`, в launchd scripts зафиксированы пути Node из Homebrew.

Общий механизм версионирования macOS runtime ещё не оформлен в отдельный public installer. Не пытайтесь считать путь `/opt/homebrew/bin/node` универсальным для всех Mac.

## 5. Chrome и Playwright

В действующей версии browser backend подключается к **уже открытому** личному Chrome, а не запускает отдельный поставляемый Chromium. Влияние Chrome version, CDP permissions и browser UI следует проверять отдельно от Node package version.

Изменение Chrome/ChatGPT DOM может сломать AutoSend не меняя сам McpGo. Поэтому live E2E нужен на актуальных версиях браузера и интерфейса.

## 6. Tunnel-client

`tunnel-client` — отдельный бинарник, связанный с OpenAI Secure MCP Tunnels. Исходная часть McpGo формирует локальные endpoint и параметры запуска, но не утверждает, что этот бинарник является авторским кодом McpGo.

Перед публичным релизом:
- документировать официальный способ установки и источник бинарника;
- закрепить проверенную версию, checksum и архитектуру;
- проверить поддержку профилей и совместимость с macOS;
- явно описать ошибки и разрешения workspace;
- не включать системный бинарник в source-only архив без соответствующей лицензии/оснований.

## 7. Python dependencies

`messaging/hub.py` использует `sqlite3`, `http.server`, `argparse`, `datetime`, `json` и другие standard-library модули. `terminal/pty_worker.py` запускается через системный Python. В текущем tree нет отдельного закреплённого Python requirements lock для этих подсистем.

Это означает, что их совместимость определяется интерпретатором macOS и actual source use; до release нужен CI на заявленных Python версиях.

## 8. Регулярный аудит зависимостей

```bash
npm --prefix playwright ls --all
npm --prefix playwright audit --omit=dev
python3 --version
node --version
xcrun swiftc --version
```

`npm audit` требует доступа к registry и может сообщать уязвимости, относящиеся к зависимостям, а не непосредственно к коду McpGo. Его результат нужно сохранять в CI, анализировать severity и закрывать mitigation, а не автоматически объявлять проект «взломанным» или «полностью безопасным».

## 9. Публикация SBOM

Релизный SBOM должен содержать:
- прямые и транзитивные Node dependencies, lock versions;
- используемый `tunnel-client` с источником;
- Swift/Xcode build environment;
- Python runtime version;
- hashes source commit и подписанных release artifacts;
- license notices и ограничения.

На момент подготовки этой документации полноценный SBOM **ещё не опубликован**. Указанная выше таблица — текущий проверенный мини-инвентарь, не замена SBOM.

## 10. Проверяемые выводы

**Подтверждено:** текущий Node lockfile содержит три сторонних package entries, версия browser MCP закреплена; native код использует SwiftUI/AppKit; Python queue использует SQLite; браузер подключается через CDP.

**Не подтверждено:** безопасность всех транзитивных зависимостей, происхождение будущих установочных бинарников, поддерживаемые версии всех Chrome releases и полный cross-platform CI. Эти пункты остаются в [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md).
