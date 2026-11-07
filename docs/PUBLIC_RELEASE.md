# McpGo — публичный релиз и готовность open source

**Статус:** этот документ описывает **невыполненные условия** первого публичного выпуска. Ни один пункт не объявляется готовым только на основании локального успешного запуска. Подготовить документацию в стиле open source — не то же самое, что опубликовать проект под open-source лицензией.

## 1. Нормативные определения

**Исходный код доступен** — читатель может посмотреть файлы.
**Open source** — код распространяется под лицензией, дающей права на использование, изучение, изменение и распространение в рамках утверждённых условий.
**Reproducible build** — третья сторона может повторить сборку из определённого commit и задекларированных зависимостей, а расхождения объяснимы.
**Подписанный релиз** — артефакт связан с конкретной идентичностью издателя; локальная ad hoc подпись не является этим доказательством.
**Secure MCP tunnel** — транспортный механизм к выбранному MCP endpoint, не отдельное утверждение о безопасности всех команд.

## 2. Лицензия

`LICENSE` в текущей рабочей папке не выбран. Нельзя самовольно писать в README «MIT/Apache-2.0» или добавлять лицензию вместо владельца.

Перед открытием:
- определить правообладателей исходников;
- выбрать совместимую OSI-approved лицензию;
- проверить совместимость со сторонними зависимостями и включёнными материалами;
- добавить полный `LICENSE`, copyright notices, при необходимости `NOTICE`;
- указать SPDX identifiers для собственных файлов по принятому стандарту;
- обновить заголовок README и packaging metadata.

До этого **не делать публичных заявлений о юридическом статусе McpGo как open source**.

## 3. Source-only экспорт

Рабочая папка включает bundle, исторические бинарники, результаты сборок, локальные базы и runtime-кэши. **Нельзя публиковать содержимое папки целиком**.

Публикация должна идти из нового очищенного source tree с проверенной структурой. Рекомендовано:
1. Определить whitelist исходных каталогов/файлов.
2. Исключить рабочие `*.app`, `native/MCPHub*` binaries, `logs/`, `messaging/data/`, `playwright/.cache/`, `artifacts/`, node_modules, локальные configuration stores и backup directories.
3. Перепроверить все документы и скрипты на абсолютные пути/личные machine-specific значения.
4. Провести source archive review **после** применения `.gitignore`; сам `.gitignore` — не гарантия.
5. Создать новый Git repository и проверить его tree перед первым push.
6. Настроить branch protection, code review, security reporting и release policy.

## 4. Portable configuration

Текущее приложение использует legacy `<INSTALL_ROOT>` в части SwiftUI/backend/plist. Для независимой установки:
- заменить физические пути на app/installation root resolver и OS environment;
- выделить `config.example` без пользовательских значений;
- сделать single-source registry ports/paths/labels;
- внедрить idempotent installer, upgrade и rollback;
- избежать двойного AutoSend instance на одном state;
- проверить macOS permissions/Keychain после смены bundle ID;
- обеспечить миграцию старого пользователя без потери SQLite и расписаний;
- добавить uninstall c отдельным запросом на удаление данных.

## 5. Build provenance

Перед релизом зафиксировать:
- supported macOS arch/version;
- Xcode/Swift, Node, Python версии;
- зависимости и lockfiles всех модулей;
- SHA256 исходных архивов и готовых артефактов;
- SBOM с direct/transitive dependencies;
- обновления и security audit зависимостей;
- проверенный процесс сборки на чистом CI runner;
- Developer ID signing, notarization и проверку Gatekeeper;
- versioning и changelog.

Вместо заявления «ничего вредного» следует публиковать **проверяемую цепочку** от commit до бинарника.

## 6. Threat model и внешние права

Пользователь должен видеть **до включения**:
- TerminalHub выполняет команды от имени пользователя macOS.
- PlaywrightHub получает доступ к уже открытому личному Chrome по CDP.
- Browser proxy фильтрует конкретный инструмент, но не изолирует остальные browser actions.
- Secure MCP Tunnel связывает локальный runtime и выбранный workspace.
- AutoSend вводит текст в ChatGPT от лица текущего Chrome session и не подтверждает готовность ответа.
- Messaging хранит явно опубликованную локальную очередь, а не произвольную историю ChatGPT.

Нужны подтверждённые сценарии отказа при отключении Chrome/tunnel, проверка Host/Origin, разграничение клиентов и ясная граница доверия.

