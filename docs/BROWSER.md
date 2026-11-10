# McpGo — PlaywrightHub, Chrome CDP и MCP safe proxy

## 1. Действующая конфигурация

```text
ChatGPT MCP client
  → browser Secure MCP Tunnel
  → 127.0.0.1:8940/mcp (restricted-proxy.mjs)
  → 127.0.0.1:8931/mcp (@playwright/mcp)
  → Chrome DevTools Protocol (CDP)
  → уже открытый личный Google Chrome
```

Параллельно `autosend/cdp-delivery.mjs` использует **тот же** safe proxy. Идея общей сессии — сохранить один backend session через последовательные кратковременные MCP подключения, чтобы Chrome не приходилось многократно подтверждать отладку после каждого tool invocation.

## 2. Точки входа

| Файл | Функция |
|---|---|
| `playwright/start.sh` | Старт `@playwright/mcp` на 8931 |
| `playwright/restricted-proxy.mjs` | Forward proxy на 8940, session reuse и фильтрация |
| `playwright/start-tunnel.sh` | Проверка proxy, outbound tunnel-client |
| `playwright/configure-tunnel.sh` | Локальная первоначальная конфигурация туннеля |
| `playwright/probe.mjs` | Read-only MCP smoke проверки |
| `playwright/smoke.mjs` | Отдельные проверки MCP транспорта |
| `playwright/package.json` | `@playwright/mcp` dependency |
| `launchers/browser.mjs` | LaunchAgent wrapper browser backend |
| `launchers/tunnel.mjs` | LaunchAgent wrapper browser tunnel |

`playwright/package.json` фиксирует `@playwright/mcp: 0.0.83`; для воспроизводимых зависимостей `npm ci` использует `package-lock.json`. На чистой машине потребуется совместимая Node.js версия; CI matrix поддерживаемых Node версий пока не объявлена.

## 3. Флаги backend

```text
--host 127.0.0.1
--port 8931
--cdp-endpoint chrome
--shared-browser-context
--caps vision,devtools
--block-service-workers
--no-webmcp
--output-dir <playwright/artifacts/shared>
--timeout-navigation 45000
```

Скрипт работает из своего каталога и не требует checkout какого-либо внешнего проекта. Он проверяет отсутствие нежелательных симлинков `node_modules`/`.cache`, затем готовит локальные каталоги temp/browsers/artifacts.

## 4. Chrome user consent

Для подключения обычного Chrome нужно открыть `chrome://inspect/#remote-debugging` и вручную разрешить remote debugging. Предоставление CDP-доступа — решение пользователя Chrome; McpGo не должен обходить системное подтверждение.

**Важная цена удобства:** это **личный Chrome** с уже открытыми вкладками, а не чистый тестовый браузер. Playwright может взаимодействовать с видимыми данными в разрешённом browser context, в том числе с авторизованными сайтами. Перед подключением стороннего MCP-клиента учитывайте этот риск.

## 5. Shared MCP session в safe proxy

`restricted-proxy.mjs` поддерживает `sharedSessionId`, `cachedInit` и `initInFlight`. Когда новый MCP-клиент вызывает `initialize`, proxy при наличии готовой upstream-сессии возвращает тот же backend session identifier; отдельный `DELETE` downstream-клиента **не** уничтожает общий upstream browser session.

Это уменьшает число повторных CDP prompts. После перезапуска proxy, backend или Chrome новое подтверждение всё равно может понадобиться.

**Сложность:** несколько внешних клиентов по сути разделяют состояние одной backend browser session. Если два клиента одновременно управляют вкладками, возможны гонки выбора вкладки. Документация **не** обещает isolation-by-client; при опасных действиях необходимы явные ограничения на параллельность и проверка точного адресата.

## 6. Tab index handling

`browser_tabs(action=list)` возвращает временные индексы. При `select` и `close` proxy вызывает `warmupTabIndices` с `action:list` в актуальной upstream-сессии, чтобы снизить риск неверных индексов после нового MCP подключения.

Это не превращает индекс в стабильный идентификатор вкладки. До и после записи проверяйте вкладку, URL и содержимое, особенно если в Chrome есть несколько одинаковых страниц.

## 7. Safe proxy: что защищено

В `restricted-proxy.mjs`:

- Разрешённый Host — `localhost:8940` или `127.0.0.1:8940`.
- Разрешённый путь — только `/mcp`.
- Ограничения request/response sizes определены константами `MAX_BODY` и `MAX_RESPONSE`.
- Запрещённый MCP инструмент — **`browser_run_code_unsafe`**; он удаляется из `tools/list` и отклоняется в `tools/call`.
- Иные инструменты Playwright MCP, если они доступны, **не** превращаются автоматически в read-only.
- Proxy не является универсальным контент-фильтром сайтов; браузерная навигация имеет широкий scope.

Нельзя писать «все опасные инструменты отключены»: код поддерживает конкретную запрещённую операцию, не формальную exhaustive threat classification.

## 8. Тестирование browser path

```bash
cd playwright
npm ci
bash -n start.sh start-tunnel.sh configure-tunnel.sh
node --check restricted-proxy.mjs
node test-access.mjs
```

Дополнительно нужны:
1. Проверка upstream MCP initialize.
2. `tools/list` через proxy без `browser_run_code_unsafe`.
3. Попытка вызова `browser_run_code_unsafe` через proxy должна быть отклонена.
4. Пять отдельных последовательных клиентов на `browser_tabs list`.
5. Проверка `select` при изменившемся списке вкладок.
6. Проверка `DELETE` одного downstream-клиента не убивает shared upstream session.
7. Проверка reconnection после перезапуска proxy и Chrome.
8. Проверка невозможности доступа к `:8940` с другого host.

