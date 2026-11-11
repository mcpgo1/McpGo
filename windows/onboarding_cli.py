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

ROOT=pathlib.Path(os.environ.get("MCPGO_RESOURCE_ROOT",
    str(pathlib.Path(__file__).resolve().parents[1]))).resolve()
sys.path.insert(0,str(ROOT/"onboarding"))
from setup_engine import SetupEngine,SetupError

ACTIONS={"status","discover","provision","import","runtime-projects",
         "runtime-inspect","runtime-auto","runtime-recover-key",
         "verify-remote","doctor"}

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

def main():
    try:
        if len(sys.argv)!=2 or sys.argv[1] not in ACTIONS:
            raise SetupError("Unsupported onboarding action.")
        data=sys.stdin.buffer.read(16385)
        if len(data)>16384:raise SetupError("Request too large.")
        payload=json.loads(data or b"{}")
        if not isinstance(payload,dict):raise SetupError("Expected a JSON object.")
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
        result=methods[action]() if action=="status" else methods[action](payload)
        print(json.dumps({"ok":True,"result":result},ensure_ascii=False))
        return 0
    except (ValueError,OSError,SetupError) as exc:
        # SetupEngine/RuntimeAutoProvisioner already redact response bodies.
        print(json.dumps({"ok":False,"error":str(exc)},ensure_ascii=False))
        return 2

if __name__=="__main__":
    sys.exit(main())
