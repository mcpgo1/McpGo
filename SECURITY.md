# Security policy — McpGo

**Project status:** pre-publication reference implementation. McpGo has not yet announced a formal public security-response program, response SLA, supported-release list, or security-contact address. Do not interpret this document as a claim of independent security certification.

## Security architecture

- [Threat model](docs/THREAT_MODEL.md): capabilities, trust boundaries, STRIDE scenarios, residual risks.
- [Detailed security architecture](docs/SECURITY.md): loopback APIs, Chrome CDP, terminal authority and scheduler guarantees.
- [Independent audit guide](docs/AUDIT_GUIDE.md): verifiable source paths and tests.
- [Dependencies and supply chain](docs/DEPENDENCIES.md): direct/transitive versions and audit gaps.
- [Public release gates](docs/PUBLIC_RELEASE.md): mandatory work before recommending public distribution.

## Reporting vulnerabilities

A dedicated confidential reporting channel is **not configured yet**. Before public release, maintainers must configure GitHub private vulnerability reporting (or another explicitly published secure contact), describe supported versions and expected response times, and test the workflow. Do not place sensitive exploit details or private user data in public issues.

## Supported versions

No public release/version-support promise exists yet. A locally running McpGo.app is not an independently verified distribution artifact.

## Cautions

Terminal tools can run commands with the macOS user's permissions. Playwright uses the user's **existing Chrome session** via CDP. Treat both as powerful capabilities; review workspace/client permissions before enabling them.