Одни синтаксические тесты/открытый порт не доказывают real Chrome E2E.

## 9. Ошибки и диагностика

| Симптом | Вероятный слой | Проверка |
|---|---|---|
| `:8931` закрыт | Browser backend | launchd browser, Node dependencies |
| `:8931` открыт, :8940 закрыт | Safe proxy | launchd proxy, stderr |
| Оба порта работают, ChatGPT не видит Playwright | Browser tunnel/workspace | tunnel-client и association |
| MCP tools видны, но вкладок нет | Chrome CDP | разрешение remote debugging и используемый Chrome |
| Chrome снова запрашивает permission | Сброс shared session | перезапуски proxy/backend |
| Выбрана не та вкладка | Индексы или конкурентные клиенты | list + точный URL + последующая проверка |
| AutoSend откладывает действия | DOM busy/deferred | журнал AutoSend и точный conversation URL |

## 10. Границы открытого релиза

CDP — мощный инструмент, поэтому публичная документация обязана честно предупреждать о доступе к личному Chrome. Для будущего релиза нужны security audit, robust tab ownership, тесты race conditions и независимая portable installation. **Действующая модель не соответствует строгой multi-tenant sandbox**.

См. `playwright/README.md`, [SECURITY.md](SECURITY.md), [AUTOSEND.md](AUTOSEND.md), [VERIFICATION.md](VERIFICATION.md).


## 11. Совместимость Playwright MCP: зависающая вкладка Chrome

Версия `@playwright/mcp 0.0.83` через bundled `playwright-core` выполняет `browser_tabs(list)` в два шага: сначала `context.ensureTab()`, затем параллельно вызывает `headerSnapshot()` **для каждой открытой вкладки**. Внутри `headerSnapshot()` запрашивается `page.title()`. В личном Chrome один неотвечающий page target может оставить этот запрос незавершённым, из-за чего теряется ответ всего `browser_tabs` и AutoSend показывает тайм-аут, хотя CDP соединение браузера рабочее.

В McpGo добавлен документированный compatibility patch `playwright/patch-playwright.mjs`:
- Ограничивает ожидание заголовка каждой вкладки 2500 мс, счётчиков консоли — 1200 мс.
- Если метаданные одной вкладки не доступны, выводит пустой title, но сохраняет URL и остальные вкладки.
- Переиспользует ожидающий запрос заголовка для той же URL, предотвращая накопление незавершённых слушателей при повторных вызовах.
- Не открывает, закрывает, переключает или перезагружает вкладки.
- Применяется при `npm ci` через `postinstall` и проверяется при старте `playwright/start.sh`; при неизвестной upstream структуре завершает подготовку с ошибкой, а не молча правит другой код.

Реализация временная до upstream исправления. После обновления Playwright проверить, нужен ли патч, и удалить его только при зелёных регрессионных тестах `node --test playwright/tests/*.test.mjs` и рабочем `browser_tabs(list)` с одной зависшей вкладкой.

Различайте три уровня: WebSocket CDP handshake Chrome, реальный `browser_tabs(list)` через backend и MCP через safe proxy. Только последний отражает штатную сквозную готовность McpGo.


## Reliability 2.0: последовательные действия и durable receipts

Safe Proxy теперь сериализует `tools/call` на общей Chrome-сессии: два MCP-клиента не выполняют конкурентные действия над активной вкладкой. Изменяющие tool calls в одном JSON-RPC batch запрещены.

Инструментированные клиенты могут задавать `x-mcpgo-action-id` и `x-mcpgo-expected-url`. Перед кликом proxy убеждается в точном URL активной вкладки в той же критической секции; затем сохраняет receipt до отправки browser action. Повтор того же action ID получает HTTP 409 вместо повторной записи. `mcpgo_action_status({request_id})` даёт read-only информацию о результате.

`completed` означает получение MCP-ответа, **не** гарантированное завершение записи на сайте. `unknown` требует readback внешнего состояния. Этот механизм не заменяет явные пользовательские разрешения и не создаёт изоляцию личного Chrome.

См. [RELIABILITY.md](RELIABILITY.md) и `playwright/action-guard.mjs`.

## Диагностика повторных Allow и длинного пути установки

В установке `Library/Application Support/McpGo/Runtime` служебный Unix socket
общего браузера Playwright может превысить ограничение macOS. Симптом:
`Socket directory path is too long` после разрешения CDP, затем новое Allow
при следующей попытке. Оба launcher используют короткий каталог
`/private/tmp/mcpgo-playwright-<uid>` с правами `0700`; существующий каталог
проверяется на владельца, права и отсутствие симлинка. Данные Chrome туда
не переносятся. Сокеты создаются заново при запуске.

Фоновый статус панели выполняет MCP initialize и tools/list, без browser_tabs:
проверка статуса сама не должна запрашивать CDP-доступ. Статус MCP означает
готовность транспорта и списка инструментов, а не проверенный доступ к вкладкам.
Явная проверка при запуске и probeMcp по умолчанию сохраняют browser_tabs(list)
и сообщают об отказе Chrome. После перезапуска браузерной службы может понадобиться
одно новое подтверждение Allow; последующие вызовы используют общую сессию.

Для отката локального исправления восстановите прежние launcher и dashboard
из резервной копии и перезапустите браузерный backend, safe proxy и dashboard.
Не удаляйте активные сокеты из временного каталога во время работы службы.
