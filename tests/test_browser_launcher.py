"""Browser launcher must resolve file:// URLs correctly in Application Support paths."""
import json
import tempfile
import sys
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

    @unittest.skipUnless(sys.platform == "darwin", "macOS launcher socket path")
    def test_long_install_path_can_bind_shared_browser_socket(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js unavailable")
        with tempfile.TemporaryDirectory(prefix="mcpgo-long-install-") as tmp:
            root = pathlib.Path(tmp) / ("long directory " * 8) / "Application Support/McpGo/Runtime"
            (root / "launchers").mkdir(parents=True)
            cli = root / "playwright/node_modules/@playwright/mcp/cli.js"
            cli.parent.mkdir(parents=True)
            shutil.copyfile(ROOT / "launchers/browser.mjs", root / "launchers/browser.mjs")
            cli.write_text("""
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const base=process.env.PWTEST_SOCKETS_DIR;
const info=fs.lstatSync(base);
if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700)process.exit(9);
const dir=fs.mkdtempSync(path.join(base,'test-'));
const socket=path.join(dir,'browser-0123456789abcdef.sock');
const server=net.createServer();
server.on('error',e=>{console.error(e);process.exit(10)});
server.listen(socket,()=>{
 console.log(JSON.stringify({base,socket,bytes:Buffer.byteLength(socket)}));
 server.close(()=>fs.rmdirSync(dir));
});
""")
            shutil.copyfile(ROOT / "playwright/start.sh", root / "playwright/start.sh")
            (root / "playwright/patch-playwright.mjs").write_text("")
            commands = [[node, str(root / "launchers/browser.mjs")],
                        ["bash", str(root / "playwright/start.sh")]]
            for command in commands:
                with self.subTest(launcher=command[-1]):
                    result = subprocess.run(command, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    actual = json.loads(result.stdout.splitlines()[-1])
                    self.assertLess(actual["bytes"], 104)
                    self.assertNotIn(str(root), actual["base"])

    def test_launcher_syntax_valid(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js unavailable")
        subprocess.run([node, "--check", str(ROOT / "launchers/browser.mjs")],
                       check=True, timeout=8, capture_output=True)


if __name__ == "__main__":
    unittest.main()
