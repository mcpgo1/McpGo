"""Isolated tests for code-only McpGo Dev preview synchronization."""
import importlib.util
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dev_sync_runtime", ROOT / "scripts/dev_sync_runtime.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DevSyncRuntimeTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name)
        self.source = home / "source"
        self.runtime = home / "Runtime"
        self.backup = home / "backups"
        for relative in MODULE.FILES:
            src = self.source / relative
            dst = self.runtime / relative
            src.parent.mkdir(parents=True, exist_ok=True)
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.write_text("new:" + relative)
            dst.write_text("old:" + relative)

    def test_code_only_sync_makes_backup_and_is_idempotent(self):
        with patch.object(MODULE, "ROOT", self.source):
            updated = MODULE.sync(self.runtime, backup_root=self.backup)
            self.assertEqual(set(updated), set(MODULE.FILES))
            for relative in MODULE.FILES:
                self.assertEqual((self.runtime / relative).read_text(), "new:" + relative)
                self.assertEqual(
                    (self.backup / (relative + ".before-dev-2.0.7")).read_text(),
                    "old:" + relative,
                )
            self.assertEqual(MODULE.sync(self.runtime, backup_root=self.backup), [])

    def test_unsafe_symlink_fails_before_modifying_any_source(self):
        link = self.runtime / MODULE.FILES[-1]
        link.unlink()
        link.symlink_to(self.source / MODULE.FILES[-1])
        with patch.object(MODULE, "ROOT", self.source):
            with self.assertRaisesRegex(RuntimeError, "Unsafe runtime path"):
                MODULE.sync(self.runtime, backup_root=self.backup)
        self.assertEqual((self.runtime / MODULE.FILES[0]).read_text(),
                         "old:" + MODULE.FILES[0])

    def test_dev_preview_has_version_and_no_release_builder(self):
        script = (ROOT / "scripts/dev_preview_macos.sh").read_text()
        self.assertIn("CFBundleShortVersionString 2.0.7", script)
        self.assertIn("dev_sync_runtime.py", script)
        self.assertNotIn("build_release_dmg.py", script)
        self.assertNotIn("git push", script)
        source = (ROOT / "native/main.swift").read_text()
        self.assertIn("Установленный MCP: v", source)
        self.assertIn("DEV v", source)
        self.assertIn("Автовосстановление: ", source)
        self.assertIn("mcpVersions", source)
