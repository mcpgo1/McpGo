# McpGo — независимая проверка исходников

Этот checklist нужен исследователю или будущему пользователю, который хочет понять работу приложения **без доверия к автору README**. Команды предполагают source-only checkout без приватных локальных данных.

## 1. Начните с входных точек

| Что проверить | Исходник | Ищите |
|---|---|---|
| GUI entrypoint | `native/main.swift` | `@main`, `HubModel`, `SidebarLink` |
| Локальное управление | `dashboard/server.mjs` | `groups`, `/api/action`, `launchctl` |
| Интерактивная оболочка | `terminal/server.js` | `toolSchemas`, `createSession`, `performTool` |
| Одноразовые команды | `terminal/stateless_server.js` | `terminal_exec`, `spawn('/bin/zsh')` |
| Длительные jobs | `terminal/job_runtime.js` | `startJob`, `summarize`, `logs` |
| Браузерная отладка | `playwright/start.sh` | `--cdp-endpoint chrome` |
| Proxy policy | `playwright/restricted-proxy.mjs` | `UNSAFE`, `initializeOnce`, `warmupTabIndices` |
| AutoSend executor | `autosend/cdp-delivery.mjs` | `classifyAgent`, `deliverViaPlaywright` |
| Scheduler states | `autosend/server.mjs` | `runScheduled`, `expireAmbiguous` |
| Persistent tasks | `autosend/core.mjs` | `readState`, `writeState`, `markUnknownOnBoot` |
| SQLite queue | `messaging/hub.py` | `CREATE TABLE`, `history`, `replace_agent` |
| Службы macOS | `launchagents/*.plist` | `ProgramArguments`, `WorkingDirectory` |

## 2. Установите реальные runtime зависимости

```bash
find . -name package.json -not -path '*/node_modules/*' -print
cat playwright/package.json
find . -name '*.plist' -not -path '*legacy*' -print
grep -R 'exec node\|spawn(\|execFileSync' dashboard terminal playwright autosend launchers
```

Не считайте third-party код внутри `node_modules` частью авторского аудита без license/SBOM. Для чистого source release зависимости должны быть получены повторяемым способом через lockfile.

## 3. Подтвердите локальные listener и маршруты

```bash
grep -R -n "server.listen\|ThreadingHTTPServer" dashboard terminal autosend messaging playwright
grep -R -n "127.0.0.1\|localhost" dashboard terminal autosend messaging playwright
```

Сверьте с [CONFIGURATION.md](CONFIGURATION.md) и [INTERFACES.md](INTERFACES.md). Не исходите из таблицы портов без проверки кода.

## 4. Идентифицируйте capability/permissions

- `terminal/server.js`: session_id + session_key и PTY tool schemas.
- `terminal/stateless_server.js`: private MCP path, command/timeout/body limits.
- `dashboard/server.mjs`: проверка Origin и `X-MCP-Hub`.
- `messaging/hub.py`: проверка Host/Origin/client header, role visibility.
- `autosend/server.mjs`: client header, точные операции задач.
- `playwright/restricted-proxy.mjs`: blocked tool and session reuse.

Опишите остаточный риск: headers на localhost — не authentication для всех локальных процессов; browser proxy блокирует ограниченный tool list, не все возможные опасные действия.

## 5. Анализ сетевого трафика

Ожидаемый transport:
- два outbound Secure MCP tunnels;
- браузерный сетевой трафик Chrome, включая веб-сайты;
- локальные loopback HTTP процессы;
- AutoSend через localhost Playwright MCP к открытому chatgpt.com.

Чтобы сделать положительное утверждение об отсутствии иных outbound endpoints, необходим **полный review исходников и runtime network trace**, а не только этот список. При анализе исключите фоновые запросы самого Chrome/OS и отметьте, какой процесс инициировал соединение.

## 6. Проверьте поведение без разрешений

1. Chrome remote debugging выключен — Browser MCP не должен молча создать другой Chromium.
2. Terminal tunnel недоступен — локальная служба не должна делать вид, что ChatGPT tool работает.
3. AutoSend без Chrome — расписание должно отложиться, без ложного verified.
4. Во время чужого черновика — AutoSend не должен заменять текст.
5. При несовпадении URL проекта — отправка не производится.
6. При возможном клике без подтверждения — unknown без автоматического повтора.
7. При повреждённой SQLite — корректный диагностический отказ, не молчаливый wipe.
8. При неверном workspace association — приложение показывает процесс, но честно сообщает, что E2E не подтверждён.

## 7. Проверьте исходный релиз, а не старую рабочую папку

```bash
git status --short
git ls-files
git log --oneline -5
```

Если вы находитесь в локальном каталоге без `.git`, не выдавайте этот каталог за исходник опубликованного релиза. Проверьте Git tag, checksum, signing identity и совпадение исходников с бинарником. До выполнения этого гейта нельзя сделать независимое supply-chain заключение.

## 8. Документирование результатов аудита

Рекомендуемый формат:
- версия/commit/платформа;
- конкретный вопрос или угроза;
- подтверждающий source path/строка;
- воспроизводимая команда;
- наблюдаемый результат (PASS/FAIL/UNKNOWN);
- оценка риска и severity;
- предложенное исправление;
- статус повторной проверки.

**Отсутствие подтверждения — не подтверждение отсутствия проблемы.**

## 9. Генерируемый реестр

См. [SOURCE_INVENTORY.md](SOURCE_INVENTORY.md). Для проверки выполните `python3 tools/generate_source_inventory.py --check`. Эта таблица показывает source-only срез, включая исторические adapters и тесты. Усечённые hashes не заменяют полную подпись публичного release.
