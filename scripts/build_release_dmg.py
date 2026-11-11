#!/usr/bin/env python3
"""Build an isolated arm64 macOS McpGo DMG from the working source tree.

Safety:
- Does not modify the developer's checked-in McpGo.app or LaunchAgents.
- Includes only whitelisted source/runtime files; excludes caches, logs and state.
- Requires official archive checksums; never bundles API keys or local config.
- With no Developer ID Application certificate, emits an explicitly TEST-ONLY DMG.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import urllib.error
import zipfile

PROJECT = Path(__file__).resolve().parents[1]
RELEASE = PROJECT / "release"
CACHE = RELEASE / "cache"
BUILD = RELEASE / "build"
DIST = RELEASE / "dist"

NODE_VERSION = "20.20.2"
NODE_BASENAME = f"node-v{NODE_VERSION}-darwin-arm64.tar.gz"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_BASENAME}"
NODE_SUMS_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt"

PY_TAG = "20261026"
PY_FILENAME = "cpython-3.12.16+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz"
PY_API = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/" + PY_TAG

TUNNEL_URL = "https://persistent.oaistatic.com/tunnel-client/v0.0.17/tunnel-client-v0.0.17-darwin-arm64.zip"
TUNNEL_SHA = "df03ad0ba9c95c22951bab6833df289469f15b9a3fa0397d95e3d568d1ff6c1f"

NATIVE = [
    "main.swift", "Messaging.swift", "TunnelSettings.swift", "TunnelHelp.swift",
    "InteractiveButtonStyle.swift", "SkillsView.swift", "ScheduledMessages.swift",
    "OnboardingView.swift",
]
# Source allowlists prevent carrying secrets, cached data, historical backups,
# personal schedules, private Playwright profiles or working Chrome state.
SOURCES = {
    "terminal": [
        "server.js", "stateless_server.js", "stdio_mcp.js", "job_worker.js",
        "job_runtime.js", "resource_locks.js", "resource_policy.js", "mcp-version.json", "pty_worker.py", "run-tunnel.sh",
        "restart-when-idle.sh", "dashboard.js", "dashboard.css", "dashboard.html",
        "doctor-tunnel.sh", "save-tunnel-key.sh",
    ],
    "messaging": ["start.mjs", "hub.py"],
    "autosend": ["server.mjs", "core.mjs", "cdp-delivery.mjs",
                 "chat-state.mjs", "guarded-send.mjs", "browser-events.mjs",
                 "conversation-fsm.mjs", "stall-watchdog.mjs", "reconciliation.mjs"],
    "dashboard": ["server.mjs", "mcp-health.mjs", "tunnel-recovery.mjs",
                  "tunnel-health.mjs", "mcp-versions.mjs", "index.html", "style.css", "app.js"],
    "launchers": ["browser.mjs", "tunnel.mjs"],
    "onboarding": ["cli.py", "setup_engine.py", "runtime_provision.py"],
    "scripts": ["setup_macos.py"],
    "playwright": ["probe.mjs", "restricted-proxy.mjs", "action-guard.mjs", "patch-playwright.mjs",
                   "package.json", "package-lock.json", "start.sh", "start-tunnel.sh"],
}


def command(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("$", " ".join(argv[:4]), flush=True)
    return subprocess.run(argv, check=True, **kwargs)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as inp:
        for chunk in iter(lambda: inp.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, target: Path, expected_sha: str) -> None:
    if target.exists() and sha256(target) == expected_sha:
        print("Cached:", target.name, flush=True)
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".part")
    if temp.exists():
        temp.unlink()
    command(["/usr/bin/curl", "-fL", "--retry", "3", "--retry-delay", "3",
             "--connect-timeout", "20", "-o", str(temp), url])
    actual = sha256(temp)
    if actual != expected_sha:
        temp.unlink()
        raise RuntimeError(f"Checksum mismatch for {target.name}: {actual}")
    temp.replace(target)
    print("Verified:", target.name, flush=True)


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "McpGo-Packager/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # On shared IPs GitHub's anonymous API rate limit may be exhausted.
        # Use the user's existing authenticated GitHub CLI (if available),
        # not cached unverified hashes or a hardcoded token. The official
        # asset digest below is still mandatory and SHA-256 checked.
        if exc.code not in (403, 429) or url != PY_API or not shutil.which("gh"):
            raise
        print("GitHub API rate limit; fetching release metadata via authenticated gh CLI", flush=True)
        result = subprocess.run(
            ["gh", "api", "repos/astral-sh/python-build-standalone/releases/tags/" + PY_TAG],
            check=True, capture_output=True, text=True, timeout=35,
        )
        return result.stdout


def official_archives() -> tuple[Path, Path, Path]:
    sums = fetch_text(NODE_SUMS_URL)
    entries = [line.split() for line in sums.splitlines()]
    node_sha = next(items[0] for items in entries if len(items) == 2 and items[1] == NODE_BASENAME)
    node = CACHE / NODE_BASENAME
    download(NODE_URL, node, node_sha)

    release = json.loads(fetch_text(PY_API))
    py_asset = next(a for a in release["assets"] if a["name"] == PY_FILENAME)
    checksum = py_asset.get("digest") or ""
    if not checksum.startswith("sha256:"):
        raise RuntimeError("Python release asset missing authenticated SHA-256 digest")
    python = CACHE / PY_FILENAME
    download(py_asset["browser_download_url"], python, checksum.split(":", 1)[1])

    tunnel = CACHE / "tunnel-client-v0.0.17-darwin-arm64.zip"
    download(TUNNEL_URL, tunnel, TUNNEL_SHA)
    return node, python, tunnel


def copy_sources(target: Path) -> None:
    for folder, names in SOURCES.items():
        dest = target / folder
        dest.mkdir(parents=True, exist_ok=True)
        for name in names:
            src = PROJECT / folder / name
            if not src.is_file() or src.is_symlink():
                raise RuntimeError("Missing/unsafe runtime input: " + str(src))
            shutil.copy2(src, dest / name)
    launchagents = target / "launchagents"
    launchagents.mkdir(parents=True)
    for src in sorted((PROJECT / "launchagents").glob("*.plist")):
        if src.is_symlink():
            raise RuntimeError("Unexpected symlink " + str(src))
        plistlib.loads(src.read_bytes())
        shutil.copy2(src, launchagents / src.name)

    # Prepare reproducible node_modules in an isolated build directory.
    pw = target / "playwright"
    cmd = ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
    command(cmd, cwd=pw, env={**os.environ, "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"},
            timeout=300)
    # The project patch is part of the shipping runtime contract.
    command(["node", "patch-playwright.mjs"], cwd=pw, timeout=60)
    if not (pw / "node_modules/@playwright/mcp/cli.js").is_file():
        raise RuntimeError("Playwright MCP dependency not installed")

    for folder in ("terminal", "playwright", "messaging", "autosend", "dashboard", "onboarding"):
        if (target / folder / ".env").exists():
            raise RuntimeError("Unexpected environment file included")


def unpack_binaries(node: Path, python: Path, tunnel: Path, dest: Path) -> None:
    vendor = dest / "vendor"
    (vendor / "node").mkdir(parents=True)
    with tarfile.open(node) as archive:
        members = archive.getmembers()
        prefix = f"node-v{NODE_VERSION}-darwin-arm64/"
        for member in members:
            if member.name.rstrip("/") == prefix.rstrip("/"):
                continue
            if not member.name.startswith(prefix):
                raise RuntimeError("Unexpected Node archive layout")
            remainder = member.name[len(prefix):]
            if remainder and (remainder.startswith("/") or ".." in Path(remainder).parts):
                raise RuntimeError("Unsafe Node archive path")
        # tarfile filter supported in Python 3.9? use extraction into trusted temp directory after hash verified
        with tempfile.TemporaryDirectory(prefix="mcpgo-node-") as tmp:
            archive.extractall(tmp)
            unpacked = Path(tmp) / prefix.strip("/")
            for part in ("bin", "include", "lib", "share", "LICENSE"):
                source = unpacked / part
                if source.exists():
                    shutil.move(str(source), str(vendor / "node" / part))

    with tarfile.open(python) as archive:
        names = archive.getnames()
        if not names or not all(n == "python" or n.startswith("python/") for n in names):
            raise RuntimeError("Unexpected Python archive layout")
        with tempfile.TemporaryDirectory(prefix="mcpgo-python-") as tmp:
            archive.extractall(tmp)
            installation = Path(tmp) / "python"
            if not (installation / "bin/python3").exists():
                raise RuntimeError("Python package missing bin/python3")
            shutil.move(str(installation), str(vendor / "python"))

    tunnel_dest = vendor / "tunnel" / "bin"
    tunnel_dest.mkdir(parents=True)
    with zipfile.ZipFile(tunnel) as archive:
        files = {Path(n).name: n for n in archive.namelist() if not n.endswith("/")}
        for name in ("tunnel-client", "cloudflared"):
            if name not in files:
                raise RuntimeError(f"Tunnel-client archive missing {name}")
            path = tunnel_dest / name
            path.write_bytes(archive.read(files[name]))
            path.chmod(0o755)
        for item in ("cloudflared-manifest.json", "LICENSE", "NOTICE",
                     "tunnel-client-v0.0.17-darwin-arm64-licenses.txt",
                     "tunnel-client-v0.0.17-darwin-arm64.spdx.json"):
            if item in files:
                (vendor / "tunnel" / item).write_bytes(archive.read(files[item]))

    # Official Node archive includes relative symlinks for npm/npx.
    nodebin = vendor / "node/bin"
    for name in ("node", "npm", "npx"):
        if not (nodebin / name).exists():
            raise RuntimeError("Node archive missing " + name)
    if not (vendor / "python/bin/python3").exists():
        raise RuntimeError("Python archive missing python3")


def stage_app(runtime: Path, destination: Path, version: str = "2.0.0") -> None:
    # Build the application bundle entirely from tracked source assets.
    # Never copy the developer's locally installed/signed McpGo.app: its
    # signature, embedded resources or private state may be machine-specific.
    contents = destination / "Contents"
    resources = contents / "Resources"
    (contents / "MacOS").mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)
    for src, dest in (
        ("Info.plist", contents / "Info.plist"),
        ("AppIcon.icns", resources / "AppIcon.icns"),
        ("McpGoMark.png", resources / "McpGoMark.png"),
        ("McpGoMark.svg", resources / "McpGoMark.svg"),
    ):
        asset = PROJECT / "native" / src
        if not asset.is_file() or asset.is_symlink():
            raise RuntimeError("Missing/unsafe app source asset: " + str(asset))
        shutil.copy2(asset, dest)

    help_images = resources / "HelpImages"
    help_images.mkdir(parents=True, exist_ok=True)
    for name in ("admin-key-list.png", "admin-key-dialog.png",
                 "chatgpt-plugin-menu.png", "chatgpt-server-form.png",
                 "chatgpt-connect-confirmation.png"):
        src = PROJECT / "assets/onboarding" / name
        if not src.is_file() or src.is_symlink():
            raise RuntimeError("Missing/unsafe onboarding help image: " + str(src))
        shutil.copy2(src, help_images / name)

    skills = resources / "skills"
    if skills.exists():
        shutil.rmtree(skills)
    skills.mkdir(parents=True)
    for slug in ("terminalhub-operations", "playwrighthub-qa",
                 "agent-coordination", "tunnel-diagnostics"):
        src = PROJECT / "skills" / slug / "SKILL.md"
        if not src.is_file():
            raise RuntimeError("Missing bundled skill: " + slug)
        (skills / slug).mkdir(parents=True)
        shutil.copy2(src, skills / slug / "SKILL.md")

    # Signed app resources include the offline user guide, which the
    # documentation button opens even without network access.
    local_docs = resources / "Documentation"
    local_docs.mkdir(parents=True, exist_ok=True)
    doc_source = PROJECT / "assets/docs/index.html"
    if not doc_source.is_file() or doc_source.is_symlink():
        raise RuntimeError("Missing or unsafe offline documentation")
    shutil.copy2(doc_source, local_docs / "index.html")

    shutil.move(str(runtime), str(resources / "RuntimeSeed"))

    exe = destination / "Contents/MacOS/MCPHub"
    swift = ["xcrun", "swiftc", "-parse-as-library", "-sdk",
             subprocess.check_output(["xcrun", "--show-sdk-path"], text=True).strip(),
             "-target", "arm64-apple-macosx14.0", "-O", "-o", str(exe)]
    swift += [str(PROJECT / "native" / p) for p in NATIVE]
    command(swift, timeout=360)

    with (destination / "Contents/Info.plist").open("rb") as stream:
        data = plistlib.load(stream)
    if data["CFBundleIdentifier"] != "local.mcphub.native":
        raise RuntimeError("Legacy bundle identifier changed unexpectedly")
    data["CFBundleShortVersionString"] = version
    data["CFBundleVersion"] = "".join(ch for ch in version if ch.isdigit())
    with (destination / "Contents/Info.plist").open("wb") as stream:
        plistlib.dump(data, stream)


def sign_local(app: Path, identity: str | None) -> None:
    # Sign every embedded Mach-O component before signing the parent app bundle.
    sign_target = identity or "-"
    runtime = app / "Contents/Resources/RuntimeSeed"
    libs = []
    for path in runtime.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        if not os.access(path, os.X_OK) and path.suffix not in (".so", ".dylib"):
            continue
        result = subprocess.run(["/usr/bin/file", "-b", str(path)],
                                capture_output=True, text=True, check=True)
        if "Mach-O" in result.stdout:
            libs.append(path)
    print("Mach-O binaries:", len(libs), flush=True)
    node_jit = BUILD / "node-jit.entitlements.plist"
    node_jit.write_bytes(plistlib.dumps({
        "com.apple.security.cs.allow-jit": True,
    }))
    for path in libs:
        flags = ["codesign", "--force", "--sign", sign_target, "--options", "runtime"]
        if identity:
            flags.append("--timestamp")
        if path == runtime / "vendor/node/bin/node":
            flags += ["--entitlements", str(node_jit)]
        command([*flags, str(path)], stdout=subprocess.DEVNULL)
    flags = ["codesign", "--force", "--sign", sign_target, "--options", "runtime"]
    if identity:
        flags.append("--timestamp")
    command([*flags, str(app)], stdout=subprocess.DEVNULL)
    command(["codesign", "--verify", "--strict", "--deep", "--verbose=2", str(app)])


def make_dmg(app: Path, version: str, identity: str | None,
             notary_profile: str | None = None) -> Path:
    DIST.mkdir(parents=True, exist_ok=True)
    # Keep a previous validated final DMG untouched until Apple's replacement
    # has passed notarization, stapling and Gatekeeper verification.
    suffix = ("-PENDING-NOTARIZATION" if notary_profile else
              "-SIGNED-NOT-NOTARIZED" if identity else "-UNSIGNED-TEST-ONLY")
    outfile = DIST / f"McpGo-{version}-macos-arm64{suffix}.dmg"
    if outfile.exists():
        outfile.unlink()
    with tempfile.TemporaryDirectory(prefix="mcpgo-dmg-") as temp:
        volume = Path(temp) / "McpGo"
        volume.mkdir()
        shutil.copytree(app, volume / "McpGo.app", symlinks=True)
        (volume / "Applications").symlink_to("/Applications")
        command(["hdiutil", "create", "-volname", "McpGo",
                 "-srcfolder", str(volume), "-format", "UDZO", "-ov", str(outfile)])
    # Apple recommends a Developer ID Application signature on the disk image
    # itself, in addition to the signature on the nested application.
    if identity:
        command(["codesign", "--force", "--sign", identity, "--timestamp",
                 str(outfile)])
        command(["codesign", "--verify", "--verbose=2", str(outfile)])
    return outfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="2.0.0", help="App version (for example 2.0.1)")
    parser.add_argument("--developer-id", help="Valid Developer ID Application identity")
    parser.add_argument("--notary-profile", help="Existing notarytool Keychain profile for Apple")
    args = parser.parse_args()
    if sys.platform != "darwin" or os.geteuid() == 0:
        raise SystemExit("Must run on macOS as an ordinary user")
    if args.developer_id and not args.developer_id.startswith("Developer ID Application:"):
        raise SystemExit("Developer ID Application signing identity required")
    if args.notary_profile and not args.developer_id:
        raise SystemExit("Apple notarization requires a Developer ID Application signature")
    if not args.version or any(c not in "0123456789." for c in args.version):
        raise SystemExit("Invalid version")
    NODE, PYTHON, TUNNEL = official_archives()
    if BUILD.exists():
        # Only clean this build directory, not user's installed app, caches or state.
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True)
    runtime = BUILD / "RuntimeSeed"
    runtime.mkdir()
    copy_sources(runtime)
    unpack_binaries(NODE, PYTHON, TUNNEL, runtime)
    (runtime / "release-manifest.json").write_text(
        json.dumps({"version": args.version, "platform": "macos-arm64",
                    "bundled": ["node", "python", "tunnel-client", "playwright"]},
                   indent=2) + "\n")
    app = BUILD / "McpGo.app"
    stage_app(runtime, app, args.version)
    sign_local(app, args.developer_id)
    dmg = make_dmg(app, args.version, args.developer_id, args.notary_profile)
    if args.notary_profile:
        # A zero exit code alone doesn't guarantee that the submission was
        # Accepted. Check Apple's explicit decision before shipping.
        completed = command(["xcrun", "notarytool", "submit", str(dmg),
                             "--keychain-profile", args.notary_profile, "--wait",
                             "--timeout", "25m", "--output-format", "json"],
                            timeout=1600, capture_output=True, text=True)
        decision = json.loads(completed.stdout)
        if decision.get("status") != "Accepted":
            raise RuntimeError("Apple notarization not accepted: " +
                               str(decision.get("status")))
        command(["xcrun", "stapler", "staple", str(dmg)], timeout=150)
        command(["xcrun", "stapler", "validate", str(dmg)], timeout=80)
        command(["spctl", "-a", "-t", "open",
                 "--context", "context:primary-signature", str(dmg)])
        # Preserve the last good public artifact until every check succeeds.
        final = DIST / f"McpGo-{args.version}-macos-arm64.dmg"
        dmg.replace(final)
        dmg = final
    print("DMG:", dmg)
    print("SHA256:", sha256(dmg))
    print("SIGNING:", "DEVELOPER ID + NOTARIZED" if args.notary_profile
          else "DEVELOPER ID / NOT NOTARIZED" if args.developer_id
          else "AD HOC — TEST ONLY; Gatekeeper will block normal downloaded installs")


if __name__ == "__main__":
    main()
