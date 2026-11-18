"""Live-mode switch is guarded by a real trial, with safe rollback."""
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "onboarding"))
from setup_engine import SetupEngine, SetupError


class FakeTrial:
    def __init__(self):
        self.returncode = None
        self.stopped = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -15
        self.stopped = True

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


class BrowserExtensionSetupTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.base = pathlib.Path(self.scratch.name)
        self.root = self.base / "Runtime"
        self.home = self.base / "Home"
        self.home.mkdir()
        for name in ("vendor/node/bin/node", "playwright/node_modules/@playwright/mcp/cli.js",
                     "playwright/node_modules/@playwright/mcp/package.json", "playwright/probe.mjs"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('{"version":"0.0.85"}' if name.endswith("package.json") else "")
        self.engine = SetupEngine(root=self.root, home=self.home)
        self.settings = self.home / "Library/Application Support/McpGo/playwright"
        self.token = "private-valid-playwright-token-test-32"

    def test_missing_or_invalid_token_does_not_write_anything(self):
        with self.assertRaises(SetupError):
            self.engine.activate_browser_extension({"confirmed": True, "token": "a"})
        with self.assertRaises(SetupError):
            self.engine.activate_browser_extension({"confirmed": False, "token": self.token})
        self.assertFalse(self.settings.exists())

    def test_success_requires_trial_and_live_verification(self):
        trial = FakeTrial()
        commands = []

        def run(args, **kwargs):
            commands.append(args)
            if args[0] == "/usr/sbin/lsof":
                return types.SimpleNamespace(returncode=0,stdout=b"11223\n")
            if args[0] == "/bin/ps":
                return types.SimpleNamespace(returncode=0,
                    stdout=b"node /Runtime/playwright/node_modules/@playwright/mcp/cli.js --extension --background\n")
            return types.SimpleNamespace(returncode=0)

        # A small real context manager for fake sockets.
        from contextlib import nullcontext
        def socket_check(*args, **kwargs):
            if not hasattr(socket_check, "first"):
                socket_check.first = True
                raise ConnectionRefusedError()
            return nullcontext()

        with patch("setup_engine.sys.platform", "darwin"), \
             patch("setup_engine.socket.create_connection", side_effect=socket_check), \
             patch("setup_engine.subprocess.Popen", return_value=trial) as popen, \
             patch("setup_engine.subprocess.run", side_effect=run):
            result = self.engine.activate_browser_extension({
                "confirmed": True, "token": self.token
            })
        self.assertTrue(result["verified"])
        self.assertTrue(trial.stopped)
        self.assertEqual(self.engine.browser_extension_mode(), "extension")
        self.assertEqual((self.settings / "extension-token").read_text().strip(), self.token)
        self.assertEqual((self.settings / "extension-token").stat().st_mode & 0o077, 0)
        self.assertNotIn(self.token, str(result))
        self.assertIn("--background", popen.call_args.args[0])
        self.assertIn("--extension", popen.call_args.args[0])
        self.assertNotIn(self.token, popen.call_args.args[0])
        self.assertEqual(popen.call_args.kwargs["env"]["PLAYWRIGHT_MCP_EXTENSION_TOKEN"], self.token)
        self.assertTrue(any(args[0] == "/bin/launchctl" for args in commands))


    def test_trial_uses_same_auto_detected_profile_as_live_browser(self):
        ext = (self.home / "Library/Application Support/Google/Chrome/Profile 3"
               / "Extensions/mmlmfjhmonkocbjadbfplnigmagldckm/0.5.2_0")
        ext.mkdir(parents=True)
        trial = FakeTrial()
        from contextlib import nullcontext

        def run(args, **kwargs):
            if args[0] == "/usr/sbin/lsof":
                return types.SimpleNamespace(returncode=0, stdout=b"11223\n")
            if args[0] == "/bin/ps":
                return types.SimpleNamespace(returncode=0,
                    stdout=b"node /Runtime/playwright/node_modules/@playwright/mcp/cli.js --extension --background\n")
            return types.SimpleNamespace(returncode=0)

        with patch("setup_engine.sys.platform", "darwin"), \
             patch("setup_engine.socket.create_connection", side_effect=[
                 ConnectionRefusedError(), nullcontext()
             ]), \
             patch("setup_engine.subprocess.Popen", return_value=trial) as popen, \
             patch("setup_engine.subprocess.run", side_effect=run):
            result = self.engine.activate_browser_extension({
                "confirmed": True, "token": self.token
            })
        self.assertTrue(result["verified"])
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("--profile-dir-name") + 1], "Profile 3")

    def test_bad_live_handshake_rolls_back_old_mode(self):
        from contextlib import nullcontext
        trial = FakeTrial()

        def socket_check(*args, **kwargs):
            if not hasattr(socket_check, "first"):
                socket_check.first = True
                raise ConnectionRefusedError()
            return nullcontext()

        commands = []
        def run(args, **kwargs):
            commands.append(args)
            if "probe.mjs" in str(args) and kwargs["env"].get("PLAYWRIGHT_MCP_URL") == "http://127.0.0.1:8931/mcp":
                return types.SimpleNamespace(returncode=1)
            return types.SimpleNamespace(returncode=0)

        with patch("setup_engine.sys.platform", "darwin"), \
             patch("setup_engine.socket.create_connection", side_effect=socket_check), \
             patch("setup_engine.subprocess.Popen", return_value=trial), \
             patch("setup_engine.subprocess.run", side_effect=run), \
             patch("setup_engine.time.sleep", return_value=None):
            with self.assertRaisesRegex(SetupError, "восстановлен"):
                self.engine.activate_browser_extension({"confirmed": True, "token": self.token})
        self.assertEqual(self.engine.browser_extension_mode(), "not-configured")
        self.assertFalse((self.settings / "extension-token").exists())
        self.assertEqual(sum(args[0] == "/bin/launchctl" for args in commands), 2)

if __name__ == "__main__":
    unittest.main()
