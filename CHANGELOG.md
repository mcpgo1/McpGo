# Changelog

Все существенные изменения продукта McpGo отражаются здесь. Для автоматического релиза и SemVer-политики пока не настроена единая публичная CI/CD-схема; даты относятся к локальной референс-установке, не к опубликованным GitHub releases.

## 2.0.3 — 2026-11-08 (локальная сборка)

- В справочном скриншоте шестого шага первого подключения скрыта значимая часть Tunnel ID непрозрачной заливкой; персональный идентификатор нельзя прочитать из опубликованного изображения.
- Обновлены ресурсы мастера первого запуска для macOS DMG.
- Подготовлен план будущего восстановления терминального и браузерного туннелей в docs/TUNNEL_RECOVERY_PLAN.md; supervisor ещё не реализован.
- Предыдущую DMG 2.0.2 с исходной фотографией использовать для распространения нельзя.

## AutoSend delivery reliability — 2026-11-07

- Added persistent `verifying` after a click when ChatGPT DOM does not immediately show a new user message.
- Added read-only 180-second reconciliation with 12-second intervals; never clicks Send again.
- Persists a minimal click receipt and SHA-256 fingerprint rather than a previous private chat message.
- Restores safe reconciliation on restart without automatic resends.
- Improved user-bubble detection under virtualized chat DOM and new message IDs.
- Distinct UI labels for busy/deferred/verifying/unknown, with verification progress.
- Added regression tests for delayed acknowledgement, lost tab, restart and timeout.

## Unreleased — 2026-11-07

### Open-source licensing
- Adopted the MIT License for original McpGo source and documentation.
- Documented third-party Apache-2.0 dependencies and external components separately.
- Updated README, contribution guidance, FAQ, release checks and npm package license metadata.


### First-run Secure MCP onboarding
- Added seven-step native SwiftUI wizard and resumable protected state.
- Scoped remote provisioning/import with no blind retry after unknown remote outcomes.
- Generated local HTTP tunnel profiles via official CLI init.
- Reused Keychain runtime credentials and guarded existing installations.
- Added read-only MCP checks, tunnel-client doctor and ChatGPT handoff.
- Added provisioning tests and technical onboarding guide.


### AutoSend confirmation with modern ChatGPT DOM
- Recognize user message bubbles when historical `data-message-author-role` selectors disappear.
- Require an increased user-message count and exact last message text for post-click verification; never use assistant echoes or main text as proof.
- Added a regression for uncertain post-click outcomes, retaining no-auto-retry behavior.


### Browser MCP session and Chrome-tab resilience
- Recover stale shared sessions for read-only MCP calls without replaying mutating actions.
- Dashboard readiness now verifies actual MCP tools and Chrome tab listing, rather than checking only TCP ports.
- Bound per-tab metadata reads in pinned Playwright MCP dependency; reuse pending metadata requests for unresponsive tabs.
- Apply and verify the patch through npm postinstall and browser startup.
- Added mock session recovery, MCP health and actual patched headerSnapshot regression tests.

### Public documentation expansion
- Added verified runtime dependency inventory and upstream license metadata in `docs/DEPENDENCIES.md`.
- Canonical `docs/README.md` expanded into an engineering documentation portal.
- The GitHub root `README.md` is generated from the same source through `tools/sync_readme.py`.
- Added comprehensive chapters for components, UI, terminal, browser, messaging, data, failures, packaging, verification, public-release readiness, threat model, independent audit and FAQ.
- Added reproducible source inventory generator and documentation regression checks.
- Explicitly documented non-portable install state, missing public license/release signing and absence of independent external security certification.
- No scheduled messages or production browser actions are performed by documentation tests.


### Documentation
- Кнопка «Документация» направлена на `docs/README.md` — индекс технического справочника.
- Добавлены руководства по независимой установке, конфигурации, модели доверия, API, AutoSend, сопровождению и участию в разработке.
- Активные руководства и Agent Skills приведены к самостоятельной архитектуре McpGo, без привязки к стороннему приложению.
- Разделены фактическая локальная реализация и требования к будущему переносимому публичному релизу.

### Playwright
- `start.sh`, `start-tunnel.sh` и `configure-tunnel.sh` определяют корень браузерного модуля относительно собственного расположения и больше не проверяют внешний Git checkout/branch.
- Диагностический `test-access.mjs` проверяет доступность файлов самого браузерного компонента.

## 2026-11-06 — McpGo naming and CDP

- Продукт и приложение переименованы в **McpGo**; legacy system IDs сохранены как контракт совместимости.
- Браузерный режим: личный Chrome через CDP, без отдельного Chromium.
- Планировщик AutoSend использует Playwright MCP safe proxy.
- Зафиксирована установка terminal tunnel wrapper из `~/Library/Application Support/ChatTerminalHub`.
- Добавлены первые канонические технические документы.

## Исторические версии

Ранее существовавшие реализации доставки с MV3 Extension/Native Messaging оставлены в исходниках как исторический контекст. Они не являются активным режимом AutoSend и не должны включаться параллельно CDP delivery.

### Interrupted-response auto-continuation

- Detect stable explicit ChatGPT interruption; recover quickly by refreshing exact tab once.
- Resume schedule immediately only after a clean, independently confirmed ready state.
- Do not interrupt healthy long tasks or send while Stop/streaming remains active.


## Reliability 2.0 — 2026-11-08
- Added durable job start idempotency with stable `request_id`, exclusive claims and recovery by `job_recent`.
- Added `job_watch`, `job_output`, `job_result`, `job_cancel`, progress markers, 5-second heartbeat and final result checksums.
- Retains up to 64 MiB of each output stream and pages it without duplicating jobs.
- Serializes shared Chrome MCP calls, refuses mutating batches, offers durable browser action receipts and `mcpgo_action_status`.
- AutoSend click now supplies stable action ID and exact expected chat URL; proxy verifies the active tab before acting.
- Added isolated terminal/MCP/browser regression tests. No real ChatGPT messages were sent.

- Recover finished jobs from durable result.json after crash between completion receipt and status update.
- Report 30-second stale runner heartbeat as `stalled` rather than indefinitely `running`. Never auto-retry or cancel uncertain work.
