#!/usr/bin/env bash
set -euo pipefail
# Explicit operator-only release. No automatic publishing from an untrusted
# branch or an untested cross-compiled installer.
cd "$(dirname "$0")/.."
tag="v2.1.0-preview.1"
version="${tag#v}"
installer="release/windows/McpGo Setup ${version}.exe"
checksum="${installer}.sha256"
if [[ "${1:-}" != "--publish" ]]; then
  echo "Dry run only. To publish after successful Windows CI, use --publish."
  echo "Checks: clean main, remote HEAD, unsigned Windows x64 audit, native CI success."
  exit 0
fi
[[ "$(git branch --show-current)" == "main" ]] || { echo "Expected main branch" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "Commit local changes first" >&2; exit 1; }
[[ -f "$installer" ]] || { echo "Missing Windows installer" >&2; exit 1; }
python3 windows/verify-build.py
local_head="$(git rev-parse HEAD)"
remote_head="$(gh api repos/mcpgo1/McpGo/commits/main --jq '.sha')"
[[ "$local_head" == "$remote_head" ]] || {
  echo "Local commit not published on mcpgo1/McpGo main" >&2; exit 1;
}
# Native Windows CI must have built this exact source revision successfully.
if ! gh run list -R mcpgo1/McpGo -w windows-preview.yml -b main -L 30 \
   --json headSha,status,conclusion --jq \
   "[.[] | select(.headSha==\"$local_head\" and .status==\"completed\" and .conclusion==\"success\")] | length" \
   | grep -qxE '[1-9][0-9]*'; then
  echo "No successful native Windows CI for this exact commit" >&2
  exit 1
fi
if gh release view "$tag" -R mcpgo1/McpGo >/dev/null 2>&1; then
  echo "Release already exists; refusing to overwrite assets" >&2; exit 1
fi
notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT
cat > "$notes" <<NOTES
## McpGo Windows 11 x64 — Preview

**Experimental, free, open source, unsigned installer.**
This is a prerelease, not a stable release. Automated Windows CI passed for commit \`$local_head\`, but real user-device installation and Chrome/Edge testing are still required.

### Included
- PowerShell / interactive ConPTY and recoverable multi-agent jobs
- Files, personal Chrome/Edge via Playwright MCP, scheduled messages and agent hub
- Bundled Node.js, Python and OpenAI tunnel-client
- Manual update notification to GitHub Releases (no silent installation)

### Verification
Download \`$(basename "$installer")\` and its adjacent \`$(basename "$checksum")\`.
Check SHA256 with \`Get-FileHash -Algorithm SHA256 -LiteralPath '.\\$(basename "$installer")'\`.
Compare the result with the published checksum.

**No Authenticode publisher signature.** Microsoft Defender SmartScreen may warn
about an unknown publisher. Do not disable SmartScreen, Smart App Control,
antivirus, or organizational security policies to use McpGo.
SHA256 verifies file integrity against the published reference, not publisher identity.

Source: https://github.com/mcpgo1/McpGo
Installation guide: https://mcpgo.ru/windows/
NOTES
gh release create "$tag" "$installer" "$checksum" -R mcpgo1/McpGo \
  --target "$local_head" --title "McpGo Windows ${version} — unsigned Preview" \
  --prerelease --latest=false --notes-file "$notes"
echo "Published prerelease: https://github.com/mcpgo1/McpGo/releases/tag/$tag"
