#!/usr/bin/env bash
set -euo pipefail
# Operator-only unsigned preview release, sourced from the Windows CI artifact
# that passed the native integration suite on the exact HEAD commit.
cd "$(dirname "$0")/.."
repo="mcpgo1/McpGo"
workflow="windows-preview.yml"
artifact="McpGo-Windows-unsigned-preview"
tag="v2.1.0-preview.1"
version="${tag#v}"
name="McpGo Setup ${version}.exe"
installer="release/windows/${name}"
checksum="${installer}.sha256"
mode="${1:---dry-run}"
if [[ "$mode" == "--dry-run" ]]; then
  echo "No upload: run --prepare to stage the audited Windows CI artifact, then --publish to create the prerelease."
  exit 0
fi
if [[ "$mode" != "--prepare" && "$mode" != "--publish" ]]; then
  echo "Usage: $0 [--dry-run|--prepare|--publish]" >&2
  exit 2
fi
[[ "$(git branch --show-current)" == "main" ]] || { echo "Expected main branch" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "Commit changes first" >&2; exit 1; }
local_head="$(git rev-parse HEAD)"
remote_head="$(gh api repos/${repo}/commits/main --jq '.sha')"
[[ "$local_head" == "$remote_head" ]] || { echo "HEAD is not pushed to ${repo}/main" >&2; exit 1; }
run_id="$(
 gh run list -R "$repo" -w "$workflow" -b main -L 40 \
  --json databaseId,headSha,status,conclusion,event |
 python3 -c 'import json,sys
sha=sys.argv[1]
rows=json.load(sys.stdin)
matches=[r for r in rows if r.get("headSha")==sha and r.get("status")=="completed"
    and r.get("conclusion")=="success" and r.get("event") in ("push","workflow_dispatch")]
print(matches[0]["databaseId"] if matches else "")' "$local_head"
)"
[[ -n "$run_id" ]] || { echo "Native Windows CI is not green for HEAD $local_head" >&2; exit 1; }
if [[ "$mode" == "--publish" ]] &&
 gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
 echo "Release already exists; refusing to overwrite any assets" >&2; exit 1
fi
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
gh run download "$run_id" -R "$repo" -n "$artifact" -D "$stage"
candidate="$stage/$name"
[[ -f "$candidate" ]] || { echo "Expected installer not in CI artifact" >&2; exit 1; }
[[ "$(find "$stage" -type f | wc -l | tr -d ' ')" == 1 ]] ||
 { echo "Unexpected files in CI artifact" >&2; exit 1; }
python3 - "$candidate" <<'PY'
import pathlib,struct,sys
p=pathlib.Path(sys.argv[1])
size=p.stat().st_size
if size<10*1024*1024 or size>300*1024*1024:raise SystemExit("Unexpected installer size")
with p.open("rb") as f:
    if f.read(2)!=b"MZ":raise SystemExit("Not a Windows PE executable")
    f.seek(0x3c);pe=struct.unpack("<I",f.read(4))[0]
    if pe>2*1024*1024:raise SystemExit("Malformed PE header")
    f.seek(pe)
    if f.read(4)!=b"PE\0\0":raise SystemExit("Malformed PE signature")
print(f"Windows CI installer verified: {size} bytes")
PY
ci_hash="$(shasum -a 256 "$candidate" | awk '{print $1}')"
if [[ "$mode" == "--prepare" ]]; then
 mkdir -p release/windows
 cp "$candidate" "$installer"
 (cd release/windows && shasum -a 256 "$name" > "$name.sha256")
 echo "Staged Windows CI artifact from run $run_id; SHA-256: $ci_hash"
 echo "Set app/windows-release.ts WINDOWS_SHA256 to this checksum, deploy site, then use --publish."
 exit 0
fi
[[ -f "$installer" && -f "$checksum" ]] || { echo "Run --prepare first" >&2; exit 1; }
local_hash="$(shasum -a 256 "$installer" | awk '{print $1}')"
[[ "$local_hash" == "$ci_hash" ]] || { echo "Installer differs from tested Windows CI artifact" >&2; exit 1; }
(cd release/windows && shasum -a 256 -c "$name.sha256")
notes="$(mktemp)"
trap 'rm -rf "$stage"; rm -f "$notes"' EXIT
cat > "$notes" <<NOTES
## McpGo Windows 11 x64 — Preview

**Free, open-source, unsigned installer.** This is an experimental prerelease,
not a stable release. Automated Windows CI passed for commit \`$local_head\`
(run $run_id). Real-device Chrome/Edge and first-install acceptance testing remains necessary.

### Features
- PowerShell / ConPTY and durable, recoverable multi-agent jobs
- Files, Chrome/Edge via Playwright MCP, scheduled messages and inter-agent hub
- Bundled Node.js, Python and OpenAI tunnel-client
- Manual update check opening GitHub Releases; no silent installations

### Verify installer
Download \`$name\` and \`$name.sha256\` from this release.
PowerShell: \`Get-FileHash -LiteralPath '.\\$name' -Algorithm SHA256\`.
Expected SHA-256: \`$ci_hash\`

**No Authenticode publisher signature.** SmartScreen can warn or block the
application. Do not disable SmartScreen, Smart App Control, antivirus or
organizational security restrictions. A matching hash does not prove publisher identity.

Source: https://github.com/mcpgo1/McpGo
Installation guide: https://mcpgo.ru/windows/
NOTES
gh release create "$tag" "$installer" "$checksum" -R "$repo" \
 --target "$local_head" --title "McpGo Windows ${version} — unsigned Preview" \
 --prerelease --latest=false --notes-file "$notes"
echo "Published prerelease: https://github.com/$repo/releases/tag/$tag"
