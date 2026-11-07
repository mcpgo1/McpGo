import pathlib
import plistlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
HOME = pathlib.Path.home()
TARGET = str(HOME / "Library/Application Support/ChatTerminalHub/run-tunnel.sh")

class TunnelLaunchAgentTests(unittest.TestCase):
    def test_new_install_template_uses_stable_path(self):
        with (ROOT / "launchagents/com.chatterminalhub.tunnel.plist").open("rb") as fp:
            config = plistlib.load(fp)
        self.assertEqual(config["ProgramArguments"], [
            "__HOME__/Library/Application Support/ChatTerminalHub/run-tunnel.sh"])
        self.assertNotIn("WorkingDirectory", config)
        self.assertFalse(config["RunAtLoad"])
        self.assertEqual(config["Label"], "com.chatterminalhub.tunnel")

    def test_migration_and_button_are_wired(self):
        dashboard = (ROOT / "dashboard/server.mjs").read_text()
        swift = (ROOT / "native/TunnelSettings.swift").read_text()
        for fragment in ("ensureTerminalTunnel()", "ProgramArguments:0", "Delete :WorkingDirectory", "'terminal-tunnel'"):
            self.assertIn(fragment, dashboard)
        self.assertIn('"group":"terminal-tunnel","action":"restart"', swift)
        self.assertIn("waitFor(async()=>groups[group].every(label=>job(label).running)", dashboard)

    def test_portable_template_renders_for_current_user(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "setup_macos", ROOT / "scripts/setup_macos.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        config = mod.render(ROOT / "launchagents/com.chatterminalhub.tunnel.plist",
                            "/opt/homebrew/bin/node")
        self.assertEqual(config["ProgramArguments"], [TARGET])
        self.assertFalse(config["RunAtLoad"])
        self.assertEqual(config["Label"], "com.chatterminalhub.tunnel")
        self.assertEqual(config["EnvironmentVariables"]["MCPGO_INSTALL_ROOT"], str(ROOT))

if __name__ == "__main__":
    unittest.main()
