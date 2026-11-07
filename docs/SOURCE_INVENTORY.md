# McpGo — source code inventory

Этот файл сгенерирован из **исходных файлов**, без локальных данных, compiled app, node_modules, логов, исторических backup и private configuration. SHA-256 здесь усечён до первых 16 hex **только для сравнения версий**, не для release integrity. Для проверяемых релизов нужны полные хэши артефактов и подписанные теги.

Генерация: `python3 tools/generate_source_inventory.py`. Проверка: `python3 tools/generate_source_inventory.py --check`.

| Исходный файл | Строки | SHA-256 prefix |
|---|---:|---|
| `native/InteractiveButtonStyle.swift` | 64 | `353622d1294660bc` |
| `native/McpGoMark.svg` | 16 | `26a8d0fe7e1babda` |
| `native/Messaging.swift` | 679 | `7a22813a0fa59f81` |
| `native/OnboardingView.swift` | 466 | `5132cf87ca456a41` |
| `native/ScheduledMessages.swift` | 587 | `c782c9f7f9cf09f3` |
| `native/SkillsView.swift` | 213 | `1c4a2ff7fc51d11b` |
| `native/TunnelHelp.swift` | 194 | `ee2108b1554ba15f` |
| `native/TunnelSettings.swift` | 500 | `1779c3e88fbda0ca` |
| `native/build-icon.py` | 96 | `0b2e6d7941c328ac` |
| `native/main.swift` | 668 | `9234cabbc398560a` |
| `onboarding/cli.py` | 47 | `91d9eef364fa64d6` |
| `onboarding/setup_engine.py` | 624 | `0b0f5b264dd70b77` |
| `onboarding/tests/test_setup_engine.py` | 212 | `9ee4f8d6581e6a72` |
| `scripts/launch-macos.sh` | 14 | `7d72876cae38bdef` |
| `scripts/setup_macos.py` | 166 | `ea1b7d3a5299edcb` |
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
| `terminal/job_runtime.js` | 118 | `4c3873aa51d41cae` |
| `terminal/job_worker.js` | 100 | `df0a9803834bfcf8` |
| `terminal/pty_worker.py` | 101 | `b0c583da2e789dae` |
| `terminal/restart-when-idle.sh` | 15 | `8bc8901821d88efc` |
| `terminal/run-tunnel.sh` | 9 | `8360935db4c1347b` |
| `terminal/save-tunnel-key.sh` | 8 | `f43d8533d7294f74` |
| `terminal/server.js` | 184 | `8409f8e8551a81a9` |
| `terminal/stateless_server.js` | 268 | `eba5ab9501b53757` |
| `terminal/stdio_mcp.js` | 42 | `9845a8f09227f3c0` |
| `playwright/configure-tunnel.sh` | 18 | `a1d5882c9ba25069` |
| `playwright/patch-playwright.mjs` | 89 | `ad03b218318e9df7` |
| `playwright/probe.mjs` | 67 | `7b4798784dd9a7cc` |
| `playwright/restricted-proxy.mjs` | 239 | `43abbe2b69433b37` |
| `playwright/smoke.mjs` | 66 | `fc3b86bd1bcf3b65` |
| `playwright/start-tunnel.sh` | 34 | `e7137fc1a191250f` |
| `playwright/start.sh` | 19 | `c1b7937da492de41` |
| `playwright/test-access.mjs` | 9 | `95e383ec661685c6` |
| `playwright/tests/metadata-timeout.test.mjs` | 47 | `7d9d4086c136cd68` |
| `playwright/tests/session-recovery.test.mjs` | 89 | `7e8b6c559f7ebad7` |
| `autosend/cdp-delivery.mjs` | 163 | `86f06599d9556077` |
| `autosend/core.mjs` | 99 | `a635fa999a5da336` |
| `autosend/server.mjs` | 138 | `8668dbddd724f194` |
| `autosend/tests/cdp-delivery.test.mjs` | 133 | `814e72243726f8b3` |
| `autosend/tests/core.test.mjs` | 86 | `576d9820fcebee19` |
| `messaging/hub.py` | 429 | `44ddc635a4ef9794` |
| `messaging/start.mjs` | 12 | `9c1cae62f560ff9d` |
| `messaging/tests/test_bus.py` | 60 | `fe68364e10a22133` |
| `messaging/tests/test_http.py` | 93 | `5e2d25c3c4ca249d` |
| `messaging/tests/test_lifecycle.py` | 100 | `5c4129c953f89b7f` |
| `launchers/browser.mjs` | 11 | `1ca0c4b9b721463f` |
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
| `tests/test_docs_release.py` | 69 | `4e0c0065f5f8aef1` |
| `tests/test_documentation.py` | 48 | `42ec84133da280ba` |
| `tests/test_onboarding_safety.py` | 58 | `e74731624485a836` |
| `tests/test_terminal_tunnel.py` | 42 | `e92bf576c0adc826` |
| `tools/generate_source_inventory.py` | 72 | `200c408bf393e3e0` |
| `tools/sync_readme.py` | 23 | `fa026188f89f64b8` |

Всего файлов в выбранном source-only срезе: **72**.

Важно: отсутствие файла в этом инвентаре не доказывает отсутствие выполняемого кода где-либо на диске. Исторические или генерируемые компоненты намеренно исключены; для публичного исходного архива требуется отдельный полный аудит tree.
