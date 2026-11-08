"""Browser launcher must resolve file:// URLs correctly in Application Support paths."""
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class BrowserLauncherPathsTests(unittest.TestCase):
    def test_browser_launcher_decodes_file_urls(self):
        source = (ROOT / "launchers/browser.mjs").read_text()
        self.assertIn("fileURLToPath(new URL('../playwright/',import.meta.url))", source)
        self.assertNotIn("new URL('../playwright/',import.meta.url).pathname", source)

    def test_node_url_decoder_preserves_space_and_unicode(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js unavailable")
        sample = "Mac с пробелом/Application Support"
        code = """
const {fileURLToPath,pathToFileURL}=require('node:url');
const path=require('node:path');
const root=path.join('/tmp',process.argv[1],'launchers','browser.mjs');
const url=pathToFileURL(root);
const got=fileURLToPath(new URL('../playwright/',url));
if(got!==path.join('/tmp',process.argv[1],'playwright')+'/')process.exit(7);
"""
        proc = subprocess.run([node, "-e", code, sample],
                              capture_output=True, text=True, timeout=8)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_launcher_syntax_valid(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js unavailable")
        subprocess.run([node, "--check", str(ROOT / "launchers/browser.mjs")],
                       check=True, timeout=8, capture_output=True)


if __name__ == "__main__":
    unittest.main()
