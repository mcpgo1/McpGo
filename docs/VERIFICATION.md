# McpGo — доказательная проверка, CI и матрица E2E

## 1. Классы проверок

| Класс | Что подтверждает | Пример | Что не подтверждает |
|---|---|---|---|
| Static | Синтаксис и структура | `node --check`, `bash -n`, `plutil -lint` | Что сервис стартует |
| Unit | Локальные функции | SQLite lifecycle, AutoSend core | Реальную доступность ChatGPT |
| Integration | Работа процессов/API | health, status, localhost MCP | External tunnel association |
| E2E | Путь из клиента до реального результата | `terminal_exec`, `browser_tabs` | Успех всех будущих действий |
| Release | Установка на новом Mac | clean install, signature, backup | Отсутствие любых уязвимостей |
| Security | Проверка запрещённых действий | invalid Host/Origin, forbidden tool | Абсолютную защиту |

**Обязательные статусы тестового отчёта:** PASS, FAIL, SKIPPED, NOT RUN и UNKNOWN. Нельзя называть SKIPPED/NOT RUN успешным результатом. Для каждого E2E должны быть timestamp, версия, окружение и шаги воспроизведения.

## 2. Текущий набор автоматических тестов

```bash
cd /path/to/McpGo
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s messaging/tests -v
(cd autosend && node --test tests/*.test.mjs)
```

В референс-установке на 7 ноября 2026 выполнялись:
- `tests/`: 7 PASS (terminal LaunchAgent и документация).
- `messaging/tests/`: 16 PASS (логика очереди, роли, lifecycle, HTTP).
- `autosend/tests/`: 43 PASS (включая тесты исторического extension transport).

**Итого: 66 автоматических тестов PASS для этих трёх наборов.** Это не 66 независимых сценариев live-browser E2E; часть тестов использует fake DOM, mocks и совместимые старые транспорты.

## 3. Синтаксическая и структурная проверка

```bash
node --check dashboard/server.mjs
node --check autosend/server.mjs
node --check autosend/cdp-delivery.mjs
node --check playwright/restricted-proxy.mjs
bash -n playwright/start.sh playwright/start-tunnel.sh playwright/configure-tunnel.sh
python3 -m py_compile messaging/hub.py
plutil -lint "McpGo.app/Contents/Info.plist"
codesign --verify --strict "McpGo.app"
```

Эта проверка не требует действующего Chrome. Но проверка `codesign` локального ad hoc bundle не устанавливает юридическую идентичность издателя.

## 4. Terminal MCP E2E

Проводить из разрешённого ChatGPT MCP-клиента:
1. Убедиться, что `com.chatterminalhub.oneshot` и `com.chatterminalhub.tunnel` живы.
2. Выполнить `terminal_exec` с безопасной командой, например `pwd`.
3. Проверить структуру ответа: `exit_code=0`, отсутствие timeout и spawn_error.
4. Выполнить `job_start` с короткой идемпотентной read-only командой.
5. Получить `job_status` до terminal state.
6. Прочитать `job_logs`, проверить сохранённое содержимое.
7. Проверить ограничение некорректного `cwd` и timeout.
8. Проверить, что другой chat session не может использовать чужую пару PTY id/key.

**Не** использовать удаление, деплой и запись чужих файлов в smoke test.

## 5. Browser MCP E2E

1. В личном Chrome вручную включить CDP.
2. Проверить backend :8931 и safe proxy :8940.
3. Вызвать `tools/list` через proxy: `browser_run_code_unsafe` должен отсутствовать.
4. Попытаться вызвать запрещённый tool через proxy: ожидается отклонение.
5. Выполнить пять независимых последовательных MCP-клиентов на `browser_tabs(list)`.
6. Проверить `select` после обновления списка индексов.
7. Протестировать `DELETE` одного downstream session: upstream browser session должна сохраниться.
8. Протестировать restart proxy; допускается новое подтверждение отладки Chrome.
9. Протестировать неправильный Host/путь `/mcp`, слишком большой request.
10. Проверить доступ именно к личному Chrome, а не отдельному тестовому Chromium.

