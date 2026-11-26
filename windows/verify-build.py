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

def verify_onboarding_asar(archive:pathlib.Path)->None:
    # ASAR header is a Chromium pickle containing the JSON file tree.
    # Compare the packaged images with the original macOS guide, not a copy.
    with archive.open("rb") as stream:
        prefix=stream.read(8)
        if len(prefix)!=8 or struct.unpack_from("<I",prefix)[0]!=4:
            raise RuntimeError("Invalid ASAR header")
        header_size=struct.unpack_from("<I",prefix,4)[0]
        if not 8<=header_size<=16*1024*1024:
            raise RuntimeError("Invalid ASAR header size")
        header=stream.read(header_size)
        json_size=struct.unpack_from("<I",header,4)[0]
        tree=json.loads(header[8:8+json_size])
        def read_entry(name):
            entry=tree
            for part in name.split("/"):
                entry=entry["files"][part]
            if entry.get("unpacked") or "offset" not in entry:
                raise RuntimeError("Onboarding file not stored in ASAR: "+name)
            stream.seek(8+header_size+int(entry["offset"]))
            return stream.read(entry["size"])
        for image in sorted((ROOT/"assets/onboarding").glob("*.png")):
            if read_entry("app/onboarding-images/"+image.name)!=image.read_bytes():
                raise RuntimeError("Packaged onboarding image mismatch: "+image.name)
        html=read_entry("app/index.html").decode("utf8")
        if sorted(re.findall(r'data-wizard-page="([0-6])"',html))!=list("0123456"):
            raise RuntimeError("Seven-step wizard missing from packaged app")
        if not read_entry("app/wizard-doctor.cjs"):
            raise RuntimeError("Windows onboarding diagnostics missing")
    print("Verified packaged seven-step wizard and original onboarding images")

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
        "dashboard":["connection-health.cjs"],
        "playwright":["probe.mjs","restricted-proxy.mjs","action-guard.mjs","browser-session-manager.mjs", "mcp-response.mjs", "page-inspection.mjs", "inspection-conditions.mjs", "tool-profiles.mjs", "browser-queue.mjs",
                      "tab-lease-manager.mjs","agent-scope.mjs","portable-tab-identity.mjs",
                      "portable-agent-tabs.mjs","browser-workspace.mjs","workspace-response.mjs","mcp-modern-protocol.mjs","chatgpt-url.mjs",
                      "node_modules/@playwright/mcp/cli.js",
                      "node_modules/playwright-core/lib/coreBundle.js"],
        "node":["node.exe"],
        "python":["python.exe","python312.dll","python3.dll","python312.zip","python312._pth",
                  "vcruntime140.dll","vcruntime140_1.dll","_ssl.pyd","_sqlite3.pyd","_ctypes.pyd"],
        "tunnel":["tunnel-client.exe"],
        "pty":["node_modules/@lydell/node-pty/index.js",
               "node_modules/@lydell/node-pty-win32-x64/package.json"],
    }
    missing=[str(runtime/folder/file) for folder,files in required.items() for file in files
             if not (runtime/folder/file).is_file()]
    if not (runtime/"onboarding_cli.py").is_file():missing.append("onboarding_cli.py")
    if not (base/"resources/app.asar").is_file():missing.append("app.asar")
    if missing:raise RuntimeError("Missing packaged inputs:\n"+"\n".join(missing))
    verify_onboarding_asar(base/"resources/app.asar")
    check_pe(base/"McpGo.exe")
    for name in ("node/node.exe","python/python.exe","tunnel/tunnel-client.exe"):
        check_pe(runtime/name)
    for file in (runtime/"python").iterdir():
        if file.suffix.lower() in (".exe",".dll",".pyd"):check_pe(file)
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
