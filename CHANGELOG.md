# Changelog

Все существенные изменения продукта McpGo отражаются здесь. Для автоматического релиза и SemVer-политики пока не настроена единая публичная CI/CD-схема; даты относятся к локальной референс-установке, не к опубликованным GitHub releases.

## Unreleased — 2026-11-07

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
