"""Portable DMG checks; never install services or use the user's home."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import shutil
from unittest.mock import patch
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DmgPackagingTests(unittest.TestCase):
    def test_source_allowlist_excludes_private_state(self):
        builder = load_script("build_release_dmg", ROOT / "scripts/build_release_dmg.py")
        self.assertNotIn("release", builder.SOURCES)
        self.assertIn("action-guard.mjs", builder.SOURCES["playwright"])
        self.assertIn("job_worker.js", builder.SOURCES["terminal"])
        for entry in ("resource_locks.js", "resource_policy.js", "mcp-version.json"):
            self.assertIn(entry, builder.SOURCES["terminal"])
        for entry in ("tunnel-health.mjs", "tunnel-recovery.mjs", "mcp-versions.mjs"):
            self.assertIn(entry, builder.SOURCES["dashboard"])
        for entry in ("chat-state.mjs", "guarded-send.mjs", "browser-events.mjs",
                      "conversation-fsm.mjs"):
            self.assertIn(entry, builder.SOURCES["autosend"])
        for parent, files in builder.SOURCES.items():
            self.assertFalse(parent.startswith("."))
            for name in files:
                with self.subTest(name=f"{parent}/{name}"):
                    self.assertFalse(name.startswith("."))
                    self.assertNotIn("/", name)
                    self.assertNotIn("config.json", name)
                    self.assertFalse(name.endswith(".log"))
                    self.assertFalse(name.endswith(".sqlite"))

    def test_app_stages_from_source_only_without_a_compiled_bundle(self):
        """A clean Git checkout must not need McpGo.app or old signatures."""
        builder = load_script("build_release_src_only", ROOT / "scripts/build_release_dmg.py")
        with tempfile.TemporaryDirectory(prefix="mcpgo-source-only-") as tmp:
            temp = Path(tmp)
            source = temp / "project"
            for name in ("Info.plist", "AppIcon.icns", "McpGoMark.png", "McpGoMark.svg"):
                dest = source / "native" / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / "native" / name, dest)
            for original in (ROOT / "assets/onboarding").glob("*.png"):
                dest = source / "assets/onboarding" / original.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, dest)
            offline_doc = source / "assets/docs/index.html"
            offline_doc.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / "assets/docs/index.html", offline_doc)
            for original in (ROOT / "skills").glob("*/SKILL.md"):
                dest = source / "skills" / original.relative_to(ROOT / "skills")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, dest)
            runtime = temp / "RuntimeSeed"
            runtime.mkdir()
            destination = temp / "McpGo.app"
            with patch.object(builder, "PROJECT", source), \
                 patch.object(builder, "command"), \
                 patch.object(builder.subprocess, "check_output", return_value="/fake/sdk"):
                builder.stage_app(runtime, destination, "2.0.3")
            self.assertFalse((source / "McpGo.app").exists())
            self.assertTrue((destination / "Contents/Info.plist").is_file())
            self.assertTrue((destination / "Contents/Resources/HelpImages").is_dir())
            self.assertTrue((destination / "Contents/Resources/RuntimeSeed").is_dir())
            self.assertTrue((destination / "Contents/Resources/AppIcon.icns").is_file())
            import plistlib
            self.assertEqual(plistlib.loads((destination / "Contents/Info.plist").read_bytes())["CFBundleShortVersionString"], "2.0.3")

    def test_user_launchagent_templates_use_bundled_runtime_when_present(self):
        setup = load_script("setup_macos_for_dmg_tests", ROOT / "scripts/setup_macos.py")
        with tempfile.TemporaryDirectory(prefix="mcpgo-dmg-test-") as tmp:
            fake_root = Path(tmp) / "Runtime"
            home = Path(tmp) / "a different macOS user"
            (fake_root / "vendor/node/bin").mkdir(parents=True)
            (fake_root / "vendor/python/bin").mkdir(parents=True)
            (fake_root / "vendor/tunnel/bin").mkdir(parents=True)
            (fake_root / "vendor/python/bin/python3").write_text("dummy")
            (fake_root / "vendor/tunnel/bin/tunnel-client").write_text("dummy")
            setup.ROOT = fake_root
            setup.HOME = home
            template = ROOT / "launchagents/com.mcphub.messaging.plist"
            parsed = setup.render(template, str(fake_root / "vendor/node/bin/node"))
            self.assertEqual(
                parsed["EnvironmentVariables"]["MCPGO_INSTALL_ROOT"], str(fake_root)
            )
            self.assertEqual(
                parsed["EnvironmentVariables"]["MCPGO_PYTHON_BIN"],
                str(fake_root / "vendor/python/bin/python3"),
            )
            self.assertTrue(parsed["EnvironmentVariables"]["PATH"].startswith(
                str(fake_root / "vendor/node/bin")
            ))
            self.assertNotIn("__MCPGO_ROOT__", str(parsed))
            self.assertNotIn("__HOME__", str(parsed))

    def test_staged_app_has_integrity_manifest_when_built(self):
        # CI needn't download 150 MB of runtime; production artifact tests run on
        # a distribution machine after packaging.
        seed = ROOT / "release/build/McpGo.app/Contents/Resources/RuntimeSeed"
        if not seed.is_dir():
            self.skipTest("Release bundle has not been built on this machine")
        manifest = json.loads((seed / "release-manifest.json").read_text())
        self.assertEqual(manifest["platform"], "macos-arm64")
        self.assertEqual(set(manifest["bundled"]),
                         {"node", "python", "tunnel-client", "playwright"})
        for file in ("vendor/node/bin/node", "vendor/node/bin/npm",
                     "vendor/python/bin/python3", "vendor/tunnel/bin/tunnel-client",
                     "playwright/node_modules/@playwright/mcp/cli.js",
                     "onboarding/cli.py", "scripts/setup_macos.py"):
            self.assertTrue((seed / file).exists(), file)


if __name__ == "__main__":
    unittest.main()
