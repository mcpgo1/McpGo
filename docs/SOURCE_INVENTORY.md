# McpGo — source code inventory

Этот файл сгенерирован из **исходных файлов**, без локальных данных, compiled app, node_modules, логов, исторических backup и private configuration. SHA-256 здесь усечён до первых 16 hex **только для сравнения версий**, не для release integrity. Для проверяемых релизов нужны полные хэши артефактов и подписанные теги.

Генерация: `python3 tools/generate_source_inventory.py`. Проверка: `python3 tools/generate_source_inventory.py --check`.

| Исходный файл | Строки | SHA-256 prefix |
|---|---:|---|
| `native/InteractiveButtonStyle.swift` | 64 | `353622d1294660bc` |
| `native/McpGoMark.svg` | 16 | `26a8d0fe7e1babda` |
| `native/Messaging.swift` | 679 | `7a22813a0fa59f81` |
| `native/OnboardingView.swift` | 1999 | `d6b4836fd8a22616` |
| `native/ScheduledMessages.swift` | 652 | `30bc6ad556d129af` |
| `native/SkillsView.swift` | 213 | `1c4a2ff7fc51d11b` |
| `native/TunnelHelp.swift` | 194 | `ee2108b1554ba15f` |
| `native/TunnelSettings.swift` | 500 | `1779c3e88fbda0ca` |
| `native/build-icon.py` | 96 | `0b2e6d7941c328ac` |
| `native/main.swift` | 760 | `a2f02c8c0d5cdf34` |
| `onboarding/cli.py` | 51 | `9587904aad3b58f6` |
| `onboarding/runtime_provision.py` | 708 | `ecf504cc04f03dc1` |
| `onboarding/setup_engine.py` | 733 | `36027524dd68b246` |
| `onboarding/tests/test_runtime_provision.py` | 817 | `5fddfcf6a4c022af` |
| `onboarding/tests/test_setup_engine.py` | 372 | `cd0e616723ba85a7` |
| `scripts/build_release_dmg.py` | 419 | `e4707e007792b19a` |
| `scripts/dev_preview_macos.sh` | 214 | `43a59eb0c00b950a` |
| `scripts/launch-macos.sh` | 14 | `7d72876cae38bdef` |
| `scripts/setup_macos.py` | 187 | `5750af3e6cd14a8e` |
| `dashboard/app.js` | 34 | `7db8ef961bc65564` |
| `dashboard/index.html` | 13 | `f4e443db7adecb7f` |
| `dashboard/mcp-health.mjs` | 41 | `75681fd13113463e` |
| `dashboard/server.mjs` | 224 | `f1252da063996e66` |
| `dashboard/style.css` | 1 | `b72439eb34f8ee3e` |
| `dashboard/tests/mcp-health.test.mjs` | 25 | `6150f752c091a257` |
| `terminal/dashboard.css` | 23 | `ff26af3551f062cf` |
| `terminal/dashboard.html` | 48 | `625136ba5e9b4b49` |
| `terminal/dashboard.js` | 111 | `d417538c9648d1fd` |
| `terminal/doctor-tunnel.sh` | 9 | `75ee2ac7c68d68dc` |
| `terminal/job_runtime.js` | 316 | `d4c62a5c960e9999` |
| `terminal/job_worker.js` | 172 | `1d5b7677e2de41d1` |
| `terminal/pty_worker.py` | 101 | `b0c583da2e789dae` |
| `terminal/restart-when-idle.sh` | 15 | `8bc8901821d88efc` |
| `terminal/run-tunnel.sh` | 9 | `f295474418729a22` |
| `terminal/save-tunnel-key.sh` | 8 | `f43d8533d7294f74` |
| `terminal/server.js` | 184 | `bd62ed23e1ee53e2` |
| `terminal/stateless_server.js` | 274 | `363dd6dfd816fdc2` |
| `terminal/stdio_mcp.js` | 42 | `9845a8f09227f3c0` |
| `terminal/tests/job-runtime.test.cjs` | 169 | `c9186d06e9a7c7c5` |
| `terminal/tests/stateless-mcp.test.mjs` | 64 | `74e61bebb762a994` |
| `playwright/action-guard.mjs` | 94 | `83d203130cd90ac1` |
| `playwright/configure-tunnel.sh` | 18 | `a1d5882c9ba25069` |
| `playwright/patch-playwright.mjs` | 89 | `ad03b218318e9df7` |
| `playwright/probe.mjs` | 67 | `7b4798784dd9a7cc` |
| `playwright/restricted-proxy.mjs` | 341 | `9182bf606059ccfd` |
| `playwright/smoke.mjs` | 66 | `fc3b86bd1bcf3b65` |
| `playwright/start-tunnel.sh` | 34 | `e7137fc1a191250f` |
| `playwright/start.sh` | 19 | `c1b7937da492de41` |
| `playwright/test-access.mjs` | 9 | `95e383ec661685c6` |
| `playwright/tests/action-guard.test.mjs` | 170 | `e96d5cd71adb8cfd` |
| `playwright/tests/metadata-timeout.test.mjs` | 47 | `7d9d4086c136cd68` |
| `playwright/tests/session-recovery.test.mjs` | 89 | `7e8b6c559f7ebad7` |
| `autosend/cdp-delivery.mjs` | 279 | `e2aa4457cc4a8ea1` |
| `autosend/core.mjs` | 109 | `31238be9fd9465ac` |
| `autosend/reconciliation.mjs` | 84 | `67983faecb047daf` |
| `autosend/server.mjs` | 283 | `f25caea94c158572` |
| `autosend/stall-watchdog.mjs` | 80 | `2c806b9e2ceca060` |
| `autosend/tests/action-headers.test.mjs` | 34 | `4c56d1e04923b5ba` |
| `autosend/tests/cdp-delivery.test.mjs` | 133 | `f6688af512269a82` |
| `autosend/tests/core.test.mjs` | 86 | `576d9820fcebee19` |
| `autosend/tests/reconciliation.test.mjs` | 141 | `db4a012a4aa3f013` |
| `autosend/tests/server-http.test.mjs` | 103 | `f71afa29def7cad5` |
| `autosend/tests/stall-watchdog.test.mjs` | 168 | `d2b54391fadc43bf` |
| `messaging/hub.py` | 429 | `44ddc635a4ef9794` |
| `messaging/start.mjs` | 12 | `ae5feb8b2e914508` |
| `messaging/tests/test_bus.py` | 60 | `fe68364e10a22133` |
| `messaging/tests/test_http.py` | 93 | `5e2d25c3c4ca249d` |
| `messaging/tests/test_lifecycle.py` | 100 | `5c4129c953f89b7f` |
| `launchers/browser.mjs` | 12 | `d8438ecacaa6ece2` |
| `launchers/tunnel.mjs` | 44 | `6be75a209c2ef9ae` |
| `launchagents/com.chatterminalhub.oneshot.plist` | 23 | `8acc4462df168bc5` |
| `launchagents/com.chatterminalhub.server.plist` | 41 | `fae448e3c1945a2b` |
| `launchagents/com.chatterminalhub.tunnel.plist` | 38 | `0f724d41636bb7c9` |
| `launchagents/com.mcphub.autosend.plist` | 32 | `ca5122334ed922fe` |
| `launchagents/com.mcphub.dashboard.plist` | 34 | `04b823aa9bb8a908` |
| `launchagents/com.mcphub.messaging.plist` | 32 | `f1f5e5563fe68b95` |
| `launchagents/com.mcphub.playwright.browser.plist` | 34 | `702c65a319197666` |
| `launchagents/com.mcphub.playwright.proxy.plist` | 35 | `e4760e4e058c2f82` |
| `launchagents/com.mcphub.playwright.tunnel.plist` | 34 | `0fe40e8b964c0092` |
| `tests/test_autosend_ui_refresh.py` | 22 | `c3006466e0766479` |
| `tests/test_browser_launcher.py` | 42 | `83164b5bb4bd6880` |
| `tests/test_dmg_packaging.py` | 121 | `c98f0b577aa0b57b` |
| `tests/test_docs_release.py` | 66 | `e8443cd6e6add831` |
| `tests/test_documentation.py` | 71 | `dff2b6d0b67b88ef` |
| `tests/test_license.py` | 36 | `ae9ff572a78ee89f` |
| `tests/test_onboarding_safety.py` | 86 | `b9ceb6c28d9a236f` |
| `tests/test_terminal_tunnel.py` | 85 | `dbff99ed62fcaebb` |
| `tools/generate_source_inventory.py` | 72 | `53b34a7fe59ce01e` |
| `tools/sync_readme.py` | 23 | `fa026188f89f64b8` |

Всего файлов в выбранном source-only срезе: **89**.

Важно: отсутствие файла в этом инвентаре не доказывает отсутствие выполняемого кода где-либо на диске. Исторические или генерируемые компоненты намеренно исключены; для публичного исходного архива требуется отдельный полный аудит tree.
