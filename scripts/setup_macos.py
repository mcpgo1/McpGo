#!/usr/bin/env python3
"""First-run launchd installer for McpGo, never affects a different installation.

Usage: python3 scripts/setup_macos.py --check | --install
No root privileges, no network downloads, no implicit removal of user data.
"""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
DOMAIN = f"gui/{os.getuid()}"
TEMPLATES = ROOT / "launchagents"
AGENTS = HOME / "Library/LaunchAgents"
LOGS = HOME / "Library/Logs/McpGo"
DATA = HOME / "Library/Application Support/McpGo"
PORTS = (12847, 12848, 8931, 8940, 8969, 8971, 8972)


def existing_listener(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.12):
            return True
    except OSError:
        return False


def render(template: Path, node: str) -> dict:
    data = plistlib.loads(template.read_bytes())
    def replace(value):
        if isinstance(value, str):
            return (value.replace("__MCPGO_ROOT__", str(ROOT))
                         .replace("__HOME__", str(HOME))
                         .replace("__NODE_BIN__", node))
        if isinstance(value, dict):
            return {k: replace(v) for k, v in value.items()}
        if isinstance(value, list):
            return [replace(v) for v in value]
        return value
    data = replace(data)
    # The Terminal tunnel launcher lives in Application Support and has no
    # WorkingDirectory. Embed a source ownership marker in every generated
    # LaunchAgent to allow safe, idempotent re-install without guessing.
    data.setdefault("EnvironmentVariables", {})["MCPGO_INSTALL_ROOT"] = str(ROOT)
    if any("__" in x for x in data["ProgramArguments"]):
        raise RuntimeError(f"Unresolved plist placeholder: {template.name}")
    return data


def installed_owner(plist: Path) -> str:
    if not plist.exists():
        return "missing"
    try:
        data = plistlib.loads(plist.read_bytes())
        if data.get("EnvironmentVariables", {}).get("MCPGO_INSTALL_ROOT") == str(ROOT):
            return "this"
        args = data.get("ProgramArguments", [])
        paths = [str(x) for x in args] + [str(data.get("WorkingDirectory", ""))]
        if any(x == str(ROOT) or x.startswith(str(ROOT) + os.sep) for x in paths):
            return "this"
    except Exception:
        pass
    return "different"


def check() -> tuple[bool, list[str]]:
    problems = []
    if sys.platform != "darwin":
        problems.append("McpGo desktop is currently available for macOS only.")
    if os.geteuid() == 0:
        problems.append("Do not install user LaunchAgents as root.")
    if not (ROOT / "McpGo.app/Contents/Info.plist").is_file():
        problems.append("McpGo.app is missing.")
    if not shutil.which("node"):
        problems.append("Node.js not found in PATH.")
    if not shutil.which("python3"):
        problems.append("Python 3 not found in PATH.")
    script = HOME / "Library/Application Support/ChatTerminalHub/run-tunnel.sh"
    source = ROOT / "terminal/run-tunnel.sh"
    if script.exists() and (script.is_symlink() or
                            not source.exists() or script.read_bytes() != source.read_bytes()):
        problems.append("Existing terminal tunnel script belongs to another installation.")
    for template in sorted(TEMPLATES.glob("*.plist")):
        owner = installed_owner(AGENTS / template.name)
        if owner == "different":
            problems.append(f"An installation already owns {template.name}; no changes permitted.")
    # Fail closed even if an installed plist is missing but its service is loaded.
    for template in sorted(TEMPLATES.glob("*.plist")):
        label = template.stem
        owner = installed_owner(AGENTS / template.name)
        result = subprocess.run(
            ["/bin/launchctl", "print", f"{DOMAIN}/{label}"],
            capture_output=True, timeout=4)
        if result.returncode == 0 and owner != "this":
            problems.append(f"LaunchAgent {label} is already loaded by another instance.")
    if not all(installed_owner(AGENTS / t.name) == "this" for t in TEMPLATES.glob("*.plist")):
        for port in PORTS:
            if existing_listener(port):
                problems.append(f"Local port {port} is already occupied; refusing to mix installations.")
    return not problems, problems


def install() -> None:
    ok, problems = check()
    if not ok:
        for message in problems:
            print("BLOCKED:", message, file=sys.stderr)
        raise SystemExit(2)
    node = shutil.which("node")
    assert node
    for folder in (AGENTS, LOGS, DATA, DATA / "terminal", DATA / "playwright",
                   DATA / "Messaging", DATA / "AutoSend", ROOT / "playwright/.cache",
                   ROOT / "playwright/.cache/tmp", ROOT / "playwright/.s",
                   ROOT / "playwright/artifacts/shared"):
        folder.mkdir(parents=True, exist_ok=True)
        if folder in (DATA, DATA / "terminal", DATA / "playwright",
                      DATA / "Messaging", DATA / "AutoSend"):
            folder.chmod(0o700)
    # Copy the terminal script outside Desktop, avoiding launchd/TCC path problems.
    script = HOME / "Library/Application Support/ChatTerminalHub/run-tunnel.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    if not script.exists():
        shutil.copyfile(ROOT / "terminal/run-tunnel.sh", script)
        script.chmod(0o700)
    for template in sorted(TEMPLATES.glob("*.plist")):
        dest = AGENTS / template.name
        if not dest.exists():
            dest.write_bytes(plistlib.dumps(render(template, node), sort_keys=False))
            dest.chmod(0o600)
        # Existing plists that belong to this root are left unchanged.
        label = template.stem
        loaded = subprocess.run(["/bin/launchctl", "print", f"{DOMAIN}/{label}"],
                                capture_output=True, timeout=4).returncode == 0
        if not loaded:
            result = subprocess.run(["/bin/launchctl", "bootstrap", DOMAIN, str(dest)],
                                    capture_output=True, text=True, timeout=15)
            if result.returncode:
                print(f"WARNING: {label} bootstrap failed; inspect launchctl and logs.",
                      file=sys.stderr)
    print("McpGo user services installed. Browser and tunnel permissions require separate configuration.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--install", action="store_true")
    args = parser.parse_args()
    if args.check:
        ok, issues = check()
        print("OK to install" if ok else "Installation blocked")
        for item in issues:
            print("-", item)
        raise SystemExit(0 if ok else 2)
    install()


if __name__ == "__main__":
    main()
