# McpGo — Third-party components and license notices

McpGo's original source code and project documentation are distributed under
the [MIT License](LICENSE). This does **not** relicense third-party software.

## Node dependencies (as recorded in the pinned lockfile)

| Component | Version | License in lockfile | Upstream |
|---|---|---|---|
| @playwright/mcp | 0.0.83 | Apache-2.0 | https://github.com/microsoft/playwright-mcp |
| playwright | 1.64.0-alpha-1790635538000 | Apache-2.0 | https://github.com/microsoft/playwright |
| playwright-core | 1.64.0-alpha-1790635538000 | Apache-2.0 | https://github.com/microsoft/playwright |

These packages are resolved through playwright/package-lock.json. Their
upstream license texts and any required notices remain subject to the terms
of the Apache License 2.0. Installing dependencies via npm ci does not
make their source code MIT-licensed. The local compatibility patch
playwright/patch-playwright.mjs changes a bundled upstream component on
install; upstream rights and attribution remain in force.

See the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
and the license/notice files installed with each dependency.

## External components not relicensed by McpGo

- **Google Chrome**: separately installed browser, governed by Google's
  applicable terms. No claim of ownership or MIT relicensing.
- **OpenAI Secure MCP Tunnel client (tunnel-client)**: separately installed binary/service.
  Its distribution terms must be verified against the official supplier
  before bundling it in McpGo releases.
- **Apple macOS / SwiftUI / AppKit / launchd / Keychain**: operating system
  frameworks and tools, subject to applicable Apple terms.
- **Node.js and Python**: external runtimes with their own licenses.

The included McpGo.app is an ad-hoc-signed local build, **not** a notarized
public distribution. Verify the contents and licenses of any release artifact,
including vendored packages, plugins, code, images, or fonts, **before**
claiming that all third-party redistribution obligations are satisfied.

This file is a transparent dependency inventory, not a substitute for a
complete, audited SBOM or upstream NOTICE audit.


## Windows distributable runtime (verified vendor ZIPs)

The Windows NSIS installer includes the following upstream executables,
retrieved over TLS from their first-party release locations and checked
against source release SHA-256 manifests or pinned source hashes. The
preparation script never reads local credentials.

| Component | Windows version | Upstream and terms |
|---|---|---|
| Node.js | v24.22.2 x64 | https://nodejs.org ; Node.js license included in vendor/node/LICENSE |
| Python embeddable distribution | 3.12.10 x64 | https://python.org ; LICENSE.txt included with runtime |
| OpenAI Secure MCP Tunnel client | v0.0.20 x64 (full client) | https://github.com/openai/tunnel-client ; bundled upstream LICENSE |
| Electron | 45.3.0 | https://electronjs.org ; MIT and Chromium NOTICE files in assembled app |
| @lydell/node-pty | 1.2.0-beta.15 | https://github.com/lydell/node-pty ; MIT, bundled LICENSE |
| Playwright MCP | 0.0.83 | Apache-2.0, pinned in playwright/package-lock.json |

The actual ZIP names and their verified SHA-256 values are recorded in
the local ignored windows/vendor/MANIFEST.json when the build runs.
This generated local file is not a secret.

The Windows installer is presently **unsigned** and must not be presented
as a verified stable release before native Windows CI and real-device tests.
