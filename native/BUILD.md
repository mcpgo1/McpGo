# McpGo — macOS SwiftUI build

The checked-in **McpGo.app** is a local ad-hoc-signed arm64 build, not an
Apple Developer ID notarized release. Source is in `native/*.swift`.

```bash
cd native
xcrun swiftc -parse-as-library -sdk "$(xcrun --show-sdk-path)" \
  -target arm64-apple-macosx14.0 -O -o MCPHub \
  main.swift Messaging.swift TunnelSettings.swift TunnelHelp.swift \
  InteractiveButtonStyle.swift SkillsView.swift ScheduledMessages.swift OnboardingView.swift
cd ..
cp native/MCPHub McpGo.app/Contents/MacOS/MCPHub  # only for a local, explicitly staged bundle
codesign --force --deep --sign - McpGo.app
codesign --verify --strict McpGo.app
```

First-run launcher: `Запустить McpGo.command`. It checks prerequisites,
prevents conflicts with another installed instance and installs user LaunchAgents
only after confirmation.

See [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md),
[docs/PACKAGING.md](../docs/PACKAGING.md) and
[docs/GETTING_STARTED.md](../docs/GETTING_STARTED.md).


First-run wizard: native/OnboardingView.swift and onboarding/setup_engine.py.
The launcher opens the app without installing anything. New installs require explicit
consent and cannot take over existing services. See docs/ONBOARDING.md.
