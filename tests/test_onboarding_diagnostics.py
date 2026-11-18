"""First-run diagnostic capture: fidelity, redaction, rotation and export."""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "onboarding"))
import diagnostics as d


class OnboardingDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patched = patch.dict(os.environ, {"MCPGO_USER_DATA": self.temp.name})
        self.patched.start()
        self.addCleanup(self.patched.stop)
        d._SECRET_VALUES.clear()

    def records(self):
        return [json.loads(row) for row in
                (d.log_dir() / "onboarding.log").read_text("utf-8").splitlines()]

    def test_records_every_step_with_stable_attempt_and_millisecond_timestamp(self):
        d.event("start", step=1)
        d.event("complete", step=2)
        rows = self.records()
        self.assertEqual([row["event"] for row in rows], ["start", "complete"])
        self.assertEqual(rows[0]["attempt"], rows[1]["attempt"])
        self.assertRegex(rows[0]["time"], r"\.\d{3}\+00:00$")
        self.assertEqual(rows[1]["details"]["step"], 2)
        if os.name != "nt":
            self.assertEqual((d.log_dir() / "onboarding.log").stat().st_mode & 0o077, 0)

    def test_redacts_explicit_and_implicit_credentials_in_text_and_nested_json(self):
        admin = "sk-ADMINSECRET987654321"
        runtime = "sk-RUNTIMESECRET987654321"
        opaque = "arbitrary-unique-password-UNSAFE"
        d.register_secrets({"adminKey": admin, "password": opaque})
        d.event("remote.http", stdout=json.dumps({
            "nested": {"api_key": {"value": runtime}},
            "authorization": "Bearer " + admin,
            "message": "failed password=" + opaque,
        }), credential=runtime, nested={"privateKey": opaque})
        raw = (d.log_dir() / "onboarding.log").read_text("utf-8")
        for secret in (admin, runtime, opaque):
            self.assertNotIn(secret, raw)
        self.assertIn("[REDACTED]", raw)
        self.assertIn("remote.http", raw)

    def test_captures_subprocess_exit_and_output_without_leaking_secret(self):
        secret = "sk-XXYYZZ001122334455"
        d.register_secrets({"runtimeKey": secret})
        d.run_logged([sys.executable, "-c",
                      "import sys;print('hello');sys.stderr.write('" + secret + "')"],
                     text=True, capture_output=True)
        data = (d.log_dir() / "onboarding.log").read_text("utf-8")
        self.assertIn("subprocess.complete", data)
        self.assertIn("hello", data)
        self.assertNotIn(secret, data)

    def test_does_not_log_keychain_plaintext_even_for_unknown_credential_format(self):
        secret = "personal-secret-without-known-token-prefix-very-private"
        result = d.run_logged([sys.executable, "-c", "print(" + repr(secret) + ")"],
                              capture_output=True, text=True,
                              diagnostic_secret_output=True)
        self.assertEqual(result.stdout.strip(), secret)
        saved = (d.log_dir() / "onboarding.log").read_text("utf8")
        self.assertNotIn(secret, saved)
        self.assertIn("SENSITIVE_OUTPUT", saved)

    def test_rotates_and_exports_old_and_new_logs(self):
        with patch.object(d, "MAX_LOG", 200):
            for i in range(6):
                d.event("stage", step=i, detail="a" * 120)
        self.assertTrue(list((d.log_dir() / "archive").glob("*.log")))
        out = Path(self.temp.name) / "mcpgo-onboarding-diagnostics-test.zip"
        response = d.export_zip(str(out))
        self.assertEqual(response["fileName"], out.name)
        with zipfile.ZipFile(out) as archive:
            names = archive.namelist()
            self.assertIn("logs/onboarding.log", names)
            self.assertIn("manifest.json", names)
            self.assertGreater(len(names), 2)
        # The native Save dialog allows replacing a previously exported archive.
        d.export_zip(str(out))
        self.assertTrue(out.is_file())

    def test_parallel_events_are_valid_json_lines(self):
        threads = [threading.Thread(target=lambda index=i: [
            d.event("concurrent", index=index, iteration=j) for j in range(8)])
            for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        rows = self.records()
        self.assertEqual(len(rows), 32)
        self.assertEqual(len({row["attempt"] for row in rows}), 1)

    def test_export_rejects_other_extensions_or_symlink(self):
        d.event("ready")
        with self.assertRaises(ValueError):
            d.export_zip(str(Path(self.temp.name) / "important.txt"))
        link = Path(self.temp.name) / "mcpgo-onboarding-diagnostics-link.zip"
        link.symlink_to(Path(self.temp.name) / "target.txt")
        with self.assertRaises(ValueError):
            d.export_zip(str(link))


if __name__ == "__main__":
    unittest.main()
