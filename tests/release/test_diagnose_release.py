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
        self.backup_active = False

    def backup_inactive(self):
        return not self.backup_active

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
            'sha': diagnostics.RECOVERY_ACCEPTED,
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
        self.write(self.root / 'high-water.json', {'sha': diagnostics.RECOVERY_ACCEPTED})
        (self.root / 'current.env').write_text('\n'.join(
            f'{key}_IMAGE={self.accepted[service]}' for key, service in
            (('API', 'api'), ('WEB', 'web'), ('CADDY', 'caddy'), ('POSTGRES', 'postgres'))
        ) + '\n')
        self.write(self.root / 'release-state.json', {
            'sha': diagnostics.RECOVERY_CANDIDATE, 'status': 'in-progress', 'phase': 'preflight',
            'completed': 'preflight', 'previous': self.accepted,
            'candidate': {'sha': diagnostics.RECOVERY_CANDIDATE},
            'database': {'id': 'c' * 64, 'image': 'sha256:' + 'd' * 64,
                         'mounts': self.mounts},
        })
        self.write(self.settings / 'compatible-migrations.json', self.baseline)
        self.write(self.settings / 'activation.json', {
            'approval': 'owner-approved-v1',
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

    def test_rollback_phase_diagnostics_expose_no_container_error_or_secret(self):
        state = diagnostics.read_json(self.root / 'release-state.json')
        state.update(status='resolved', phase='rollback-smoke', completed='rollback-smoke',
                     outcome='app-rollback',
                     appFailure={'phase': 'health', 'code': 'HEALTH_FAILED_OPERATOR_REQUIRED',
                                 'private': 'do-not-expose-sensitive-container-stderr'})
        self.write(self.root / 'release-state.json', state)
        report = self.run_diagnostic()
        self.assertEqual(report['journal']['failed_app_phase'], 'health')
        self.assertNotIn('do-not-expose', json.dumps(report))
        self.assertFalse(report['operator_reconciliation_candidate'])

    def test_unknown_rollback_phase_is_sanitized(self):
        state = diagnostics.read_json(self.root / 'release-state.json')
        state.update(status='resolved', outcome='app-rollback',
                     appFailure={'phase': 'health; echo unsafe'})
        self.write(self.root / 'release-state.json', state)
        self.assertEqual(self.run_diagnostic()['journal']['failed_app_phase'], 'INVALID')

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

    def test_accepted_env_drift_blocks_reconciliation(self):
        (self.root / 'current.env').write_text('POSTGRES_IMAGE=unexpected\n')
        self.assertFalse(self.run_diagnostic()['operator_reconciliation_candidate'])

    def test_resolution_preserves_original_journal_and_accepted_state(self):
        original = (self.root / 'release-state.json').read_bytes()
        before = (self.root / 'current.json').read_bytes()
        high = (self.root / 'high-water.json').read_bytes()
        result = diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)
        self.assertEqual(result['status'], 'resolved')
        self.assertFalse(result['database_or_service_changes'])
        archive = self.root / ('release-state.before-' + diagnostics.RECOVERY_CANDIDATE[:8] + '.json')
        self.assertEqual(archive.read_bytes(), original)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        state = diagnostics.read_json(self.root / 'release-state.json')
        self.assertEqual(state['status'], 'resolved')
        self.assertEqual(state['outcome'], 'owner-verified-aborted-after-preflight')
        self.assertEqual(state['resolution']['verifiedAt'], self.now.isoformat())
        self.assertEqual((self.root / 'current.json').read_bytes(), before)
        self.assertEqual((self.root / 'high-water.json').read_bytes(), high)

    def test_resolution_fails_closed_for_unapproved_candidate(self):
        path = self.root / 'release-state.json'
        record = json.loads(path.read_text())
        record['sha'] = record['candidate']['sha'] = 'f' * 40
        self.write(path, record)
        original = path.read_bytes()
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(list(self.root.glob('release-state.before-*.json')))

    def test_resolution_fails_closed_for_an_orphan_without_writing(self):
        self.docker.orphan = True
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)
        self.assertFalse(list(self.root.glob('release-state.before-*.json')))

    def test_resolution_refuses_journal_after_preflight(self):
        path = self.root / 'release-state.json'
        record = json.loads(path.read_text())
        record['phase'] = 'backup'
        self.write(path, record)
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)
        self.assertFalse(list(self.root.glob('release-state.before-*.json')))

    def test_resolution_refuses_mount_drift(self):
        self.mounts[0]['Source'] = '/different'
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)
        self.assertFalse(list(self.root.glob('release-state.before-*.json')))

    def test_resolution_refuses_high_water_drift(self):
        self.write(self.root / 'high-water.json', {'sha': 'f' * 40})
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)
        self.assertFalse(list(self.root.glob('release-state.before-*.json')))

    def test_resolution_refuses_journal_previous_manifest_drift(self):
        path = self.root / 'release-state.json'
        record = json.loads(path.read_text())
        record['previous']['api'] = 'unexpected-image'
        self.write(path, record)
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)
        self.assertFalse(list(self.root.glob('release-state.before-*.json')))

    def test_resolution_not_repeatable_or_replayable(self):
        diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now)

    def set_nov19_preflight_journal(self):
        record = diagnostics.read_json(self.root / 'release-state.json')
        record['sha'] = diagnostics.RECOVERY_NOV19_PREFLIGHT_CANDIDATE
        record['candidate']['sha'] = diagnostics.RECOVERY_NOV19_PREFLIGHT_CANDIDATE
        self.write(self.root / 'release-state.json', record)
        activation = diagnostics.read_json(self.settings / 'activation.json')
        activation['backupPolicy'] = 'staging-no-backup-v1'
        self.write(self.settings / 'activation.json', activation)
        (self.settings / 'restore-verified.json').unlink(missing_ok=True)

    def test_nov19_preflight_reconciliation_preserves_original_and_accepted_state(self):
        self.set_nov19_preflight_journal()
        self.assertTrue(self.run_diagnostic()['operator_reconciliation_candidate'])
        journal = self.root / 'release-state.json'
        before = journal.read_bytes()
        accepted = (self.root / 'current.json').read_bytes()
        high = (self.root / 'high-water.json').read_bytes()
        result = diagnostics.reconcile_preflight(
            self.root, self.settings, self.docker, self.now,
            candidate=diagnostics.RECOVERY_NOV19_PREFLIGHT_CANDIDATE)
        self.assertEqual(result['reconciled_candidate_sha'], diagnostics.RECOVERY_NOV19_PREFLIGHT_CANDIDATE)
        self.assertFalse(result['database_or_service_changes'])
        self.assertEqual((self.root / 'release-state.before-74a1cf88.json').read_bytes(), before)
        self.assertEqual(journal.stat().st_mode & 0o777, 0o600)
        self.assertEqual(diagnostics.read_json(journal)['status'], 'resolved')
        self.assertEqual((self.root / 'current.json').read_bytes(), accepted)
        self.assertEqual((self.root / 'high-water.json').read_bytes(), high)
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now,
                                           candidate=diagnostics.RECOVERY_NOV19_PREFLIGHT_CANDIDATE)

    def test_nov19_preflight_reconciliation_fails_closed_on_drift(self):
        self.set_nov19_preflight_journal()
        path = self.root / 'release-state.json'
        original = path.read_bytes()
        for mutation in ('old workflow', 'unknown candidate', 'active backup',
                         'different volume', 'orphan', 'wrong high water', 'old policy'):
            with self.subTest(mutation=mutation):
                self.write(path, json.loads(original))
                self.write(self.root / 'high-water.json', {'sha': diagnostics.RECOVERY_ACCEPTED})
                self.mounts[0]['Source'] = '/restricted'
                self.docker.orphan = self.docker.backup_active = False
                self.write(self.settings / 'activation.json', {
                    'approval': 'owner-approved-v1', 'schema': 'fp003b-v1',
                    'backupPolicy': 'staging-no-backup-v1'})
                candidate = diagnostics.RECOVERY_NOV19_PREFLIGHT_CANDIDATE
                if mutation == 'old workflow':
                    candidate = diagnostics.RECOVERY_CANDIDATE
                elif mutation == 'unknown candidate':
                    candidate = 'f' * 40
                elif mutation == 'active backup':
                    self.docker.backup_active = True
                elif mutation == 'different volume':
                    self.mounts[0]['Source'] = '/drift'
                elif mutation == 'orphan':
                    self.docker.orphan = True
                elif mutation == 'wrong high water':
                    self.write(self.root / 'high-water.json', {'sha': 'e' * 40})
                elif mutation == 'old policy':
                    self.write(self.settings / 'activation.json', {
                        'approval': 'owner-approved-v1', 'schema': 'fp003b-v1',
                        'backupPolicy': 'local-verified-v1'})
                with self.assertRaises(diagnostics.DiagnosticError):
                    diagnostics.reconcile_preflight(self.root, self.settings, self.docker, self.now,
                                                    candidate=candidate)
                self.assertEqual(path.read_bytes(), original)
                self.assertFalse((self.root / 'release-state.before-74a1cf88.json').exists())

    def test_stale_restore_evidence_blocks_reconciliation(self):
        self.write(self.settings / 'restore-verified.json', {
            'backupPolicy': 'local-verified-v1',
            'verifiedAt': '2020-01-01T00:00:00+00:00',
        })
        self.assertFalse(self.run_diagnostic()['operator_reconciliation_candidate'])

    def set_failed_backup_journal(self):
        record = diagnostics.read_json(self.root / 'release-state.json')
        record.update(sha=diagnostics.RECOVERY_BACKUP_CANDIDATE,
                      candidate={'sha': diagnostics.RECOVERY_BACKUP_CANDIDATE},
                      status='uncertain', phase='backup', completed='preflight')
        self.write(self.root / 'release-state.json', record)
        activation = diagnostics.read_json(self.settings / 'activation.json')
        activation['backupPolicy'] = 'staging-no-backup-v1'
        self.write(self.settings / 'activation.json', activation)
        (self.settings / 'restore-verified.json').unlink(missing_ok=True)

    def test_no_backup_policy_allows_missing_restore_evidence(self):
        self.set_failed_backup_journal()
        report = self.run_diagnostic()
        self.assertTrue(report['checks']['recovery_policy_gate_satisfied'])
        self.assertTrue(report['checks']['automatic_backup_inactive'])
        self.assertTrue(report['operator_failed_backup_reconciliation_candidate'])

    def test_failed_backup_reconciliation_preserves_accepted_state(self):
        self.set_failed_backup_journal()
        original = (self.root / 'release-state.json').read_bytes()
        current = (self.root / 'current.json').read_bytes()
        high = (self.root / 'high-water.json').read_bytes()
        result = diagnostics.reconcile_failed_backup(self.root, self.settings, self.docker, self.now)
        self.assertEqual(result['status'], 'resolved')
        self.assertFalse(result['database_or_service_changes'])
        archive = self.root / ('release-state.before-' + diagnostics.RECOVERY_BACKUP_CANDIDATE[:8] + '.json')
        self.assertEqual(archive.read_bytes(), original)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(diagnostics.read_json(self.root / 'release-state.json')['outcome'],
                         'owner-verified-aborted-in-obsolete-backup-stage')
        self.assertEqual((self.root / 'current.json').read_bytes(), current)
        self.assertEqual((self.root / 'high-water.json').read_bytes(), high)
        with self.assertRaises(diagnostics.DiagnosticError):
            diagnostics.reconcile_failed_backup(self.root, self.settings, self.docker, self.now)

    def test_failed_backup_recovery_refuses_unreviewed_incidents_and_drift(self):
        def prepare():
            self.set_failed_backup_journal()
            return self.root / 'release-state.json'
        with self.subTest('wrong candidate'):
            path = prepare()
            record = diagnostics.read_json(path)
            record['sha'] = record['candidate']['sha'] = 'f' * 40
            self.write(path, record)
            with self.assertRaises(diagnostics.DiagnosticError):
                diagnostics.reconcile_failed_backup(self.root, self.settings, self.docker, self.now)
        with self.subTest('active backup timer'):
            prepare()
            self.docker.backup_active = True
            with self.assertRaises(diagnostics.DiagnosticError):
                diagnostics.reconcile_failed_backup(self.root, self.settings, self.docker, self.now)
            self.docker.backup_active = False
        with self.subTest('different volume'):
            prepare()
            self.mounts[0]['Source'] = '/new-secret'
            with self.assertRaises(diagnostics.DiagnosticError):
                diagnostics.reconcile_failed_backup(self.root, self.settings, self.docker, self.now)
            self.mounts[0]['Source'] = '/restricted'
        with self.subTest('orphan'):
            prepare()
            self.docker.orphan = True
            with self.assertRaises(diagnostics.DiagnosticError):
                diagnostics.reconcile_failed_backup(self.root, self.settings, self.docker, self.now)
        self.assertFalse(list(self.root.glob('release-state.before-*.json')))

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

if __name__ == '__main__':
    unittest.main()
