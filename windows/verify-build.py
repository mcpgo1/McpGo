#!/usr/bin/env python3
"""Fail-closed audit of Windows packaged runtime, PE architecture, and data leaks."""
from __future__ import annotations
import argparse
import hashlib
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
    args=parser.parse_args()
    base=pathlib.Path(args.directory)
    runtime=base/"resources/mcpgo-runtime"
    required={
        "terminal":["stateless_server.js","server.js","pty_worker_win.js",
                    "stateful_bridge.cjs","files_tools.cjs","platform.js","job_worker.js",
                    "job_runtime.js","resource_locks.js","resource_policy.js","mcp-version.json"],
        "autosend":["server.mjs","cdp-delivery.mjs","core.mjs","conversation-fsm.mjs",
                    "reconciliation.mjs","guarded-send.mjs"],
        "messaging":["hub.py"],
        "onboarding":["setup_engine.py","runtime_provision.py","cli.py"],
        "playwright":["restricted-proxy.mjs","action-guard.mjs",
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
    installer=ROOT/"release/windows/McpGo Setup 2.1.0-preview.1.exe"
    if installer.is_file():
        # The NSIS bootstrapper is intentionally PE32/i386; the installed app
        # and all bundled runtime executables are PE32+ x64 (checked above).
        check_pe(installer,allowed_archs=(0x14c,0x8664))
        digest=hashlib.sha256(installer.read_bytes()).hexdigest()
        (installer.parent/(installer.name+".sha256")).write_text(
            digest+"  "+installer.name+"\n",encoding="ascii")
        print("Installer:",installer,"SHA256",digest)

if __name__=="__main__":
    try:main()
    except (OSError,RuntimeError) as e:
        print("WINDOWS_AUDIT_FAILED:",e,file=sys.stderr);sys.exit(1)
