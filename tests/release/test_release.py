import datetime
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[2] / 'scripts/staging/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class Commands:
    def __init__(self, test, failure=None):
        self.test = test
        self.calls = []
        self.failure = failure
        self.failed = False

    def run(self, args, capture=False):
        self.calls.append(args)
        if args[0] == 'docker':
            return json.dumps({'org.opencontainers.image.revision': 'b'*40, 'org.opencontainers.image.source': 'https://github.com/h-zare-dev/fair-platform'})
        if self.failure == 'backup' and 'backup-with-settings.sh' in args[0]:
            raise release.ReleaseError('COMMAND_FAILED')
        return ''

    def compose(self, env, *args, capture=False):
        self.calls.append(args)
        if 'dist/owner/release-check.js' in args:
            return json.dumps({'schema': release.SCHEMA, 'hashes': {'approved': 'hash' if self.failure != 'compatibility' else 'changed'}})
        if self.failure == 'migration' and args == ('run', '--rm', '-T', 'migrate'):
            raise release.ReleaseError('COMMAND_FAILED')
        if self.failure in ['health', 'rollback'] and args[0] == 'up':
            if not self.failed or self.failure == 'rollback':
                self.failed = True
                raise release.ReleaseError('COMMAND_FAILED')
        return ''


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = self.root / 'settings'
        self.settings.mkdir()
        (self.root/'compose.yml').write_text('reviewed compose')
        (self.root/'Caddyfile').write_text('reviewed caddy')
        self.previous = self.manifest('a')
        self.candidate = self.manifest('b')
        (self.root/'current.json').write_text(json.dumps(self.previous))
        (self.root/'current.env').write_text('known-good')
        (self.settings/'activation.json').write_text(json.dumps({'approval': 'owner-approved-v1', 'schema':release.SCHEMA, 'acmeEmail':'operator@example.invalid','secretsDir':'/etc/fair-staging/secrets'}))
        (self.settings/'compatible-migrations.json').write_text(json.dumps({'hashes':{'approved':'hash'}}))
        (self.settings/'restore-verified.json').write_text(json.dumps({'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}))

    def manifest(self, sha):
        return {'sha':sha*40,'schema':release.SCHEMA,'configHash':release.config_hash(self.root),
                'api':'ghcr.io/h-zare-dev/fair-platform-owner-api@sha256:'+sha*64,
                'web':'ghcr.io/h-zare-dev/fair-platform-web@sha256:'+sha*64,
                'caddy':'ghcr.io/h-zare-dev/fair-platform-caddy@sha256:'+sha*64,
                'postgres':'ghcr.io/h-zare-dev/fair-platform-postgres@sha256:'+sha*64}

    def deploy(self, failure=None):
        self.commands = Commands(self, failure)
        return release.deploy(self.root,self.settings,self.candidate,self.commands)

    def test_success_preserves_previous_digests_and_commits_manifest_last(self):
        self.assertIn('STAGING_RELEASE_OK',self.deploy())
        self.assertEqual(json.loads((self.root/'previous.json').read_text()),self.previous)
        self.assertEqual(json.loads((self.root/'current.json').read_text()),self.candidate)
        self.assertTrue((self.root/'releases'/('b'*40+'.json')).exists())

    def test_activation_off_no_commands(self):
        (self.settings/'activation.json').write_text('{}')
        with self.assertRaisesRegex(release.ReleaseError,'STAGING_NOT_ACTIVATED'): self.deploy()
        self.assertEqual(self.commands.calls,[])

    def test_no_first_automatic_deployment(self):
        (self.root/'current.json').unlink()
        with self.assertRaisesRegex(release.ReleaseError,'INITIAL_ACCEPTANCE_REQUIRED'): self.deploy()
        self.assertEqual(self.commands.calls,[])

    def test_backup_failure_stops_before_migration(self):
        with self.assertRaisesRegex(release.ReleaseError,'COMMAND_FAILED'): self.deploy('backup')
        self.assertNotIn(('run','--rm','-T','migrate'),self.commands.calls)

    def test_incompatible_migrations_stop_before_backup(self):
        with self.assertRaisesRegex(release.ReleaseError,'MIGRATION_COMPATIBILITY_UNPROVEN'): self.deploy('compatibility')
        self.assertFalse(any('backup-with-settings.sh' in str(c) for c in self.commands.calls))

    def test_failed_migration_does_not_rollback_or_launch_app(self):
        with self.assertRaisesRegex(release.ReleaseError,'MIGRATION_FAILED_OPERATOR_REQUIRED'): self.deploy('migration')
        self.assertFalse(any(c[0]=='up' for c in self.commands.calls))
        self.assertEqual(json.loads((self.root/'current.json').read_text()),self.previous)

    def test_failed_app_health_restores_prior_images_only(self):
        with self.assertRaisesRegex(release.ReleaseError,'APP_FAILED_PREVIOUS_RELEASE_RESTORED'): self.deploy('health')
        self.assertEqual(sum(c[0]=='up' for c in self.commands.calls),2)
        self.assertIn(self.previous['api'],(self.root/'candidate.env').read_text())
        self.assertIn(self.candidate['postgres'],(self.root/'current.env').read_text())
        self.assertEqual(json.loads((self.root/'current.json').read_text())['postgres'],self.candidate['postgres'])
        rollback=[c for c in self.commands.calls if c[0]=='up'][-1]
        self.assertIn('--no-deps',rollback)
        self.assertNotIn('postgres',rollback)

    def test_failed_rollback_reports_operator_required(self):
        with self.assertRaisesRegex(release.ReleaseError,'ROLLBACK_FAILED_OPERATOR_REQUIRED'): self.deploy('rollback')

    def test_config_change_requires_operator_upgrade(self):
        (self.root/'Caddyfile').write_text('different')
        with self.assertRaisesRegex(release.ReleaseError,'CONFIG_REQUIRES_OPERATOR_UPGRADE'): self.deploy()
        self.assertEqual(self.commands.calls,[])

    def test_stale_restore_evidence_stops_before_pull(self):
        (self.settings/'restore-verified.json').write_text(json.dumps({'verifiedAt':'2020-01-01T00:00:00+00:00'}))
        with self.assertRaisesRegex(release.ReleaseError,'RESTORE_EVIDENCE_REQUIRED'): self.deploy()
        self.assertEqual(self.commands.calls,[])

    def test_rejects_injection_mutable_tags_unknown_keys_and_schema(self):
        for key,value in [('api','ghcr.io/evil/api@sha256:'+'a'*64),('web','repo:latest'),('sha','$(id)'),('schema','unknown'),('extra','value')]:
            candidate={**self.candidate,key:value}
            with self.assertRaises(release.ReleaseError): release.manifest(candidate)

if __name__=='__main__': unittest.main()
