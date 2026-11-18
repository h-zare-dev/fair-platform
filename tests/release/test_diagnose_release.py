import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('diagnose_release', ROOT / 'scripts/staging/diagnose-release.py')
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


class FakeDocker:
    def __init__(self, test):
        self.test = test
        self.orphan = False
        self.drift = False
        self.mount_order = True
        self.migration_drift = False

    def operations_absent(self):
        return not self.orphan

    def inspect(self, name):
        key = name.removeprefix('fair-staging-').removesuffix('-1')
        key = 'api' if key == 'owner-api' else key
        mounts = list(reversed(self.test.mounts)) if self.mount_order else self.test.mounts
        return {
            'Id': 'c' * 64,
            'Image': 'sha256:' + 'd' * 64,
            'Config': {'Image': 'WRONG' if self.drift and key == 'postgres' else self.test.accepted[key]},
            'State': {'Running': True, 'Health': {'Status': 'healthy'}},
            'Mounts': mounts,
        }

    def release_check(self, root):
        result = dict(self.test.migration_report)
        if self.migration_drift:
            result['migrations'] = []
        return result


class DiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = self.root / 'settings'
        self.settings.mkdir()
        digest = hashlib.sha256()
        for name in ('compose.yml', 'Caddyfile'):
            content = f'accepted {name}'.encode()
            (self.root / name).write_bytes(content)
            digest.update(name.encode() + b'\0' + content)
        self.accepted = {
            'sha': 'a' * 40,
            'schema': 'fp003b-v1',
            'configHash': digest.hexdigest(),
            'api': 'api@digest', 'web': 'web@digest',
            'caddy': 'caddy@digest', 'postgres': 'postgres@digest',
        }
        self.mounts = [
            {'Type': 'bind', 'Source': '/restricted', 'Destination': '/run/secrets', 'RW': False},
            {'Type': 'volume', 'Source': '/volume', 'Destination': '/var/lib/postgresql/data', 'RW': True},
        ]
        self.baseline = {'configuredMigrations': ['a', 'b'], 'hashes': {'x': 'digest'}}
        self.migration_report = {
            'schema': 'fp003b-v1',
            'configuredMigrations': ['a', 'b'],
            'migrations': ['b', 'a'],
            'hashes': {'x': 'digest'},
        }
        self.write(self.root / 'current.json', self.accepted)
        self.write(self.root / 'high-water.json', {'sha': 'a' * 40})
        self.write(self.root / 'release-state.json', {
            'sha': 'b' * 40, 'status': 'in-progress', 'phase': 'preflight',
            'completed': 'preflight', 'previous': self.accepted,
            'candidate': {'sha': 'b' * 40},
            'database': {'id': 'c' * 64, 'image': 'sha256:' + 'd' * 64,
                         'mounts': self.mounts},
        })
        self.write(self.settings / 'compatible-migrations.json', self.baseline)
        self.write(self.settings / 'activation.json', {
            'backupPolicy': 'local-verified-v1', 'schema': 'fp003b-v1',
        })
        self.now = dt.datetime(2026, 11, 18, tzinfo=dt.timezone.utc)
        self.write(self.settings / 'restore-verified.json', {
            'backupPolicy': 'local-verified-v1',
            'verifiedAt': (self.now - dt.timedelta(hours=1)).isoformat(),
        })
        self.docker = FakeDocker(self)

    def write(self, path, obj):
        path.write_text(json.dumps(obj))

    def run_diagnostic(self):
        return diagnostics.diagnose(self.root, self.settings, self.docker, self.now)

    def test_order_only_mount_change_is_not_a_database_change(self):
        result = self.run_diagnostic()
        self.assertTrue(result['checks']['postgres_preflight_mounts_unordered'])
        self.assertTrue(result['operator_reconciliation_candidate'])
        self.assertFalse(result['persistent_changes_made'])

    def test_different_mount_source_blocks_reconciliation(self):
        self.mounts[0]['Source'] = '/changed'
        result = self.run_diagnostic()
        self.assertFalse(result['checks']['postgres_preflight_mounts_unordered'])
        self.assertFalse(result['operator_reconciliation_candidate'])

    def test_orphan_or_image_drift_blocks_reconciliation(self):
        self.docker.orphan = True
        self.assertFalse(self.run_diagnostic()['operator_reconciliation_candidate'])
        self.docker.orphan = False
        self.docker.drift = True
        self.assertFalse(self.run_diagnostic()['operator_reconciliation_candidate'])

    def test_incomplete_migrations_block_reconciliation(self):
        self.docker.migration_drift = True
        result = self.run_diagnostic()
        self.assertFalse(result['checks']['database_migrations_match_approved'])
        self.assertFalse(result['operator_reconciliation_candidate'])

    def test_wrong_accepted_sha_blocks_reconciliation(self):
        self.write(self.root / 'high-water.json', {'sha': 'e' * 40})
        self.assertFalse(self.run_diagnostic()['operator_reconciliation_candidate'])

    def test_compose_configuration_drift_blocks_reconciliation(self):
        (self.root / 'Caddyfile').write_text('unexpected change')
        self.assertFalse(self.run_diagnostic()['operator_reconciliation_candidate'])

    def test_stale_restore_evidence_blocks_reconciliation(self):
        self.write(self.settings / 'restore-verified.json', {
            'backupPolicy': 'local-verified-v1',
            'verifiedAt': '2020-01-01T00:00:00+00:00',
        })
        self.assertFalse(self.run_diagnostic()['operator_reconciliation_candidate'])

    def test_migration_catalog_exactness(self):
        self.assertTrue(diagnostics.same_migrations(self.baseline, self.migration_report))
        for mutation in (
            {'configuredMigrations': ['a']},
            {'migrations': ['a']},
            {'migrations': ['a', 'unknown']},
            {'hashes': {'x': 'changed'}},
            {'schema': 'other'},
        ):
            with self.subTest(mutation=mutation):
                self.assertFalse(diagnostics.same_migrations(
                    self.baseline, {**self.migration_report, **mutation}))

    def test_no_secrets_or_host_paths_in_diagnostic_output(self):
        result = json.dumps(self.run_diagnostic(), sort_keys=True)
        self.assertNotIn('/restricted', result)
        self.assertNotIn('postgres_password', result)
        self.assertNotIn('digest', result)
        self.assertIn('candidate_sha', result)

    def test_workflow_keeps_staging_secrets_out_of_pr_events(self):
        workflow = (ROOT / '.github/workflows/staging-diagnostics.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertIn('push:', workflow)
        self.assertIn('paths:', workflow)
        self.assertIn('scripts/staging/diagnose-release.py', workflow)
        self.assertNotIn('pull_request:', workflow)
        self.assertIn('github.ref_protected', workflow)
        self.assertIn("github.actor == 'h-zare-dev'", workflow)
        self.assertIn('environment: staging-bootstrap', workflow)
        self.assertIn('StrictHostKeyChecking=yes', workflow)
        self.assertIn('github.ref == \'refs/heads/development\'', workflow)
        self.assertNotIn('rm -f /opt/fair-staging', workflow)


if __name__ == '__main__':
    unittest.main()
