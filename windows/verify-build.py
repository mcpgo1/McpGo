#!/usr/bin/env python3
"""Fail-closed audit of Windows packaged runtime, PE architecture, and data leaks."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import pathlib
import struct
import sys

ROOT=pathlib.Path(__file__).resolve().parents[1]
def check_pe(file:pathlib.Path,allowed_archs=(0x8664,))->None:
    with file.open("rb") as stream:
        head=stream.read(4096)
    if head[:2]!=b"MZ":raise RuntimeError("Not an executable: "+str(file))
    offset=struct.unpack_from("<I",head,0x3c)[0]
    if offset+6>len(head) or head[offset:offset+4]!=b"PE\0\0":
        raise RuntimeError("Invalid Windows executable: "+str(file))
    arch=struct.unpack_from("<H",head,offset+4)[0]
    if arch not in allowed_archs:raise RuntimeError("Unexpected PE architecture: "+str(file))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--directory",default=str(ROOT/"release/windows/win-unpacked"))
    parser.add_argument("--installer",default="")
    args=parser.parse_args()
    base=pathlib.Path(args.directory)
    runtime=base/"resources/mcpgo-runtime"
    required={
        "terminal":["stateless_server.js","interactive_runtime.cjs","pty_worker_win.js",
                    "files_tools.cjs","platform.js","job_worker.js",
                    "job_runtime.js","resource_locks.js","resource_policy.js","mcp-version.json"],
        "autosend":["server.mjs","delivery.mjs","browser-client.mjs","preview-check.mjs","browser-health.mjs","schedule.mjs","smart-continuation.mjs","core.mjs","conversation-fsm.mjs",
                    "reconciliation.mjs","guarded-send.mjs","chat-state.mjs","browser-events.mjs","stream-monitor.mjs"],
        "messaging":["hub.py"],
        "onboarding":["setup_engine.py","runtime_provision.py","cli.py","browser_compat.py","diagnostics.py"],
        "playwright":["restricted-proxy.mjs","action-guard.mjs","browser-session-manager.mjs",
                      "tab-lease-manager.mjs","agent-scope.mjs","portable-tab-identity.mjs",
                      "portable-agent-tabs.mjs","browser-workspace.mjs","workspace-response.mjs","mcp-modern-protocol.mjs","chatgpt-url.mjs",
                      "node_modules/@playwright/mcp/cli.js",
                      "node_modules/playwright-core/lib/coreBundle.js"],
        "node":["node.exe"],
        "python":["python.exe","python312.dll","python312.zip","_ssl.pyd","_sqlite3.pyd"],
        "tunnel":["tunnel-client.exe"],
        "pty":["node_modules/@lydell/node-pty/index.js",
               "node_modules/@lydell/node-pty-win32-x64/package.json"],
    }
    missing=[str(runtime/folder/file) for folder,files in required.items() for file in files
             if not (runtime/folder/file).is_file()]
    if not (runtime/"onboarding_cli.py").is_file():missing.append("onboarding_cli.py")
    if not (base/"resources/app.asar").is_file():missing.append("app.asar")
    if missing:raise RuntimeError("Missing packaged inputs:\n"+"\n".join(missing))
    check_pe(base/"McpGo.exe")
    for name in ("node/node.exe","python/python.exe","tunnel/tunnel-client.exe"):
        check_pe(runtime/name)
    for file in runtime.rglob("*"):
        if not file.is_file():continue
        forbidden={"settings.json","config.json","stateless-config.json",
                   "tunnel.key","tunnel.id","messages.sqlite3","tasks.json",
                   ".env","credentials.json","Cookies","History"}
        if file.name in forbidden or file.suffix in (".log",".db",".sqlite"):
            raise RuntimeError("Potential runtime user data packaged: "+str(file))
    print("Windows packaged runtime verified:",len([x for x in runtime.rglob("*") if x.is_file()]),"files")
    version=json.loads((ROOT/"windows/package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+-preview\.\d+", version):
        raise RuntimeError("Invalid Windows preview version")
    installer=(pathlib.Path(args.installer) if args.installer else
               ROOT/"release/windows"/f"McpGo Setup {version}.exe")
    if installer.name!=f"McpGo Setup {version}.exe":
        raise RuntimeError("Unexpected Windows installer name")
    if not installer.is_file() or installer.is_symlink():
        raise RuntimeError("Expected Windows NSIS installer missing: "+str(installer))
    # NSIS bootstrapper uses PE32/i386; installed executables are PE32+ x64.
    check_pe(installer,allowed_archs=(0x14c,0x8664))
    digest=hashlib.sha256(installer.read_bytes()).hexdigest()
    (installer.parent/(installer.name+".sha256")).write_text(
        digest+"  "+installer.name+"\n",encoding="ascii")
    print("Installer:",installer,"SHA256",digest)

if __name__=="__main__":
    try:main()
    except (OSError,RuntimeError) as e:
        print("WINDOWS_AUDIT_FAILED:",e,file=sys.stderr);sys.exit(1)