Каждый шаг должен фиксировать **фактическое** состояние, без утверждений о системных разрешениях по одному логу.

## 6. AutoSend E2E — только в тестовом чате

Тест требует явного разрешения владельца и выделенного существующего ChatGPT разговора. Рабочие чаты не использовать.

| Сценарий | Ожидаемое состояние | Критерий |
|---|---|---|
| Агент сейчас отвечает | deferred/busy | Не было клика |
| На странице черновик пользователя | deferred/busy | Черновик не перезаписан |
| URL проекта не совпадает | deferred | Отправка не выполнялась |
| Страница авторизации/нет редактора | deferred | Не было клика |
| Готовый тестовый чат | verified | Одна новая реплика пользователя |
| Клик, но наблюдение прервалось | unknown | Автоматический повтор запрещён |
| Restart между preflight и click | безопасно восстанавливается | Нет дубликата |
| Restart после click-committed | unknown | Нет повторной отправки |
| Chrome закрыт | deferred | Расписание ждёт |
| Mac спал в момент расписания | позже либо skipped | Точная секунда не гарантируется |

Проверка `verified` **не является** проверкой того, что ассистент закончил отвечать. Для продолжения поручения нужен отдельный контроль результата.

## 7. Messaging E2E

1. Создать двух агентов и оркестратора в тестовой БД.
2. Отправить персональное и broadcast сообщение.
3. Убедиться, что адресат видит только разрешённые публикации.
4. Убедиться, что `ack` чужого message ID отклоняется.
5. Опубликовать report, проверить направление действующему orchestrator.
6. Архивировать, восстановить и заменить agent ID.
7. Проверить перенаправление непрочитанных **direct** сообщений и запись последнего отчёта.
8. Проверить уникальность оркестратора.
9. Удалить архивного агента с точным подтверждением на изолированной БД.
10. Проверить SQLite integrity.

## 8. Release acceptance matrix

| Область | На локальном Mac проверено | Для публичного релиза |
|---|---|---|
| SwiftUI arm64 compile | PASS | Чистый CI build |
| Ad hoc codesign + plist | PASS | Developer ID + notarization |
| Terminal tunnel regression | PASS | Clean install / actual MCP E2E |
| Messaging unit/HTTP | PASS | Multi-process stress/backup |
| AutoSend unit suite | PASS | Live ChatGPT E2E на новой версии UI |
| Chrome CDP local proxy | Status alive | Full multi-session and security E2E |
| Portable installer | NOT DONE | Требуется |
| Public dependency/SBOM scan | NOT DONE | Требуется |
| License verification | NOT DONE | Требуется |
| User data retention | NOT DONE | Требуется policy + тесты |

## 9. CI план

Рекомендуемые GitHub Actions jobs:
1. `lint`: Markdown links, Python, Node, shell, plist.
2. `unit`: tests Python/Node с isolated temp data.
3. `swift-build`: pinned macOS runner + Xcode.
4. `security-static`: detect secrets/configs/binaries in source archive, dependency audit.
5. `packaging`: build icon/bundle, sync skills, sign test bundle.
6. `installer-smoke`: clean macOS user profile с актуальными путями.
7. `release`: human-approved signing/notarization, checksums, SBOM.

Не утверждается, что эти jobs уже настроены. Это приемочная спецификация будущего открытого репозитория.

## 10. Проверки документации

`tests/test_documentation.py` должен проверять:
- все обязательные главы существуют;
- Markdown links не битые;
- действующая публичная документация не содержит имен посторонних проектов;
- браузерные launch scripts не зависят от внешней git-ветки;
- ссылка в SwiftUI sidebar открывает `docs/README.md`.

Наличие теста не заменяет ручную проверку содержательных утверждений с актуальной реализацией.
