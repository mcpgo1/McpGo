"""License consistency checks for McpGo public source distribution."""
import json
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

class OpenSourceLicenseTests(unittest.TestCase):
    def test_mit_full_text_and_notice(self):
        license_text=(ROOT/"LICENSE").read_text(encoding="utf-8")
        self.assertTrue(license_text.startswith("MIT License\n\n"))
        self.assertIn("Copyright (c) 2026 McpGo contributors",license_text)
        self.assertIn("Permission is hereby granted, free of charge",license_text)
        self.assertIn("The above copyright notice and this permission notice",license_text)
        self.assertIn('THE SOFTWARE IS PROVIDED "AS IS"',license_text)
        self.assertIn("THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",license_text)

    def test_readmes_link_to_licensing_terms(self):
        for name in ("README.md","docs/README.md"):
            with self.subTest(file=name):
                source=(ROOT/name).read_text(encoding="utf-8")
                self.assertIn("License: MIT",source)
                self.assertIn("THIRD_PARTY_NOTICES.md",source)

    def test_node_metadata_and_external_notices(self):
        package=json.loads((ROOT/"playwright/package.json").read_text())
        lock=json.loads((ROOT/"playwright/package-lock.json").read_text())
        self.assertEqual(package["license"],"MIT")
        self.assertEqual(lock["packages"][""]["license"],"MIT")
        notices=(ROOT/"THIRD_PARTY_NOTICES.md").read_text()
        for dependency in ("@playwright/mcp","playwright-core","Apache-2.0","tunnel-client"):
            with self.subTest(dependency=dependency):
                self.assertIn(dependency,notices)

if __name__=="__main__":
    unittest.main()
