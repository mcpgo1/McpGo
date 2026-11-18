"""Installer browser check is read-only, precise, and never blocks McpGo."""
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "onboarding"))
from browser_compat import (BACKGROUND_MINIMUM_TEXT, browser_check, compatible_version,
                            _spotlight_chrome_paths, mac_chrome_version, mac_extension_profile, version_tuple)


class BrowserCompatibilityTests(unittest.TestCase):
    def test_exact_background_threshold(self):
        self.assertEqual(BACKGROUND_MINIMUM_TEXT, "158.0.8127.2")
        self.assertFalse(compatible_version("157.0.8103.52"))
        self.assertFalse(compatible_version("158.0.8127.1"))
        self.assertTrue(compatible_version("158.0.8127.2"))
        self.assertTrue(compatible_version("159.0.0.0"))
        self.assertFalse(compatible_version("158.0.8127.beta"))
        self.assertIsNone(version_tuple("157; rm -rf /"))

    def test_outdated_is_a_warning_not_installer_failure(self):
        result = browser_check("chrome", version="157.0.8103.52")
        self.assertEqual(result["status"], "outdated")
        self.assertFalse(result["backgroundReady"])
        self.assertFalse(result["blocking"])
        self.assertEqual(result["updateUrl"], "https://www.google.com/chrome/")
        self.assertEqual(browser_check("chrome", version="158.0.8127.2")["status"], "ready")
        self.assertEqual(browser_check("chrome", version="invalid")["status"], "not-found")
        self.assertEqual(browser_check("msedge", version="157.0.0.0")["updateUrl"],
                         "https://www.microsoft.com/edge")
        edge = browser_check("msedge", version="158.0.1200.10")
        self.assertTrue(edge["backgroundReady"])
        self.assertTrue(edge["requiresRealBrowserVerification"])
        self.assertEqual(edge["minimumVersion"], "158")
        with self.assertRaises(ValueError):
            browser_check("bad-browser", version="159.0.0.0")

    def test_macos_checks_genuine_google_chrome_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            app = pathlib.Path(temp) / "Google Chrome.app"
            info = app / "Contents/Info.plist"
            info.parent.mkdir(parents=True)
            info.write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "com.google.Chrome",
                "CFBundleShortVersionString": "158.0.8127.2",
            }))
            self.assertEqual(mac_chrome_version(paths=[app]), "158.0.8127.2")
            info.write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "org.chromium.Chromium",
                "CFBundleShortVersionString": "159.0.0.0",
            }))
            self.assertIsNone(mac_chrome_version(paths=[app]))
            info.write_bytes(b"broken plist")
            self.assertIsNone(mac_chrome_version(paths=[app]))

    def test_spotlight_finds_chrome_outside_default_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            app = pathlib.Path(temp) / "Unusual Location" / "Google Chrome.app"
            info = app / "Contents/Info.plist"
            info.parent.mkdir(parents=True)
            info.write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "com.google.Chrome",
                "CFBundleShortVersionString": "9999.0.0.0",
            }))
            # The default /Applications copy may exist; the discovered, newer
            # genuine copy must not be discarded.
            with patch("browser_compat._spotlight_chrome_paths", return_value=[app]):
                self.assertEqual(mac_chrome_version(home=pathlib.Path(temp) / "home"),
                                 "9999.0.0.0")

    def test_spotlight_search_is_read_only_and_nonblocking(self):
        app = pathlib.Path("/Volumes/Browser Drive/Google Chrome.app")
        with patch("browser_compat.subprocess.run",
                   return_value=subprocess.CompletedProcess(
                       args=[], returncode=0,
                       stdout=str(app) + "\n/irrelevant/Chrome Helper\n", stderr="")) as run:
            self.assertEqual(_spotlight_chrome_paths(), [app])
            run.assert_called_once_with(
                ["/usr/bin/mdfind", 'kMDItemCFBundleIdentifier == "com.google.Chrome"'],
                capture_output=True, text=True, timeout=3, check=False)
        with patch("browser_compat.subprocess.run",
                   side_effect=subprocess.TimeoutExpired("mdfind", 3)):
            self.assertEqual(_spotlight_chrome_paths(), [])

    def test_mac_chooses_newer_version_and_ignores_other_bundles(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            apps = [root / "old.app", root / "new.app", root / "fake.app"]
            for app, bundle, version in (
                (apps[0], "com.google.Chrome", "157.0.8103.79"),
                (apps[1], "com.google.Chrome", "158.0.8127.36"),
                (apps[2], "org.chromium.Chromium", "9999.0.0.0"),
            ):
                info = app / "Contents/Info.plist"
                info.parent.mkdir(parents=True)
                info.write_bytes(plistlib.dumps({
                    "CFBundleIdentifier": bundle,
                    "CFBundleShortVersionString": version,
                }))
            self.assertEqual(mac_chrome_version(paths=apps), "158.0.8127.36")


    def test_extension_profile_unique_selection(self):
        extension_id = "mmlmfjhmonkocbjadbfplnigmagldckm"
        with tempfile.TemporaryDirectory() as temp:
            home = pathlib.Path(temp)
            root = home / "Library/Application Support/Google/Chrome"
            profile = root / "Profile 7/Extensions" / extension_id / "0.5.2_0"
            profile.mkdir(parents=True)
            self.assertEqual(mac_extension_profile(home), "Profile 7")
            (root / "Default/Extensions" / extension_id / "0.5.2_0").mkdir(parents=True)
            self.assertIsNone(mac_extension_profile(home))

    def test_extension_profile_ignores_wrong_extension(self):
        with tempfile.TemporaryDirectory() as temp:
            home = pathlib.Path(temp)
            root = home / "Library/Application Support/Google/Chrome"
            (root / "Default/Extensions/wrong-id/0.5.2_0").mkdir(parents=True)
            self.assertIsNone(mac_extension_profile(home))


if __name__ == "__main__":
    unittest.main()
