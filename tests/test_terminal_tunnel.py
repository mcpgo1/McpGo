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

    def test_tunnel_script_expands_binary_path_instead_of_literal(self):
        script = (ROOT / "terminal/run-tunnel.sh").read_text()
        prefix = chr(36) + "{MCPGO_TUNNEL_CLIENT:"
        self.assertIn('exec "' + prefix, script)
        self.assertNotIn(chr(92) + prefix, script)
        subprocess.run(["/bin/zsh", "-n", str(ROOT / "terminal/run-tunnel.sh")],
                       check=True, capture_output=True, timeout=5)

    def test_owned_previous_runner_is_allowed_but_foreign_copy_is_blocked(self):
        import importlib.util
        import tempfile
        from unittest.mock import patch
        spec=importlib.util.spec_from_file_location(
            "setup_tunnel_ownership_test", ROOT / "scripts/setup_macos.py")
        setup=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(setup)
        with tempfile.TemporaryDirectory() as tmp:
            target=pathlib.Path(tmp)
            runtime=target/"Runtime"
            home=target/"User"
            source=runtime/"terminal/run-tunnel.sh"
            installed=home/"Library/Application Support/ChatTerminalHub/run-tunnel.sh"
            source.parent.mkdir(parents=True)
            installed.parent.mkdir(parents=True)
            source.write_text("#!/bin/zsh\\necho updated\\n")
            installed.write_text("#!/bin/zsh\\necho previous-version\\n")
            (runtime/"McpGo.app/Contents").mkdir(parents=True)
            (runtime/"McpGo.app/Contents/Info.plist").write_text("stub")
            (runtime/"launchagents").mkdir()
            with patch.object(setup,"ROOT",runtime),patch.object(setup,"HOME",home),patch.object(setup,"TEMPLATES",runtime/"launchagents"):
                with patch.object(setup,"installed_owner",return_value="this"):
                    allowed,reasons=setup.check()
                    self.assertTrue(allowed,reasons)
                with patch.object(setup,"installed_owner",return_value="different"):
                    allowed,reasons=setup.check()
                    self.assertFalse(allowed)
                    self.assertTrue(any("another installation" in x for x in reasons))
                installed.unlink()
                installed.symlink_to(source)
                with patch.object(setup,"installed_owner",return_value="this"):
                    allowed,reasons=setup.check()
                    self.assertFalse(allowed)

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
