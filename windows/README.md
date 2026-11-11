# McpGo for Windows 11 x64 — integrated test build

This is a Windows-native McpGo shell around the **same MCP runtime** used
by the macOS version. It is deliberately independent of WSL. macOS SwiftUI,
launchd, Keychain and DMG logic remain untouched.

## Included in the installer

- Electron application with a secure renderer, system tray, startup settings
  and service supervision with bounded reconnect delays.
- Bundled Windows x64 Node.js 24, Python 3.12 and the full OpenAI Secure MCP
  Tunnel client. No separate Node, Python, WSL or tunnel-client installation.
- Interactive PowerShell over ConPTY, plus recoverable OneShot command jobs,
  stable IDs, lock coordination, output pagination and timeouts.
- File list/read/edit/write/search tools in the **same private terminal tunnel**.
  Files default to the user's home directory. Edits require expected SHA256.
- Existing Playwright MCP safe proxy with Chrome/Edge extension integration.
  The Playwright browser extension itself must be installed in the browser.
- Existing AutoSend scheduling and reconciliation (no blind retry after an
  uncertain send), and SQLite agent messaging.
- Local first-run OpenAI Platform tunnel and runtime key provisioning. Admin
  credentials are passed via stdin to a short-lived Python process, never
  written to settings; the runtime key is encrypted through Windows DPAPI.

All backend HTTP listeners bind exclusively to 127.0.0.1. Two independent
outbound Secure MCP Tunnels forward the terminal and browser MCP endpoints.

## First-run workflow

1. Run **McpGo Setup** under the Windows user account that owns the files and
   browser profile. The installer is per-user and needs no administrator rights.
2. Open Chrome or Edge, install and approve the official Playwright MCP Browser
   Extension. Reuse the logged-in browser session; no isolated Chromium.
3. In McpGo, optionally enter an OpenAI **Admin API Key** and click
   **Create two tunnels**. A second explicit action creates an isolated
   McpGo project and restricted Runtime Key. These API operations require the
   appropriate organization's permissions; uncertain remote writes are
   journaled and are NOT automatically repeated.
4. Alternatively, manually create the two Secure MCP Tunnels and paste their
   IDs and runtime keys into the connection form. Keys are encrypted at rest
   with OS-backed storage.
5. Add the two tunnels as custom MCP connections in ChatGPT (subject to account
   and workspace permissions). Verify tool discovery and a test invocation.
6. Create a scheduled task (initially **disabled**) from the AutoSend form.
   Verify its URL and explicitly enable it only when ready.

Secrets remain in the owner's per-user data directory under the app's
\`userData\`. The signed-in browser profile stays in Chrome/Edge, not McpGo.

## Source and release engineering

The principal entrypoints are:
- \`windows/app/main.cjs\` / \`runtime.cjs\`: UI, service startup and shutdown
- \`terminal/platform.js\`: Windows/macOS shell/path/process abstraction
- \`terminal/pty_worker_win.js\`: Windows ConPTY worker
- \`terminal/stateful_bridge.cjs\`: OneShot-to-interactive MCP delegation
- \`terminal/files_tools.cjs\`: bounded filesystem tools
- \`windows/onboarding_cli.py\`: Windows bridge to the existing Python installer
- \`windows/prepare-runtime.py\`: verified official binary downloading
- \`windows/verify-build.py\`: PE architecture + resource completeness audit

\`\`\`powershell
npm ci --prefix playwright --ignore-scripts
node playwright/patch-playwright.mjs
npm ci --prefix windows
python windows/prepare-runtime.py
npm test --prefix windows
node --test terminal/tests
npm run dist:win --prefix windows
python windows/verify-build.py
\`\`\`

A GitHub Actions \`windows-latest\` workflow also runs native OneShot,
ConPTY, file and embedded Python/SQLite smoke tests before archiving the
**unsigned** NSIS installer. Builds use pinned source and cryptographically
verified release assets.

## Release gates

The test-build installer is assembled on macOS as a Windows PE x64 file; a
successful cross-build and static test are not proof that the app functions
correctly on Windows. The **native Windows CI run and real-browser interactive
test** must both be green before calling this a stable release.

**No code-signing certificate is configured.** Windows SmartScreen may warn
about the unsigned binary. Do not bypass organization security controls to
install it. Signed production releases and securely verified auto-updates
require an actual publisher certificate and additional release validation.

## Unsigned distribution and updates

The application checks GitHub Releases for newer Windows **prereleases** only when
you click "Check for updates". It does not download, execute, install or
replace binaries in the background. The "Open new version" action opens a
strictly validated official github.com release page for a manual install.

An SHA-256 checksum makes accidental or in-transit corruption detectable when
compared to a trustworthy independently obtained reference; it is **not**
an Authenticode signature or proof of publisher identity. Do not disable
SmartScreen, Smart App Control, browser protections or antivirus software.
If organization policy blocks unsigned executables, use the source build or
wait for a permitted distribution method.

Windows ARM64 is not included in this x64 release. WSL is not required.
