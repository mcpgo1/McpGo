#!/usr/bin/env python3
"""Windows-first-run adapter to the existing McpGo setup engine.

All admin secrets arrive only over stdin. This process never prints the
Admin API key or runtime provisioning journal secrets. Mutation journaling,
read-before-create and the one-shot Service Account key flow are reused from
the macOS onboarding implementation.
"""
import json
import os
import pathlib
import sys
import tempfile

# The embedded Windows Python console encoding may default to a legacy codepage.
# All IPC between Electron and the onboarding CLI is UTF-8 JSON.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")

ROOT=pathlib.Path(os.environ.get("MCPGO_RESOURCE_ROOT",
    str(pathlib.Path(__file__).resolve().parents[1]))).resolve()
sys.path.insert(0,str(ROOT/"onboarding"))
from setup_engine import SetupEngine,SetupError
from browser_compat import browser_check
from diagnostics import event, register_secrets, log_exception, environment_snapshot, export_zip, instrument_public_methods

ACTIONS={"status","browser-check","discover","provision","import","runtime-projects",
         "runtime-inspect","runtime-auto","runtime-recover-key",
         "verify-remote","doctor","export-diagnostics"}

class WindowsSetup(SetupEngine):
    def __init__(self):
        super().__init__(root=ROOT,client=os.environ.get("MCPGO_TUNNEL_CLIENT"))
        raw=os.environ.get("MCPGO_USER_DATA")
        if not raw or not pathlib.Path(raw).is_absolute():
            raise SetupError("Windows user data directory is not configured.")
        self.appdata=pathlib.Path(raw).resolve()
        self.store=self.appdata/"Onboarding"/"state.json"
        self.client=os.environ.get("MCPGO_TUNNEL_CLIENT") or str(ROOT/"tunnel"/"tunnel-client.exe")

    def ensure_installation_ownership(self):
        # Never run elevated and never overwrite a second user's installation.
        if self.store.is_symlink() or self.store.parent.is_symlink():
            raise SetupError("Unsafe settings path.")
        if not pathlib.Path(self.client).is_file():
            raise SetupError("Bundled tunnel-client not found.")
        if not pathlib.Path(self.client).resolve().is_relative_to(ROOT):
            raise SetupError("Unexpected tunnel-client location.")

    def read_state(self):
        if self.store.is_symlink() or self.store.parent.is_symlink():
            raise SetupError("Unsafe onboarding state.")
        if not self.store.exists():
            return {"version":1,"installationRoot":str(self.root),"phase":"preflight",
                    "tunnels":{},"pending":None,"chatgpt":{"terminal":False,"browser":False}}
        value=json.loads(self.store.read_text(encoding="utf8"))
        if value.get("version")!=1 or value.get("installationRoot")!=str(self.root):
            raise SetupError("Onboarding state belongs to a different installation.")
        return value

    def write_state(self,state):
        if self.store.is_symlink() or self.store.parent.is_symlink():
            raise SetupError("Unsafe onboarding state.")
        self.store.parent.mkdir(parents=True,exist_ok=True)
        state["installationRoot"]=str(self.root)
        fd,tmp=tempfile.mkstemp(prefix=".mcpgo-",dir=str(self.store.parent))
        try:
            with os.fdopen(fd,"w",encoding="utf8") as stream:
                json.dump(state,stream,ensure_ascii=False,indent=2)
                stream.flush();os.fsync(stream.fileno())
            os.replace(tmp,self.store)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)

instrument_public_methods(WindowsSetup)

def main():
    environment_snapshot()
    action=sys.argv[1] if len(sys.argv)>1 else '<missing>'
    event('windows.cli.invoked',action=action)
    try:
        if len(sys.argv)!=2 or sys.argv[1] not in ACTIONS:
            raise SetupError("Unsupported onboarding action.")
        data=sys.stdin.buffer.read(16385)
        if len(data)>16384:raise SetupError("Request too large.")
        payload=json.loads(data or b"{}")
        if not isinstance(payload,dict):raise SetupError("Expected a JSON object.")
        register_secrets(payload)
        event('windows.cli.request',action=action,payload=payload,bytes=len(data))
        engine=WindowsSetup()
        action=sys.argv[1]
        methods={"status":engine.status_without_secrets,
                 "discover":engine.discover,
                 "provision":engine.provision,
                 "import":engine.import_tunnels,
                 "runtime-projects":engine.runtime_projects,
                 "runtime-inspect":engine.runtime_inspect,
                 "runtime-auto":engine.runtime_auto,
                 "runtime-recover-key":engine.runtime_recover_key,
                 "verify-remote":engine.verify_remote,
                 "doctor":engine.doctor}
        if action=="export-diagnostics":
            result=export_zip(payload.get("destination", ""))
        elif action=="browser-check":
            browser=payload.get("browser", "chrome")
            result=browser_check(browser)
        else:
            result=methods[action]() if action=="status" else methods[action](payload)
        event("windows.cli.success",action=action,result=result)
        print(json.dumps({"ok":True,"result":result},ensure_ascii=False))
        return 0
    except (ValueError,OSError,SetupError) as exc:
        log_exception("windows.cli.failure:"+action,exc)
        print(json.dumps({"ok":False,"error":str(exc)},ensure_ascii=False))
        return 2
    except Exception as exc:
        log_exception("windows.cli.unexpected:"+action,exc)
        print(json.dumps({"ok":False,"error":"Internal onboarding failure; see diagnostics."}))
        return 2

if __name__=="__main__":
    sys.exit(main())
