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
