#!/usr/bin/env python3
"""Prepare pinned, checksum-verified Windows runtime binaries for McpGo.
No credentials. Assets are fetched from first-party HTTPS release sites and
extracted under ignored windows/vendor. No copying from the host user profile.
"""
from __future__ import annotations
import hashlib
import io
import json
import os
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent
DEST=ROOT/"vendor"
NODE="v24.22.2"
PYTHON="3.12.10"
TUNNEL="v0.0.20"
MAX_ARCHIVE=140*1024*1024
UA={"User-Agent":"McpGo Windows reproducible build"}

def fetch(url:str)->bytes:
    if not url.startswith("https://"):raise ValueError("HTTPS required")
    req=urllib.request.Request(url,headers=UA)
    with urllib.request.urlopen(req,timeout=60) as reply:
        if not reply.url.startswith("https://"):raise RuntimeError("Unsafe redirect")
        if int(reply.headers.get("Content-Length","0"))>MAX_ARCHIVE:raise RuntimeError("oversize archive")
        data=reply.read(MAX_ARCHIVE+1)
    if len(data)>MAX_ARCHIVE:raise RuntimeError("oversize archive")
    return data

def expected_checksum(manifest:bytes,name:str)->str:
    rows=manifest.decode("utf-8").splitlines()
    for row in rows:
        parts=row.strip().replace("*"," ").split()
        if len(parts)==2 and parts[1].removeprefix("./")==name and len(parts[0])==64:
            return parts[0].lower()
    raise RuntimeError("Missing expected checksum for "+name)

def verify(data:bytes,expected:str):
    digest=hashlib.sha256(data).hexdigest()
    if digest!=expected:raise RuntimeError("SHA256 mismatch; refusing archive")
    return digest

def extract(data:bytes,dest:Path,selector):
    dest.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            name=Path(info.filename.replace("\\","/"))
            if info.is_dir():continue
            if name.is_absolute() or ".." in name.parts or len(info.filename)>350:
                raise RuntimeError("Invalid ZIP member")
            relative=selector(name)
            if relative is None:continue
            if relative.is_absolute() or ".." in relative.parts:raise RuntimeError("Invalid extraction target")
            target=dest/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            if info.file_size>MAX_ARCHIVE:raise RuntimeError("Unreasonable file size")
            with archive.open(info) as source,target.open("wb") as output:
                shutil.copyfileobj(source,output,1024*1024)

def download_node():
    base="https://nodejs.org/dist/"+NODE+"/"
    name="node-"+NODE+"-win-x64.zip"
    manifest=fetch(base+"SHASUMS256.txt")
    archive=fetch(base+name)
    digest=verify(archive,expected_checksum(manifest,name))
    extract(archive,DEST/"node",lambda p:Path("node.exe") if p.name=="node.exe" else
            Path("LICENSE") if p.name=="LICENSE" else None)
    return {"name":name,"sha256":digest}

def download_python():
    base="https://www.python.org/ftp/python/"+PYTHON+"/"
    name="python-"+PYTHON+"-embed-amd64.zip"
    data=fetch(base+name)
    # Python.org's Windows embeddable archive is published over TLS. Pin the
    # digest in source before enabling release builds; never trust TOFU in CI.
    pinned="4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
    digest=verify(data,pinned)
    extract(data,DEST/"python",lambda p:p)
    return {"name":name,"sha256":digest}

def download_tunnel():
    base="https://github.com/openai/tunnel-client/releases/download/"+TUNNEL+"/"
    name="tunnel-client-"+TUNNEL+"-windows-amd64.zip"
    manifest=fetch(base+"SHA256SUMS.txt")
    data=fetch(base+name)
    digest=verify(data,expected_checksum(manifest,name))
    # Full client includes onboarding/admin functions, unlike runtime-only.
    extract(data,DEST/"tunnel",lambda p:Path(p.name) if p.name.lower() in (
        "tunnel-client.exe","license","licenses.txt","readme.md") else None)
    return {"name":name,"sha256":digest}

def main():
    DEST.mkdir(parents=True,exist_ok=True)
    records={"node":download_node(),"python":download_python(),"tunnel":download_tunnel()}
    for folder,exe in (("node","node.exe"),("python","python.exe"),
                       ("tunnel","tunnel-client.exe")):
        if not (DEST/folder/exe).is_file():raise RuntimeError("Missing "+exe)
    (DEST/"MANIFEST.json").write_text(json.dumps(records,indent=2)+"\n",encoding="utf-8")
    print("Windows binaries verified and staged:",", ".join(records))

if __name__=="__main__":main()
