import gzip
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

script = Path(__file__).resolve().parents[2] / "scripts/replay/export-source-archive.py"
spec = importlib.util.spec_from_file_location("source_archive", script)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class SourceArchiveTests(unittest.TestCase):
    def test_keeps_source_identities_and_discards_non_accounting_secrets(self):
        line = json.dumps({
            "received_at": "2026-11-20T12:00:00Z", "stored_rows": 1,
            "payload": [{
                "action": "user_created",
                "username": "original-account",
                "user": {
                    "id": 901, "username": "original-account",
                    "admin": {"id": 208, "username": "original-admin", "token": "private"},
                    "subscription_url": "private",
                    "next_plan": {"subscription_url": "private"},
                },
                "by": {"id": None, "username": "original-actor"},
            }],
        })
        with TemporaryDirectory() as folder:
            target, batches, children = exporter.write_archive(
                [line], Path(folder), 122, "2026-11-21T20:30:00+00:00")
            self.assertEqual((batches, children), (1, 1))
            payload = json.loads(gzip.decompress(target.read_bytes()))["payload"]
            self.assertEqual(payload, [{
                "action": "user_created", "username": "original-account",
                "user": {
                    "id": 901, "username": "original-account",
                    "admin": {"id": 208, "username": "original-admin"},
                    "next_plan": True,
                },
                "by": {"id": None, "username": "original-actor"},
            }])
            manifest = json.loads(target.with_suffix("").with_suffix(".manifest.json").read_text())
            self.assertEqual(manifest["identity"], "source-webhook")
            self.assertEqual(manifest["actor_object_null_id_events"], 1)
            repeat, _, _ = exporter.write_archive(
                [line], Path(folder), 122, "2026-11-21T20:30:00+00:00")
            self.assertEqual(target, repeat)


if __name__ == "__main__":
    unittest.main()
