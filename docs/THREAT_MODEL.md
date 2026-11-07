# McpGo — модель угроз и реестр доверия

Документ предназначен для пользователей, которые хотят не верить маркетинговым заявлениям, а понять **кто может сделать что**. Оценка относится к текущей локальной конфигурации и не является сертифицированным pentest.

## 1. Активы и доверенные стороны

| Актив | Где расположен | Кто потенциально имеет доступ |
|---|---|---|
| Файлы Mac пользователя | Файловая система владельца | TerminalHub от имени user, другие процессы user |
| Открытые вкладки и учётные сессии Chrome | Личный Google Chrome | Пользователь и разрешённый Chrome CDP client |
| Terminal session capability | Память `terminal/server.js` | Клиент, получивший id/key, локальный контролирующий процесс |
| MCP tool surface | Tunnel association / runtime | Разрешённый ChatGPT MCP client |
| Агентская очередь | SQLite | Messaging process и локальные процессы владельца |
| Сохранённые расписания | AutoSend JSON | AutoSend process, локальный владелец |
| Процесс управления launchd | Dashboard | Локальный SwiftUI/API клиент с доступом к loopback |
| Подписанный app bundle | McpGo.app | macOS, пользователь, установщик/обновлятор |

## 2. Главные направления риска

```text
Внешняя LLM-инструкция/результат
 → MCP tool call
 → локальный терминал или browser tool
 → побочный эффект на Mac / в авторизованном веб-сервисе
```

```text
Веб-страница (недоверенный DOM)
 → browser_snapshot / browser_evaluate
 → MCP client или AutoSend logic
 → возможно неверный выбор элемента/вкладки/действия
```

```text
Скомпрометированный локальный процесс того же пользователя
 → localhost HTTP / SQLite / app files
 → изменение управления или сохранённых задач
```

Loopback снижает сетевую экспозицию, **но не превращает одноимённые macOS user-процессы в независимые изолированные аккаунты**.

## 3. STRIDE-матрица

| Класс | Пример атаки/сбоя | Реальный контроль | Остаточный риск |
|---|---|---|---|
| Spoofing | Локальный процесс имитирует native HTTP client | Host/Origin/client headers | Headers не криптографическая идентичность |
| Tampering | Изменение `tasks.json` или SQLite под правами user | Owner-only FS permissions, atomic rename | Владелец user может менять файлы |
| Repudiation | Нельзя установить итог после клика | Attempt log, click-committed state | DOM verification может быть неоднозначным |
| Information disclosure | MCP получает DOM приватного сайта | Workspace/client restrictions | Личный Chrome — широкий контекст |
| Denial of service | Ошибка proxy/Chrome/LaunchAgent | Раздельные службы, локальный restart | Нет HA, Mac/Chrome single point |
| Elevation of privilege | Terminal tool выполняет нежелательную команду | Права macOS user, подтверждения пользователя | Нет sandbox на уровне всех shell команд |

## 4. Browser-specific threats

**Prompt injection:** текст посещаемого сайта может содержать инструкции. Для MCP-клиента это данные веб-страницы, а не разрешение на изменение системы. Не интерпретировать page content как системный policy.

**Tab confusion:** общий backend session и меняющиеся индексы вкладок делают опасной запись по устаревшему `index`. Proxy обновляет mapping перед select/close, но это не формальное доказательство владения вкладкой.

**DOM drift:** ChatGPT может изменить селекторы полей/кнопок. AutoSend должен остановиться до клика при неоднозначном редакторе, а после возможного клика перейти в unknown.

**Authenticated actions:** даже если McpGo не сохраняет пароль сайта, Playwright может управлять вкладкой, где пользователь уже авторизован. Разрешённый MCP tool имеет практическую возможность совершать действия от текущей веб-сессии.

## 5. Terminal-specific threats

**Unexpected shell effects:** команды выполняются через zsh/PTY с правами текущего user. Изоляция словом «safe» в названии инструмента отсутствует.

**Long-running child:** detached job может продолжиться вне текущего HTTP request. Возвращённый job_id не является свидетельством завершения.

**Timeout ambiguity:** после timeout нельзя знать, что внешние записи не произошли. Нужна отдельная проверка effect, прежде чем повторять команду.

**Output disclosure:** stdout/stderr могут содержать результаты чтения пользовательских данных, возвращаемые через MCP. Для каждого клиентского подключения должны быть понятны рабочие полномочия.

## 6. AutoSend-specific threats

**Wrong recipient:** совпадение одного UUID или похожего названия проекта не достаточно; нужен точный conversation URL.

**Duplicate:** ошибка между click и наблюдением DOM. Защита — persist barrier до click, unknown без auto retry. Это ослабляет риск дубликата, но не создаёт формальной exactly-once семантики.

**Busy-agent overlap:** UI может показывать streaming/stop признаки. DOM-эвристика способна ошибаться. При неясности безопаснее deferred, а не send.

**User draft collision:** существующий черновик не должен перезаписываться. При pre-click cleanup удаляется только текст, введённый самой попыткой и только при точном совпадении.

## 7. Supply-chain threats

Публичный репозиторий должен позволять ответить:
- какой commit соответствует этому бинарнику;
- какие версии `@playwright/mcp`, Node, Python, Swift/Xcode используются;
- что скачивает installer и по каким проверенным адресам;
- где хранятся third-party notices и SBOM;
- кто подписал macOS-приложение и опубликован ли checksum;
- выполняется ли код вне явно заявленных локальных служб.

Пока отсутствует полный чистый source-release pipeline. Следовательно, **нельзя обещать reproducible supply-chain security**.

## 8. Управление безопасностью

**Меры, которые уже можно проверить:** loopback bind, session capability для PTY, scope запрета browser unsafe tool, структурные ограничения request size, DOM gate AutoSend, auto retry запрет после click, SQLite-правила, наличие code tests.

**Не подтверждено:** внешний аудит, bug bounty, формальная модель прав всех MCP tools, гарантированная изоляция Chrome, дистрибутив с Developer ID/notarization, независимый pentest.

## 9. Пользовательское согласие

Перед включением нужно прямо сказать, что TerminalHub может выполнять shell-команды, а PlaywrightHub — взаимодействовать с личными авторизованными вкладками. Сокрытие этих полномочий было бы существенно хуже, чем подробное объяснение рисков.

## 10. Приёмка security-аудита

1. Static source review и dependency scan.
2. Проверка неверных Host/Origin/paths.
3. Негативный тест запрещённого `browser_run_code_unsafe`.
4. Race tests двух одновременных browser clients.
5. Проверка запрета auto retry после click crash.
6. Проверка локальной доступности SQLite/task state.
7. Чистая установка на новом user без сторонних данных.
8. Архивирование audit notes и remediation tracker.

**Данный документ — threat model, не security certification.** Для release security policy см. [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md).
