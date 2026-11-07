# McpGo — нативное приложение SwiftUI (macOS)

## 1. Файловая структура

| Файл | Назначение |
|---|---|
| `native/main.swift` | Тема, `HubModel`, Dashboard, Sidebar, окно `@main McpGo` |
| `native/Messaging.swift` | `MessagingView`, локальный HTTP клиент, роли и сообщения |
| `native/ScheduledMessages.swift` | `ScheduledMessagesView`, CRUD расписаний, журнал |
| `native/TunnelSettings.swift` | Параметры двух туннелей и macOS Keychain |
| `native/TunnelHelp.swift` | Инструкции настройки tunnel/workspace |
| `native/SkillsView.swift` | Четыре Markdown-навыка |
| `native/InteractiveButtonStyle.swift` | Единый hover/press feedback |
| `native/build-icon.py` | Генератор PNG/iconset/icns из программной геометрии |
| `native/McpGoMark.svg` | Исходный SVG знака infinity + Play |

## 2. Жизненный цикл окна

Корневой тип — `@main struct McpGo: App`; отображаемый бренд — `McpGo`. Текущий bundle по-прежнему использует legacy `CFBundleExecutable=MCPHub` и `CFBundleIdentifier=local.mcphub.native`: это внутренние идентификаторы, не старое имя UI.

`HubModel` — `@MainActor ObservableObject`: хранит `state`, `busy`, `error`, `notice`, `updated`. В `init` запускает периодическую проверку Dashboard примерно раз в **4 секунды** и вызывает первичный `refresh()`.

`refresh()` обращается к `http://127.0.0.1:8969/api/status`, декодирует `HubState`; при первой неудаче пробует `launchctl bootstrap` службы Dashboard, затем повторяет. Это bootstrap-помощь для существующего installed plist, **не универсальная установка McpGo с нуля**.

## 3. Отображение статусов

`TerminalState` содержит `server`, `oneshot`, `tunnel`. `BrowserState` содержит `browser`, `proxy`, `tunnel`, `backend`, `proxyReady`, `configured`. Каждая `AgentState`: `loaded`, `running`, `pid?`.

Обновление UI происходит при декодировании ответа, но **не проверяет автоматически** подключение к ChatGPT workspace и разрешения MCP клиента. Поэтому рядом с процессным статусом должна оставаться отдельная практическая проверка MCP tools.

## 4. Команды запуска

Кнопки `Запустить`, `Стоп`, `Рестарт` вызывают `HubModel.perform(action,group)`. Он отправляет `POST /api/action` с JSON `{group,action}`, клиентским заголовком `X-MCP-Hub: dashboard` и ожидаемым `Origin`. Ответ должен содержать `ok=true`; затем UI обновляет состояния.

Управление асинхронное, `busy` блокирует дублирующие действия. **Не** трактуйте принятый HTTP запрос как автоматическое подтверждение успешного исходящего MCP туннеля; проверяйте tools отдельно.

## 5. Боковая панель

Разделы включают обзор служб, сообщения агентов, отложенную доставку, настройки туннелей и навыки. В нижней части:
- «Папка MCP» открывает текущий physical root через `NSWorkspace.shared.open`.
- «Журналы» открывает `/logs`.
- **«Документация» открывает `/docs/README.md`**, то есть этот индекс, а не устаревший корневой README.

`openFolder(_ path)` собирает путь относительно текущего `HubModel.root`; пока этот root содержит абсолютный путь референс-установки, новая машина требует подготовки portable path resolution.

## 6. Вкладка «Связь агентов»

`Messaging.swift` работает с локальным Messaging API на 8971 и использует старый совместимый заголовок `X-MCPHub-Client: native`. UI умеет назначать роли, регистрировать/архивировать/восстанавливать агента, читать опубликованную историю, подтверждать обработку и заменять исчерпанный разговор.

Модель UI обновляет состояние примерно раз в **5 секунд**. Локальный backend в ответах возвращает только очередь McpGo, не закрытый ChatGPT transcript.

## 7. Вкладка «Сообщения по таймеру»

`ScheduledMessages.swift` работает с AutoSend HTTP на 8972 и локальным native header. Поддерживает создание, редактирование, включение, паузу, разовую попытку, удаление задания и просмотр/очистку журнала; backend enforce-ит запрет на опасное изменение `checking/sending`.

В интерфейсе нужно различать `scheduled`, `checking`, `sending`, `paused`, `unknown`, а также отдельную диагностику CDP. `unknown` после возможного клика нельзя сбрасывать автоматически.

## 8. Вкладка «Настройки туннелей»

Два разных подключения — TerminalHub и PlaywrightHub. Настройки должны ссылаться на соответствующие ID и runtime-конфигурацию. Не копируйте один tunnel ID «для удобства»: так легко перепутать workspace/tool authority.

Разрешения macOS и Keychain принадлежат текущему пользователю. Изменение Bundle ID в будущем может изменить доступ к прежним ресурсам; поэтому оно требует теста миграции, а не только переименования строки.

## 9. Вкладка «Навыки инструментов»

`SkillsView.swift` читает четыре `skills/<id>/SKILL.md`, но **подписанные ресурсы bundle имеют приоритет**. Если менять только внешние файлы на диске, вкладка может показывать предыдущую версию. Релизный процесс обязан синхронизировать `Contents/Resources/skills` перед подписью.

«Скопировать для чата» вставляет Markdown-инструкцию в копируемый текст; это не автоматическая установка новых tools, не изменение разрешений MCP и не механизм скрытого автозапуска.

## 10. Branding и assets

Иконка №4 — infinity/play, SVG кривые Безье, генератор `native/build-icon.py` создаёт `AppIcon.iconset` и `AppIcon.icns`; `McpGoMark.png` используется в sidebar, `.icns` — Dock/Finder. Генерированные ресурсы после изменений нужно скопировать в bundle и повторно подписать.

## 11. Ошибки UI

| Симптом | Где искать |
|---|---|
| Старая надпись после обновления | Выполняется старый PID приложения; закрыть/открыть новое bundle |
| Обзор не отвечает | `com.mcphub.dashboard`, :8969, `HubModel.refresh` |
| Запущен процесс, но MCP не виден | Проверить tunnel/workspace и реальный tools/call |
| Навык не обновился | `Resources/skills`, подпись bundle |
| AutoSend показывает unknown | Не повторять; журнал и точный чат |
| Кнопка открытия документации не работает | `SidebarLink`, существование `docs/README.md`, root path |