## 7. Privacy и управление данными

До публичного выпуска утвердить:
- какие категории хранятся и где;
- когда какие данные покидают Mac;
- сохраняются ли тела задач и дом-результаты;
- сроки retention для logs, jobs, messages и artifacts;
- export/delete workflow;
- backup/restore и права пользователя;
- понятный uninstall, который не удаляет Chrome profile;
- короткую user-facing privacy notice.

Нельзя утверждать «zero data leaves the computer», поскольку MCP и Chrome передают данные внешним сторонам.

## 8. Список публичных страниц

| Файл | Назначение | Статус |
|---|---|---|
| `README.md` | Функции, риски, quick start | Есть, требуется portable screenshots |
| `docs/README.md` | Полная техническая карта | Есть |
| `docs/SECURITY.md` | Threat model | Есть, ещё нужен публичный contact |
| `CONTRIBUTING.md` | Процесс участия | Есть |
| `CHANGELOG.md` | История | Есть |
| `LICENSE` | Юридические права | **Отсутствует** |
| `SECURITY.md` в корне | Responsible disclosure policy | **Отсутствует/не настроена** |
| `CODE_OF_CONDUCT.md` | Нормы сообщества | Не утверждён |
| `SUPPORT.md` | Каналы поддержки | Не утверждён |
| `docs/PACKAGING.md` | Сборка и релиз | Есть, installer ещё отсутствует |
| SBOM / checksums | Supply chain | Не опубликованы |
| GitHub workflows | CI/CD | Не созданы |
| Clean-room installer | Новый Mac | Не подтверждён |

Отсутствие перечисленных функций — **публичный статус проекта**, не повод подменять их декоративными badges.

## 9. Acceptance gates

### Gate A — source hygiene
- [ ] Создан чистый Git root.
- [ ] Нет личных runtime artifacts в tracked files.
- [ ] Проверена лицензия.
- [ ] Все зависимости имеют допустимые license notices.
- [ ] Нет machine-specific конфигурации в примерах.

### Gate B — install/build
- [ ] Clean macOS install без существующего профиля владельца.
- [ ] Portable CLI/config.
- [ ] User launchd services установлены/удалены идемпотентно.
- [ ] Codesign + notarization.
- [ ] Документированный обновлятор/rollback.
- [ ] Установка не требует стороннего проекта.

### Gate C — behavior
- [ ] Terminal and Browser MCP E2E.
- [ ] Несколько browser MCP sessions и session/reconnect tests.
- [ ] AutoSend DOM E2E на выделенном test chat.
- [ ] SQLite backup/restore under WAL.
- [ ] Нет дубликатов при click-committed restart.
- [ ] Удаление одной службы не стирает чужие данные.

### Gate D — community
- [ ] Security reporting channel.
- [ ] Support/version policy.
- [ ] Contributor review workflow.
- [ ] Public reproducible checksums/provenance.
- [ ] Разъяснены реальные права доступа Terminal/Chrome.

Только после выполнения этих gates можно предлагать McpGo как воспроизводимо устанавливаемый публичный инструмент, а не частную рабочую конфигурацию.

## 10. Как развеять опасения будущего пользователя

**Не просить «просто довериться».** Дайте точную ссылку на tagged source, reproducible build и подпись, наглядный список доступов, объяснение outbound endpoints, способ посмотреть процессы и выключить всё, инвентарь локальных данных, clean uninstall и документированный security report process.

Самое сильное доказательство — независимо повторяемая сборка и проверка исходного кода, а не большой рекламный раздел «мы безопасны».

## 11. Проверка source tree

Сопоставьте [SOURCE_INVENTORY.md](SOURCE_INVENTORY.md) с фактическим `git ls-files` и public source archive. Для supply-chain проверки нужны полные SHA-256, SBOM, подписанные tags и binaries.

## 12. Зависимости и SBOM

См. [DEPENDENCIES.md](DEPENDENCIES.md): там записаны текущие pinned версии Playwright MCP и транзитивные зависимости, а также наблюдаемые версии toolchain в референс-установке. Для публичного релиза мини-инвентарь должен быть заменён полным SBOM с provenance.

## Мастер первого запуска

Реализован UI и безопасное provisioning. Реальные туннели, подписанный release и ChatGPT end-to-end требуют отдельной приёмки на чистом Mac. См. [ONBOARDING.md](ONBOARDING.md).
