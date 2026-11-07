# McpGo — данные, приватность, хранение и удаление

## 1. Реальные категории данных

| Категория | Пример | Где возникает | Потенциальная чувствительность |
|---|---|---|---|
| Agent registry | ID, роль, URL разговора | Messaging UI/API | Привязка к конкретным беседам |
| Agent messages | Текст, отправитель, получатель | Messaging queue | Содержимое рабочих поручений |
| Scheduler | URL, текст будущего сообщения, интервал | AutoSend UI | Будущее действие в ChatGPT |
| Scheduler attempts | Статус, время, причина, stage | AutoSend | Метаданные попыток |
| Terminal output | stdout/stderr, PTY | TerminalHub | Может содержать пользовательские данные |
| Browser result | DOM snapshot, элементы страницы | Playwright | Может включать данные авторизованных сайтов |
| MCP tunnel settings | ID, настройки профиля | Tunnel Settings | Данные подключения |
| Local logs | Диагностика служб | launchd/app | Могут отражать runtime ошибки |
| Chrome profile | Cookies, вкладки, авторизация | Google Chrome | Самая широкая зона пользовательского контекста |

**Не говорите «мы не обрабатываем данные» только потому, что McpGo не имеет своего облачного backend.** Инструменты имеют доступ к содержимому команд/страниц, а MCP-клиент получает ответы через туннель.

## 2. Хранилища

```text
~/Desktop/mcphub/messaging/data/messages.sqlite3
~/Library/Application Support/MCPHub/AutoSend/tasks.json
~/Library/Application Support/ChatTerminalHub/run-tunnel.sh
~/Library/LaunchAgents/*.plist
~/Library/Logs/ChatTerminalHub/
~/Desktop/mcphub/logs/
~/Desktop/mcphub/playwright/.cache/
~/Desktop/mcphub/playwright/artifacts/
Chrome user profile (управляется самим Chrome)
```

Пути здесь описывают текущую рабочую установку. `MCPHub` и `mcphub` в путях — legacy технические имена, а не публичное название продукта. Не меняйте их массово в процессе «косметического» ребрендинга.

## 3. Messaging SQLite

`messaging/hub.py` включает WAL и foreign keys. Таблицы `agents`, `messages`, `reads` описаны в [MESSAGING.md](MESSAGING.md). Файл хранит **явно опубликованные** сообщения между участниками McpGo; не копию всей истории ChatGPT.

### Консистентная резервная копия

Для работающей базы предпочтительно использовать SQLite backup API, а не копировать только основной `.sqlite3`:

```python
import sqlite3
source = sqlite3.connect("messaging/data/messages.sqlite3")
backup = sqlite3.connect("/secure/backup/messages.sqlite3")
with backup:
    source.backup(backup)
backup.close()
source.close()
```

Команда — **пример** для собственного каталога. Проверьте права, полный путь и отсутствие одновременной restore операции. Для восстановления остановите writers, проверьте integrity_check и затем запустите службу заново.

## 4. AutoSend JSON

`autosend/core.mjs`: `stateFile` может задаваться `MCPHUB_AUTOSEND_STATE`, по умолчанию используется `~/Library/Application Support/MCPHub/AutoSend/tasks.json`. Каталог создаётся owner-only; записи производятся через новый temporary file и атомарный rename.

Формат имеет `version=1`, массивы `tasks` и `attempts`. В task сохраняются: ID, URL, текст сообщения, интервал, enabled/status, timestamps, delivery_count, last_error и вспомогательное состояние. При boot `markUnknownOnBoot` не превращает прерванное потенциально отправленное сообщение в новую попытку.

**Нельзя** редактировать JSON вручную, пока процесс выполняет запись: он держит состояние в памяти и может перезаписать изменения. Для восстановления остановите scheduler, скопируйте state, проверьте формат и только затем запускайте.

## 5. Логи и временные файлы

Логи могут храниться дольше, чем окно UI показывает их. Очистка журнала попыток AutoSend удаляет entries `attempts` из его JSON-state, **но не является универсальной очисткой launchd stdout/stderr, Chrome log, Terminal job logs или архивов пользователя**.

Для диагностики сверяйте `StandardOutPath`, `StandardErrorPath` **активных** LaunchAgents. Не полагайтесь на имя файла в шаблоне, если установленная версия отличается.

## 6. Удаление данных

| Хочу удалить | Подход | Последствие |
|---|---|---|
| Одно расписание | AutoSend UI → remove | Пропадает задание; история попыток может остаться |
| Журнал попыток | AutoSend → clear_history | Сбрасываются attempts текущего хранилища |
| Архивного агента | Messaging archive → delete с точным ID | Удаляется агент и относящиеся к нему записи |
| Всю локальную очередь | Остановить Messaging и удалить/перенести DB после backup | Теряются зарегистрированные агенты и история |
| Все локальные расписания | Остановить AutoSend, сделать backup, очистить task store | Больше нет заданий; не трогает чаты ChatGPT |
| Содержимое Chrome | Использовать средства самого Chrome | McpGo не владеет жизненным циклом Chrome-профиля |
| Записи на стороне ChatGPT | Средства ChatGPT | McpGo не удаляет серверную историю чата |

**Универсального privacy eraser для всех перечисленных каталогов текущая версия не предоставляет.** Для будущего релиза нужен управляемый uninstall + data export/delete workflow.

## 7. Передача за Mac

- Terminal MCP: результаты shell могут быть доступны удалённому подключённому MCP-клиенту.
- Playwright MCP: содержимое DOM/скриншотов может возвращаться клиенту.
- AutoSend: текст отправляется через браузер пользователя в ChatGPT, как обычное сообщение.
- Messaging: локальная очередь сама не синхронизирует БД в облако, но агент может прочитать опубликованную запись через Terminal MCP и отразить её в разговоре.
- Chrome: продолжает выполнять обычный трафик авторизованных сайтов.

Нет оснований заявлять, что весь поток end-to-end шифруется отдельным ключом McpGo; используемые внешние сервисы и их транспортные контракты должны оцениваться отдельно.

## 8. Угрозы целостности

- Во время crash AutoSend может оказаться в `unknown`, но не должен повторять потенциальный клик.
- SQLite WAL + параллельные writers требуют последовательной backup/restore процедуры.
- Потеря профиля Chrome или разрешения CDP меняет способность browser tools работать.
- Изменение Bundle ID может повлиять на сохранённые системные разрешения приложения.
- Параллельный запуск **двух экземпляров** AutoSend на одном state — недопустимый режим; single-flight рассчитан на один процесс.
- Повторный запуск job после `unknown` может продублировать внешнее побочное действие.

## 9. Data retention policy — чего пока нет

Нет утверждённой единой политики сроков хранения для всех PTY/job logs, Chrome artifacts, Messaging DB, AutoSend state и backup. Это **незакрытое требование** перед публичным релизом. Нужно документировать сроки, автоматическую очистку, экспорт/удаление и пользовательские настройки.

См. [SECURITY.md](SECURITY.md), [MESSAGING.md](MESSAGING.md), [AUTOSEND.md](AUTOSEND.md), [OPERATIONS.md](OPERATIONS.md).
