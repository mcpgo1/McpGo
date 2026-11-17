"""Isolated activation regressions: all network/process/settings writes are mocked."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import setup_engine


class ExtensionProbeModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name) / "runtime"
        # Minimal installed-runtime fixture; subprocesses below never execute it.
        for relative in ("vendor/node/bin/node", "playwright/node_modules/@playwright/mcp/cli.js",
                         "playwright/probe.mjs"):
            file = root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.touch()
        (root / "playwright/node_modules/@playwright/mcp/package.json").write_text(
            '{"version":"0.0.85"}', encoding="utf-8")
        self.engine = setup_engine.SetupEngine(root=root, home=Path(self.temp.name) / "home")
        self.calls = []
        self.trial = MagicMock()
        self.trial.poll.return_value = None
        self.socket_calls = 0

    def connect(self, *args, **kwargs):
        self.socket_calls += 1
        if self.socket_calls == 1:
            raise ConnectionRefusedError()
        return MagicMock()

    def invoke(self, trial_ok):
        def run(argv, **kwargs):
            self.calls.append((argv, kwargs))
            if argv[-1] == str(self.engine.root / "playwright/probe.mjs"):
                return subprocess.CompletedProcess(argv, 0 if trial_ok else 1)
            if argv[:2] == ["/bin/launchctl", "kickstart"]:
                return subprocess.CompletedProcess(argv, 0)
            if argv[0] == "/usr/sbin/lsof":
                return subprocess.CompletedProcess(argv, 0, stdout=b"123\n")
            if argv[0] == "/bin/ps":
                return subprocess.CompletedProcess(argv, 0,
                    stdout=b"node @playwright/mcp/cli.js --extension --background")
            raise AssertionError(f"Unexpected mocked subprocess: {argv}")

        with (patch.object(setup_engine.sys, "platform", "darwin"),
              patch.object(setup_engine.socket, "create_connection", side_effect=self.connect),
              patch.object(setup_engine.subprocess, "Popen", return_value=self.trial),
              patch.object(setup_engine.subprocess, "run", side_effect=run),
              patch.object(setup_engine, "atomic_write") as write,
              patch.dict(os.environ, {"PLAYWRIGHT_MCP_PROBE_MODE": "proxy"})):
            # Synthetic fixture only; no real credential is read, written or transmitted.
            data = {"confirmed": True, "token": "x" * 32}
            if trial_ok:
                result = self.engine.activate_browser_extension(data)
                self.assertEqual(result["mode"], "extension")
                self.assertEqual(write.call_count, 2)
            else:
                with self.assertRaises(setup_engine.SetupError):
                    self.engine.activate_browser_extension(data)
                write.assert_not_called()
        self.trial.terminate.assert_called_once()
        self.trial.wait.assert_called_once()
        self.assertFalse((self.engine.appdata / "playwright/extension-token").exists())
        return [kw["env"] for argv, kw in self.calls
                if argv[-1] == str(self.engine.root / "playwright/probe.mjs")]

    def test_trial_forces_direct_mode_before_settings_change(self):
        envs = self.invoke(trial_ok=False)
        self.assertEqual(len(envs), 1)
        self.assertEqual(envs[0]["PLAYWRIGHT_MCP_URL"], "http://127.0.0.1:8999/mcp")
        self.assertEqual(envs[0]["PLAYWRIGHT_MCP_PROBE_MODE"], "direct")
        self.assertEqual(envs[0]["PLAYWRIGHT_MCP_VERIFY_TABS"], "1")

    def test_final_probe_inherits_direct_mode_without_environment_token(self):
        envs = self.invoke(trial_ok=True)
        self.assertEqual(len(envs), 2)
        self.assertEqual(envs[1]["PLAYWRIGHT_MCP_URL"], "http://127.0.0.1:8931/mcp")
        self.assertEqual(envs[1]["PLAYWRIGHT_MCP_PROBE_MODE"], "direct")
        self.assertEqual(envs[1]["PLAYWRIGHT_MCP_VERIFY_TABS"], "1")
        self.assertNotIn("PLAYWRIGHT_MCP_EXTENSION_TOKEN", envs[1])


if __name__ == "__main__":
    unittest.main()
