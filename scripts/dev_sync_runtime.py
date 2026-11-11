#!/usr/bin/env python3
"""Copy only allowlisted McpGo source to the local DEV preview/runtime.

No service reload, LaunchAgent operation, secrets, app installation, Git,
release images, user jobs or stored configuration is performed here.
"""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import shutil
import stat
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "dashboard/server.mjs", "dashboard/mcp-health.mjs",
    "dashboard/tunnel-recovery.mjs", "dashboard/tunnel-health.mjs",
    "dashboard/mcp-versions.mjs", "dashboard/app.js",
    "terminal/server.js", "terminal/stateless_server.js",
    "terminal/job_runtime.js", "terminal/job_worker.js",
    "terminal/resource_locks.js", "terminal/resource_policy.js",
    "terminal/mcp-version.json", "terminal/run-tunnel.sh",
    "launchers/tunnel.mjs",
    # Sync AutoSend source without touching schedules, state or browser profiles.
    "autosend/server.mjs", "autosend/core.mjs",
    "autosend/cdp-delivery.mjs", "autosend/chat-state.mjs",
    "autosend/guarded-send.mjs", "autosend/browser-events.mjs",
    "autosend/conversation-fsm.mjs",
    "autosend/reconciliation.mjs", "autosend/stall-watchdog.mjs",
)


def safe_directory(directory: Path) -> None:
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError(f"Unsafe or missing runtime directory: {directory}")


def sync(destination_root: Path, *, backup_root: Path | None = None) -> list[str]:
    # Require the already-installed runtime/seed; don't create an alternative
    # app tree or follow links to another installation.
    safe_directory(destination_root)
    candidates = []
    for relative in FILES:
        src = ROOT / relative
        dest = destination_root / relative
        if not src.is_file() or src.is_symlink():
            raise RuntimeError(f"Unsafe/missing source: {relative}")
        safe_directory(dest.parent)
        if dest.is_symlink() or (dest.exists() and not dest.is_file()):
            raise RuntimeError(f"Unsafe runtime path: {relative}")
        if dest.exists() and dest.read_bytes() == src.read_bytes():
            continue
        candidates.append((src, dest, relative))
    # Validate all paths first; a missing module doesn't yield a partial sync.
    for src, dest, relative in candidates:
        if backup_root is not None and dest.exists():
            backup = backup_root / (relative + ".before-dev-2.0.7")
            backup.parent.mkdir(parents=True, exist_ok=True)
            if not backup.exists():
                shutil.copy2(dest, backup)
    for src, dest, relative in candidates:
        fd, tmp = tempfile.mkstemp(prefix=".dev-source-", dir=dest.parent)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(src.read_bytes())
                output.flush()
                os.fsync(output.fileno())
            os.chmod(tmp, stat.S_IMODE(src.stat().st_mode))
            os.replace(tmp, dest)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return [relative for _, _, relative in candidates]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--bundle", type=Path,
                       help="Signed Dev.app RuntimeSeed, BEFORE codesign")
    group.add_argument("--runtime", action="store_true",
                       help="Existing writable user runtime, no service restart")
    args = parser.parse_args()
    if args.bundle is not None:
        assert "McpGo Dev.app/Contents/Resources/RuntimeSeed" in str(args.bundle)
        target = args.bundle
        backup = None
    else:
        target = Path.home() / "Library/Application Support/McpGo/Runtime"
        backup = ROOT / "release/dev/runtime-code-backup"
    changed = sync(target, backup_root=backup)
    print(f"[dev] Synced {len(changed)} code-only files to {'bundle' if args.bundle else 'runtime'}")
    if changed:
        print("[dev] Updated modules: " + ", ".join(changed))
    print("[dev] No running services or LaunchAgents restarted.")
