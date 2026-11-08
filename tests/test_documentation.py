"""Regression gates for McpGo public-facing documentation and standalone CDP scripts."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"

class DocumentationTests(unittest.TestCase):
    def test_index_and_required_sections(self):
        required = {
            "README.md", "GETTING_STARTED.md", "ARCHITECTURE.md",
            "CONFIGURATION.md", "INTERFACES.md", "AUTOSEND.md",
            "OPERATIONS.md", "SECURITY.md", "DEVELOPMENT.md",
            "MIGRATION.md",
        }
        self.assertTrue(all((DOCS / x).is_file() for x in required))
        source=(ROOT / "native/main.swift").read_text()
        self.assertIn('SidebarLink(name: "Журналы"', source)
        self.assertIn('model.openLogs()', source)
        self.assertIn('"Library/Logs/McpGo"', source)
        self.assertIn('SidebarLink(name: "Документация"', source)
        self.assertIn('model.openDocumentation()', source)
        self.assertIn('"Documentation/index.html"', source)
        self.assertNotIn('model.openFolder("/docs/README.md")', source)
        self.assertNotIn('model.openFolder("/logs")', source)

    def test_offline_documentation_is_bundled_in_both_app_builds(self):
        html=ROOT / "assets/docs/index.html"
        self.assertTrue(html.is_file())
        page=html.read_text(encoding="utf-8")
        self.assertIn('<html lang="ru">', page)
        self.assertIn('McpGo — документация', page)
        self.assertIn('Library/Logs/McpGo', page)
        self.assertIn('chrome://inspect/#remote-debugging', page)
        dev=(ROOT / "scripts/dev_preview_macos.sh").read_text()
        release=(ROOT / "scripts/build_release_dmg.py").read_text()
        self.assertIn('assets/docs/index.html', dev)
        self.assertIn('Documentation/index.html', dev)
        self.assertIn('assets/docs/index.html', release)
        self.assertIn('Documentation', release)

    def test_relative_markdown_links(self):
        files = [ROOT / "README.md", ROOT / "CONTRIBUTING.md", *DOCS.glob("*.md")]
        for file in files:
            text = file.read_text()
            for url in re.findall(r"\]\(([^)]+)\)", text):
                if url.startswith(("http:", "https:", "#", "mailto:")):
                    continue
                target = (file.parent / url.split("#", 1)[0]).resolve()
                with self.subTest(file=str(file), link=url):
                    self.assertTrue(target.exists(), f"Missing: {url}")

    def test_no_other_project_in_public_docs(self):
        files = [ROOT / "README.md", ROOT / "CONTRIBUTING.md",
                 *DOCS.glob("*.md"), *(ROOT / "skills").glob("*/SKILL.md"),
                 ROOT / "playwright/README.md", ROOT / "terminal/README.md",
                 ROOT / "autosend/README.md"]
        for file in files:
            with self.subTest(file=file.name):
                self.assertNotRegex(file.read_text().lower(), "old-unrelated-project-marker")

    def test_browser_scripts_are_self_contained(self):
        for name in ("start.sh", "start-tunnel.sh", "configure-tunnel.sh"):
            s = (ROOT / "playwright" / name).read_text()
            self.assertIn('BASH_SOURCE[0]', s)
            self.assertNotIn("git -C", s)
            self.assertNotIn("old-unrelated-project-marker", s.lower())

if __name__ == "__main__":
    unittest.main()
