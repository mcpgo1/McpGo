# McpGo for Windows (Preview)

The Windows app reuses the existing McpGo Node.js MCP services; it does not replace the macOS SwiftUI app or launchd configuration.

## Architecture

- Electron 45 desktop shell: `app/main.cjs`, `app/preload.cjs`, and a sandboxed, context-isolated renderer.
- Supervised services: durable terminal operations, Playwright MCP and the existing guarded browser proxy.
- Platform bridge: `../terminal/platform.js` picks PowerShell on Windows and keeps zsh on macOS, with platform-specific data directories and process tree cancellation.
- Two outbound-only secure tunnels: terminal to localhost:12848/exec/<private>, browser to localhost:8940/mcp. Keys are encrypted by Electron safeStorage (Windows DPAPI) and passed to tunnel-client via environment only.
- Personal Chrome and Edge: `--extension` mode, not remote debugging of the standard browser profile.

## Windows 11 x64 setup

1. Install the unsigned preview NSIS build. It is per-user and does not require administrator privileges.
2. Install the `tunnel-client.exe` executable on PATH, or specify an absolute path via `MCPGO_TUNNEL_CLIENT`. This preview does not bundle the tunnel binary.
3. Create two Secure MCP Tunnels in ChatGPT. Enter each tunnel ID and API key in the app. Do not put keys in chat, issues or scripts.
4. Install the Playwright MCP browser extension in your regular Chrome or Edge and authorize the connection.
5. Save settings. Check both local MCP endpoints and then exercise terminal_exec, job_status and browser_tabs from ChatGPT.

Without tunnel credentials the local services can start, but ChatGPT remote access will not connect. Listeners stay on 127.0.0.1.

## Build on Windows

```powershell
npm ci --prefix playwright --ignore-scripts
node playwright/patch-playwright.mjs
npm ci --prefix windows
npm test --prefix windows
node --test terminal/tests/platform.test.cjs
npm run dist:win --prefix windows
```

The `.github/workflows/windows-preview.yml` workflow assembles an **unsigned** NSIS setup on windows-latest and uploads it as a build artifact. It does not publish a release.

## Scope and release gates

| Capability | Preview |
| --- | --- |
| Durable PowerShell job execution, multiple agents, lock/idempotency | Ported |
| Chrome/Edge MCP via extension + safe action proxy | Implemented, not yet validated on Windows |
| Outbound MCP tunnels with DPAPI credential storage | Implemented |
| System tray, autostart, process recovery | Implemented |
| Files and SSH | PowerShell command access; no dedicated Files MCP yet |
| Interactive ConPTY sessions | Not yet implemented |
| Scheduled ChatGPT message sending / autosend | Not yet ported |
| Tunnel auto-provisioning | Manual IDs and keys in this preview |
| Signed release, auto-updater and Windows ARM64 | Not yet implemented |

Required acceptance testing before a production release: installation and removal on clean Windows 11, no admin privileges, loopback listener validation, tunnel reconnect, DPAPI persistence, Chrome/Edge real-profile extension, concurrent jobs with lock contention, Unicode paths, PowerShell command cancellation and process-tree cleanup, plus full macOS regressions.
