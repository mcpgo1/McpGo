"""Additional public-documentation regression gates."""
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"

class PublicDocsTests(unittest.TestCase):
    def test_technical_chapters_exist(self):
        required = [
            "README", "GETTING_STARTED", "ARCHITECTURE", "COMPONENTS",
            "DESKTOP", "TERMINAL", "BROWSER", "MESSAGING", "AUTOSEND",
            "INTERFACES", "CONFIGURATION", "DATA", "SECURITY",
            "THREAT_MODEL", "AUDIT_GUIDE", "FAILURE_MODES", "PACKAGING",
            "OPERATIONS", "VERIFICATION", "MIGRATION", "DEVELOPMENT",
            "PUBLIC_RELEASE", "FAQ", "SOURCE_INVENTORY", "DEPENDENCIES",
        ]
        for name in required:
            with self.subTest(chapter=name):
                path = DOCS / (name + ".md")
                self.assertTrue(path.is_file())
                self.assertGreater(len(path.read_text()), 1200)

    def test_user_readme_and_technical_reference_are_linked(self):
        # Public landing README is written for new users; docs/README.md
        # remains the independent, detailed technical reference.
        landing = (ROOT / "README.md").read_text()
        technical = (DOCS / "README.md").read_text()
        self.assertIn("docs/README.md", landing)
        self.assertIn("../README.md", technical)
        self.assertIn("Где скачать McpGo", landing)
        self.assertIn("Установка для обычного пользователя", landing)
        self.assertIn("технический справочник", technical)

    def test_source_inventory_is_current(self):
        run = subprocess.run(
            ["python3", "tools/generate_source_inventory.py", "--check"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)


class PublicReleaseSafetyTests(unittest.TestCase):
    def test_source_export_ignore_patterns(self):
        ignore = (ROOT / ".gitignore").read_text()
        for name in (
            "terminal/config.json", "terminal/stateless-config.json",
            "messaging/data/", "playwright/.cache/", "**/node_modules/",
            "**/logs/", "*.app/",
        ):
            with self.subTest(pattern=name):
                self.assertIn(name, ignore)

    def test_public_docs_do_not_embed_local_username(self):
        public = [ROOT / "README.md", ROOT / "CONTRIBUTING.md", *DOCS.glob("*.md")]
        for file in public:
            with self.subTest(file=file.name):
                self.assertNotRegex(file.read_text(), r"/Users/[^/\s]+/Desktop/")

    def test_readme_discloses_open_source_limitations(self):
        readme = (ROOT / "README.md").read_text()
        for requirement in ("LICENSE", "Chrome", "Terminal", "PUBLIC_RELEASE.md"):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, readme)
