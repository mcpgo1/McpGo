"""Source/integration safety gates for the first-run McpGo wizard."""
import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class OnboardingSafetyTests(unittest.TestCase):
    def test_launcher_only_opens_app(self):
        launcher = (ROOT / "scripts/launch-macos.sh").read_text()
        self.assertIn('/usr/bin/open "$ROOT/McpGo.app"', launcher)
        self.assertNotIn("--install", launcher)
        self.assertNotIn("npm ci", launcher)

    def test_swiftui_uses_stdin_and_keychain(self):
        ui = (ROOT / "native/OnboardingView.swift").read_text()
        self.assertIn('p.standardInput = input', ui)
        self.assertIn('PrivateKeychain.save(service:TunnelPaths.terminalService', ui)
        self.assertIn('PrivateKeychain.save(service:TunnelPaths.browserService', ui)
        self.assertIn('WizardBridge.perform("check-ownership")', ui)
        self.assertIn('.privacySensitive()', ui)
        self.assertNotIn('p.arguments = [root + "/onboarding/cli.py", action, adminKey]', ui)

    def test_app_does_not_auto_bootstrap_other_installations(self):
        swift = (ROOT / "native/main.swift").read_text()
        self.assertIn('standardizedFileURL.path.hasPrefix(root + "/")', swift)
        self.assertIn('source).standardizedFileURL.path==root', swift)

    def test_launchagent_owner_marker_survives_render_and_inspection(self):
        spec = importlib.util.spec_from_file_location(
            "setup_macos", ROOT / "scripts/setup_macos.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        template = ROOT / "launchagents/com.chatterminalhub.tunnel.plist"
        rendered = installer.render(template, "/opt/homebrew/bin/node")
        self.assertEqual(rendered["EnvironmentVariables"]["MCPGO_INSTALL_ROOT"], str(ROOT))
        with tempfile.TemporaryDirectory() as scratch:
            current = Path(scratch) / "terminal.plist"
            current.write_bytes(plistlib.dumps(rendered))
            self.assertEqual(installer.installed_owner(current), "this")
            rendered["EnvironmentVariables"]["MCPGO_INSTALL_ROOT"] = "/different/install"
            current.write_bytes(plistlib.dumps(rendered))
            self.assertEqual(installer.installed_owner(current), "different")

    def test_cli_exposes_only_known_actions(self):
        source = (ROOT / "onboarding/cli.py").read_text()
        self.assertIn("ACTIONS =", source)
        self.assertIn("'verify-local'", source)
        self.assertNotIn("eval(", source)
        self.assertNotIn("shell=True", source)


if __name__ == "__main__":
    unittest.main()
