import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from setup_engine import SetupEngine, SetupError, TUNNEL_ID

A = "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
B = "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


class FakeEngine(SetupEngine):
    def __init__(self, root, home, client):
        super().__init__(root, home, str(client))
        self.remotes = []
        self.creates = []
        self.crash_next_create = False
        self.fail_next_list = False

    def ensure_installation_ownership(self):
        return None

    def run_cli(self, args, *, admin=None, runtime=None, timeout=20):
        if args[:3] == ["admin", "tunnels", "list"]:
            if self.fail_next_list:
                self.fail_next_list = False
                raise SetupError("temporary network")
            return json.dumps({"tunnels": self.remotes})
        if args[:3] == ["admin", "tunnels", "create"]:
            if self.crash_next_create:
                self.crash_next_create = False
                raise SetupError("network")
            i = len(self.creates)
            ident = A if i == 0 else B
            name = args[args.index("--name") + 1]
            self.creates.append(name)
            self.remotes.append({"name": name, "id": ident})
            return json.dumps({"id": ident, "name": name})
        if args[0] == "init":
            directory = Path(args[args.index("--profile-dir") + 1])
            profile = args[args.index("--profile") + 1]
            ident = args[args.index("--tunnel-id") + 1]
            target = args[args.index("--mcp-server-url") + 1]
            (directory / (profile + ".yaml")).write_text(
                f"control_plane:\n  tunnel_id: {ident}\n"
                f"  api_key: env:CONTROL_PLANE_API_KEY\n"
                f"mcp:\n  server_urls:\n    - url: {target}\n")
            return ""
        if args[:3] == ["admin", "tunnels", "get"]:
            ident = args[3]
            return json.dumps(next(x for x in self.remotes if x["id"] == ident))
        raise AssertionError("Unexpected fake CLI command: " + repr(args))


class SetupEngineTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory()
        self.addCleanup(self.sandbox.cleanup)
        self.root = Path(self.sandbox.name) / "Repo"
        self.home = Path(self.sandbox.name) / "Home"
        self.root.mkdir()
        self.home.mkdir()
        fakecli = Path(self.sandbox.name) / "tunnel-client"
        fakecli.write_text("#!/bin/sh\nexit 0\n")
        fakecli.chmod(0o700)
        self.engine = FakeEngine(self.root, self.home, fakecli)

    def test_readonly_status_does_not_create_state(self):
        data = self.engine.status_without_secrets()
        self.assertEqual(data["phase"], "preflight")
        self.assertFalse(self.engine.store.exists())

    def test_requires_explicit_consent_and_valid_scopes(self):
        with self.assertRaisesRegex(SetupError, "подтверждения"):
            self.engine.provision({"adminKey": "not-a-real-test-admin-key", "organizationId": "org_123"})
        with self.assertRaisesRegex(SetupError, "Organization"):
            self.engine.provision({"confirmed": True, "adminKey": "not-a-real-test-admin-key",
                                   "organizationId": "org_/../../secret"})
        self.assertEqual(self.engine.creates, [])

    def test_create_twice_uses_same_remote_ids(self):
        request = {"confirmed": True, "adminKey": "test-admin-key",
                   "organizationId": "org_123456"}
        first = self.engine.provision(request)
        second = self.engine.provision(request)
        self.assertEqual(first["tunnels"], second["tunnels"])
        self.assertEqual(len(self.engine.creates), 2)
        self.assertEqual(len(self.engine.remotes), 2)
        self.assertFalse(self.engine.read_state()["pending"])
        self.assertNotIn("adminKey", self.engine.store.read_text())
        self.assertEqual(self.engine.store.stat().st_mode & 0o077, 0)

    def test_unknown_remote_outcome_never_automatically_retries(self):
        request = {"confirmed": True, "adminKey": "test-admin-key",
                   "workspaceId": "ws_123456"}
        self.engine.crash_next_create = True
        with self.assertRaisesRegex(SetupError, "неизвестен"):
            self.engine.provision(request)
        self.assertEqual(self.engine.read_state()["pending"]["status"], "unknown")
        with self.assertRaisesRegex(SetupError, "повтор запрещён"):
            self.engine.provision(request)
        self.assertEqual(len(self.engine.creates), 0)
        # If Platform shows that creation DID occur, reconciliation adopts it.
        state = self.engine.read_state()
        self.engine.remotes.append({"name": state["pending"]["name"], "id": A})
        repaired = self.engine.provision(request)
        self.assertEqual(repaired["tunnels"]["terminal"], A)
        self.assertEqual(len(self.engine.creates), 1)  # browser only

    def test_unknown_status_survives_failed_reconciliation_lookup(self):
        request = {"confirmed": True, "adminKey": "test-admin-key",
                   "organizationId": "org_123456"}
        self.engine.crash_next_create = True
        with self.assertRaises(SetupError):
            self.engine.provision(request)
        self.engine.fail_next_list = True
        with self.assertRaises(SetupError):
            self.engine.provision(request)
        self.assertEqual(self.engine.read_state()["pending"]["status"], "unknown")
        with self.assertRaisesRegex(SetupError, "повтор запрещён"):
            self.engine.provision(request)
        self.assertEqual(self.engine.creates, [])

    def test_import_and_explicit_verify(self):
        self.engine.import_tunnels({"confirmed": True, "terminalId": A, "browserId": B})
        self.assertFalse(self.engine.read_state()["tunnels"]["terminal"]["remoteVerified"])
        self.engine.remotes = [{"name": "Terminal", "id": A}, {"name": "Browser", "id": B}]
        self.engine.verify_remote({"runtimeKey": "test-runtime-key"})
        self.assertTrue(self.engine.read_state()["tunnels"]["browser"]["remoteVerified"])

    def test_profiles_are_generated_without_secret_and_are_reused(self):
        self.engine.import_tunnels({"confirmed": True, "terminalId": A, "browserId": B})
        result = self.engine.configure({"confirmed": True})
        term = Path(result["profiles"]["terminal"])
        browser = Path(result["profiles"]["browser"])
        self.assertTrue(term.exists() and browser.exists())
        self.assertIn("env:CONTROL_PLANE_API_KEY", term.read_text())
        self.assertNotIn("sk-proj", term.read_text())
        self.assertEqual(term.stat().st_mode & 0o077, 0)
        self.assertEqual(browser.stat().st_mode & 0o077, 0)
        self.assertEqual(self.engine.configure({"confirmed": True})["profiles"], result["profiles"])
        self.assertTrue((self.engine.appdata / "terminal/stateless-config.json").exists())

    def test_different_installation_state_cannot_be_overwritten(self):
        self.engine.import_tunnels({"confirmed": True, "terminalId": A, "browserId": B})
        other = FakeEngine(self.root.parent / "Other", self.home, self.engine.client)
        with self.assertRaisesRegex(SetupError, "другой установке"):
            other.read_state()

    def test_dismiss_does_not_falsely_verify_chatgpt(self):
        with self.assertRaises(SetupError):
            self.engine.dismiss({})
        result = self.engine.dismiss({"confirmed": True})
        self.assertTrue(result["dismissed"])
        self.assertFalse(result["chatgptVerified"])
        self.assertTrue(self.engine.read_state()["wizardDismissed"])
        self.assertFalse(self.engine.read_state().get("chatgpt", {}).get("terminal", False))

    def test_import_rejects_same_or_invalid_id(self):
        for invalid in [dict(terminalId=A,browserId=A),
                        dict(terminalId="../secret",browserId=B)]:
            with self.assertRaises(SetupError):
                self.engine.import_tunnels({"confirmed": True, **invalid})

    def test_readonly_browser_mcp_probe_parses_sse_and_checks_real_result(self):
        import http.server
        import threading
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                packet = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                method = packet.get("method")
                self.send_response(202 if method == "notifications/initialized" else 200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("mcp-session-id", "test-session")
                self.end_headers()
                if method == "notifications/initialized":
                    return
                result = {
                    "initialize": {"serverInfo": {"name": "test"}},
                    "tools/list": {"tools": [{"name": "browser_tabs"}]},
                    "tools/call": {"content": [{"type": "text", "text": "### Result\nTabs"}]},
                }.get(method)
                payload = {"jsonrpc": "2.0", "id": packet["id"], "result": result}
                self.wfile.write(("event: message\ndata: " + json.dumps(payload) + "\n\n").encode())
        from http.server import HTTPServer
        server = HTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/mcp"
            self.assertTrue(SetupEngine.probe_tools(url, {"browser_tabs"}, verify_browser=True))
            self.assertFalse(SetupEngine.probe_tools(url, {"terminal_exec"}))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_local_verification_is_not_chatgpt_verification(self):
        result = self.engine.verify_local()
        self.assertFalse(result["chatgptVerified"])
        self.assertFalse(result["terminal"])
        self.assertFalse(result["browser"])


if __name__ == "__main__":
    unittest.main()
