import importlib.util
import json
import subprocess
import threading
import time
from unittest.mock import patch
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
        self.tip = 'b'*40
        self.accepted_image = test.previous['postgres']
        self.ancestry = True
        self.db_identity = 'd'*64

    def run(self, args, capture=False):
        self.calls.append(args)
        if args[:2] == ['docker', 'inspect']:
            return json.dumps([{'Config': {'Image': self.accepted_image}, 'Image': 'sha256:'+'e'*64,
                                'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                                'Mounts': [{'Name': 'persistent-test-volume'}]}])
        if args[:2] == ['docker', 'ps']:
            return 'orphan' if self.failure == 'orphan' else ''
        if self.failure == 'health-timeout' and 'health-monitor.sh' in args[0] and not self.failed:
            self.failed = True
            raise subprocess.TimeoutExpired(args, 900)
        if args[0] == 'docker':
            return json.dumps({'org.opencontainers.image.revision': self.test.candidate['sha'], 'org.opencontainers.image.source': 'https://github.com/h-zare-dev/fair-platform'})
        return ''

    def github(self, path):
        if self.failure == 'github': raise release.ReleaseError('RELEASE_ORDER_UNVERIFIED')
        if path.startswith('git/ref'): return {'object': {'sha': self.tip}}
        return {'status': 'ahead' if self.ancestry else 'behind',
                'merge_base_commit': {'sha': path.split('/')[1].split('...')[0]}}

    def compose(self, env, *args, capture=False):
        self.calls.append(args)
        if args[0] == 'ps': return self.db_identity
        if args[0] == 'up' and 'postgres' in args:
            self.accepted_image = self.test.candidate['postgres']
        if self.failure == 'startup-timeout' and args[0] == 'up' and 'postgres' not in args and not self.failed:
            self.failed = True
            raise subprocess.TimeoutExpired(args, 900)
        if self.failure == 'migration-timeout' and args[-1] == 'migrate':
            raise subprocess.TimeoutExpired(args, 900)
        if self.failure == 'interrupt' and args[-1] == 'migrate':
            raise KeyboardInterrupt()
        if 'dist/owner/release-check.js' in args:
            return json.dumps({'schema': release.SCHEMA, 'configuredMigrations': ['approved', 'new-unreviewed'] if self.failure == 'pending-migration' else ['approved'], 'migrations':['approved'], 'hashes': {'approved': 'hash' if self.failure != 'compatibility' else 'changed'}})
        if self.failure == 'migration' and args[-1] == 'migrate' and args[0] == 'run':
            raise release.ReleaseError('COMMAND_FAILED')
        if self.failure in ['health', 'rollback'] and args[0] == 'up' and 'postgres' not in args:
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
        (self.settings/'activation.json').write_text(json.dumps({'approval': 'owner-approved-v1', 'schema':release.SCHEMA, 'acmeEmail':'operator@example.invalid','secretsDir':'/etc/fair-staging/secrets','backupPolicy':'staging-no-backup-v1'}))
        (self.settings/'compatible-migrations.json').write_text(json.dumps({'configuredMigrations':['approved'],'hashes':{'approved':'hash'}}))
        (self.settings/'compatible-postgres.json').write_text(json.dumps({'from':self.previous['postgres'], 'to':self.candidate['postgres'], 'sha':self.candidate['sha'], 'schema':release.SCHEMA}))

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

    def test_deployment_never_pulls_or_runs_backup_and_restore(self):
        self.assertIn('STAGING_RELEASE_OK', self.deploy())
        self.assertFalse(any('backup-with-settings' in str(call) or 'restore-verify' in str(call)
                             or (call[0] == 'pull' and 'backup' in call)
                             for call in self.commands.calls))

    def test_incompatible_migrations_stop_before_migration(self):
        with self.assertRaisesRegex(release.ReleaseError,'MIGRATION_COMPATIBILITY_UNPROVEN'): self.deploy('compatibility')
        self.assertFalse(any(c[0]=='up' for c in self.commands.calls))

    def test_unapproved_pending_migration_stops_even_when_prior_file_hashes_match(self):
        with self.assertRaisesRegex(release.ReleaseError,'MIGRATION_COMPATIBILITY_UNPROVEN'): self.deploy('pending-migration')
        self.assertFalse(any(c[0]=='up' for c in self.commands.calls))

    def test_failed_migration_does_not_rollback_or_launch_app(self):
        with self.assertRaisesRegex(release.ReleaseError,'MIGRATION_FAILED_OPERATOR_REQUIRED'): self.deploy('migration')
        self.assertFalse(any(c[0]=='up' and 'postgres' not in c for c in self.commands.calls))
        self.assertEqual(json.loads((self.root/'current.json').read_text()),self.previous)

    def test_failed_app_health_restores_prior_images_only(self):
        with self.assertRaisesRegex(release.ReleaseError,'APP_FAILED_PREVIOUS_RELEASE_RESTORED'): self.deploy('health')
        self.assertEqual(sum(c[0]=='up' and 'postgres' not in c for c in self.commands.calls),2)
        self.assertIn(self.previous['api'],(self.root/'candidate.env').read_text())
        self.assertIn(self.candidate['postgres'],(self.root/'current.env').read_text())
        self.assertEqual(json.loads((self.root/'current.json').read_text())['postgres'],self.candidate['postgres'])
        rollback=[c for c in self.commands.calls if c[0]=='up'][-1]
        self.assertIn('--no-deps',rollback)
        self.assertNotIn('postgres',rollback)

    def test_failed_rollback_reports_operator_required(self):
        with self.assertRaisesRegex(release.ReleaseError,'ROLLBACK_STARTUP_FAILED_OPERATOR_REQUIRED'): self.deploy('rollback')

    def test_config_change_requires_operator_upgrade(self):
        (self.root/'Caddyfile').write_text('different')
        with self.assertRaisesRegex(release.ReleaseError,'CONFIG_REQUIRES_OPERATOR_UPGRADE'): self.deploy()
        self.assertEqual(self.commands.calls,[])

    def test_absent_restore_evidence_does_not_block_disposable_staging(self):
        self.assertFalse((self.settings/'restore-verified.json').exists())
        self.assertIn('STAGING_RELEASE_OK', self.deploy())

    def test_legacy_backup_policy_requires_owner_transition(self):
        activation = json.loads((self.settings/'activation.json').read_text())
        activation['backupPolicy'] = 'local-verified-v1'
        (self.settings/'activation.json').write_text(json.dumps(activation))
        with self.assertRaisesRegex(release.ReleaseError, 'STAGING_NO_BACKUP_POLICY_REQUIRED'):
            self.deploy()
        self.assertEqual(self.commands.calls, [])

    def test_unknown_backup_policy_fails_closed(self):
        activation = json.loads((self.settings/'activation.json').read_text())
        activation['backupPolicy'] = 'unreviewed-offsite-bypass'
        (self.settings/'activation.json').write_text(json.dumps(activation))
        with self.assertRaisesRegex(release.ReleaseError, 'STAGING_NO_BACKUP_POLICY_REQUIRED'):
            self.deploy()
        self.assertEqual(self.commands.calls, [])

    def test_post_merge_staging_tooling_never_enables_backup_timer(self):
        scripts = Path(__file__).resolve().parents[2] / 'scripts/staging'
        activation = (scripts / 'activate-local-test-vps.sh').read_text()
        delivery = (scripts / 'ci-post-merge-local.sh').read_text()
        self.assertIn('systemctl disable --now fair-staging-backup.timer', activation)
        self.assertIn("'staging-no-backup-v1'", activation)
        self.assertNotIn('systemctl enable --now fair-staging-backup.timer', activation)
        self.assertNotIn('backup-with-settings.sh', delivery)
        self.assertNotIn('backup-local.sh', delivery)
        self.assertNotIn('restore-verify.sh', delivery)
        self.assertNotIn('backup.timer', delivery)
        self.assertNotIn('backup.service', delivery)
        self.assertIn('DATABASE_CHANGED_DURING_PREFLIGHT', delivery)
        self.assertIn('PREFLIGHT_FAILED_OPERATOR_REQUIRED', delivery)
        self.assertIn('RELEASE_ORDER_UNVERIFIED', delivery)

    def state(self):
        return json.loads((self.root/'release-state.json').read_text())

    def test_unapproved_image_change_stops_before_any_database_command(self):
        (self.settings/'compatible-postgres.json').unlink()
        with self.assertRaisesRegex(release.ReleaseError, 'POSTGRES_TRANSITION_UNAPPROVED'):
            self.deploy()
        self.assertEqual(self.commands.calls, [])

    def test_preflight_and_all_tools_suppress_dependency_convergence(self):
        self.deploy()
        tools = [c for c in self.commands.calls if c[0] == 'run']
        self.assertTrue(tools)
        self.assertTrue(all('--no-deps' in c for c in tools))
        db_up = next(i for i,c in enumerate(self.commands.calls) if c[0] == 'up' and 'postgres' in c)
        preflight = next(i for i,c in enumerate(self.commands.calls) if 'dist/owner/release-check.js' in c)
        self.assertLess(preflight, db_up)
        self.assertEqual(self.state()['outcome'], 'accepted')

    def test_mount_order_only_does_not_abort_a_real_release(self):
        commands = Commands(self)
        original = commands.run
        checks = [0]
        def inspect(args, capture=False):
            output = original(args, capture)
            if args[:2] == ['docker', 'inspect']:
                checks[0] += 1
                info = json.loads(output)
                mounts = [{'Type': 'volume', 'Source': '/volume', 'Destination': '/var/lib/postgresql/data', 'RW': True},
                          {'Type': 'bind', 'Source': '/secret', 'Destination': '/run/secrets', 'RW': False}]
                info[0]['Mounts'] = mounts if checks[0] % 2 else list(reversed(mounts))
                return json.dumps(info)
            return output
        commands.run = inspect
        self.assertIn('STAGING_RELEASE_OK', release.deploy(self.root, self.settings, self.candidate, commands))
        self.assertGreaterEqual(checks[0], 3)
        self.assertEqual(self.state()['outcome'], 'accepted')

    def test_mount_field_change_still_fails_closed_before_database_replacement(self):
        commands = Commands(self)
        original = commands.run
        checks = [0]
        def inspect(args, capture=False):
            output = original(args, capture)
            if args[:2] == ['docker', 'inspect']:
                checks[0] += 1
                info = json.loads(output)
                info[0]['Mounts'] = [{'Type': 'volume',
                                      'Source': '/original' if checks[0] == 1 else '/changed',
                                      'Destination': '/var/lib/postgresql/data', 'RW': True}]
                return json.dumps(info)
            return output
        commands.run = inspect
        with self.assertRaisesRegex(release.ReleaseError, 'DATABASE_CHANGED_DURING_PREFLIGHT'):
            release.deploy(self.root, self.settings, self.candidate, commands)
        self.assertEqual(self.state()['phase'], 'preflight')
        self.assertFalse(any(call[0] == 'up' for call in commands.calls))

    def test_rejected_compatibility_preserves_database(self):
        for failure in ['compatibility', 'pending-migration']:
            with self.subTest(failure=failure):
                with self.assertRaises(release.ReleaseError): self.deploy(failure)
                self.assertEqual(self.commands.accepted_image, self.previous['postgres'])
                self.assertFalse(any(c[0]=='up' for c in self.commands.calls))
                (self.root/'release-state.json').unlink()

    def test_timeouts_and_interruption_record_state_and_block_reentry(self):
        for failure, phase in [('migration-timeout','migration'), ('interrupt','migration')]:
            with self.subTest(failure=failure):
                with self.assertRaises(release.ReleaseError): self.deploy(failure)
                self.assertEqual(self.state()['phase'], phase)
                self.assertEqual(self.state()['status'], 'uncertain')
                self.assertEqual(json.loads((self.root/'current.json').read_text()), self.previous)
                with self.assertRaisesRegex(release.ReleaseError, 'UNRESOLVED_RELEASE'):
                    self.deploy()
                self.assertEqual(self.commands.calls, [])
                (self.root/'release-state.json').unlink()
                if (self.root/'high-water.json').exists(): (self.root/'high-water.json').unlink()

    def test_startup_and_health_timeouts_restore_app_with_durable_outcome(self):
        for failure in ['startup-timeout','health-timeout']:
            with self.subTest(failure=failure):
                with self.assertRaisesRegex(release.ReleaseError, 'APP_FAILED_PREVIOUS_RELEASE_RESTORED'):
                    self.deploy(failure)
                self.assertEqual(self.state()['outcome'], 'app-rollback')
                self.assertEqual(self.state()['status'], 'resolved')
                self.assertEqual(json.loads((self.root/'current.json').read_text())['sha'], self.previous['sha'])
                self.assertEqual(json.loads((self.root/'high-water.json').read_text())['sha'], self.candidate['sha'])
                (self.root/'release-state.json').unlink()
                (self.root/'high-water.json').unlink()
                (self.root/'current.json').write_text(json.dumps(self.previous))

    def test_orphan_blocks_before_side_effects(self):
        with self.assertRaisesRegex(release.ReleaseError, 'ORPHAN_OPERATION'):
            self.deploy('orphan')
        self.assertFalse((self.root/'release-state.json').exists())
        self.assertFalse(any(c[0]=='up' for c in self.commands.calls))

    def test_a_then_b_then_delayed_a_or_rerun_cannot_replace_b(self):
        self.deploy()  # fixture A is human-accepted; B succeeds
        commands = Commands(self)
        commands.tip = self.candidate['sha']
        for _ in range(2):
            with self.assertRaisesRegex(release.ReleaseError, 'RELEASE_SUPERSEDED'):
                release.deploy(self.root, self.settings, self.previous, commands)
            self.assertEqual(json.loads((self.root/'current.json').read_text()), self.candidate)
        commands.accepted_image = self.candidate['postgres']
        self.assertIn('ALREADY_ACCEPTED', release.deploy(self.root, self.settings, self.candidate, commands))
        self.assertFalse(any(c[0]=='up' for c in commands.calls))

    def test_full_two_release_success_then_delayed_workflow(self):
        release_a=self.manifest('a')
        release_b=self.manifest('b')
        self.previous=self.manifest('0')
        (self.root/'current.json').write_text(json.dumps(self.previous))
        for candidate in [release_a,release_b]:
            self.candidate=candidate
            (self.settings/'compatible-postgres.json').write_text(json.dumps({'from':self.previous['postgres'],'to':candidate['postgres'],'sha':candidate['sha'],'schema':release.SCHEMA}))
            commands=Commands(self)
            commands.tip=candidate['sha']
            self.assertIn('STAGING_RELEASE_OK',release.locked_deploy(self.root,self.settings,candidate,commands))
            self.previous=candidate
        commands=Commands(self)
        commands.tip=release_b['sha']
        with self.assertRaisesRegex(release.ReleaseError,'RELEASE_SUPERSEDED'):
            release.locked_deploy(self.root,self.settings,release_a,commands)
        self.assertEqual(json.loads((self.root/'current.json').read_text()),release_b)
        self.assertEqual(json.loads((self.root/'high-water.json').read_text())['sha'],release_b['sha'])

    def test_no_authoritative_order_evidence_no_deploy(self):
        with self.assertRaisesRegex(release.ReleaseError, 'RELEASE_ORDER_UNVERIFIED'): self.deploy('github')
        self.assertEqual(self.commands.calls, [])
        commands = Commands(self)
        commands.ancestry = False
        with self.assertRaisesRegex(release.ReleaseError, 'RELEASE_NOT_DESCENDANT'):
            release.deploy(self.root, self.settings, self.candidate, commands)
        self.assertEqual(commands.calls, [])

    def test_lock_covers_order_check_and_concurrent_candidates(self):
        entered, proceed = threading.Event(), threading.Event()
        errors = []
        commands = Commands(self)
        original = commands.github
        def github(path):
            if not entered.is_set():
                entered.set()
                proceed.wait(5)
            return original(path)
        commands.github = github
        def first():
            try: release.locked_deploy(self.root,self.settings,self.candidate,commands)
            except Exception as e: errors.append(e)
        thread = threading.Thread(target=first)
        thread.start()
        self.assertTrue(entered.wait(5))
        try:
            with self.assertRaisesRegex(release.ReleaseError,'DEPLOYMENT_BUSY'):
                release.locked_deploy(self.root,self.settings,self.previous,Commands(self))
        finally:
            proceed.set()
            thread.join(5)
        self.assertFalse(errors)
        self.assertEqual(json.loads((self.root/'current.json').read_text()),self.candidate)

    def test_branch_advancement_during_preflight_prevents_risky_work(self):
        commands = Commands(self)
        original = commands.compose
        def run(env,*args,capture=False):
            result = original(env,*args,capture=capture)
            if 'dist/owner/release-check.js' in args: commands.tip='c'*40
            return result
        commands.compose = run
        with self.assertRaisesRegex(release.ReleaseError,'RELEASE_SUPERSEDED'):
            release.deploy(self.root,self.settings,self.candidate,commands)
        self.assertFalse(any(c[0]=='up' for c in commands.calls))
        self.assertEqual(self.state()['outcome'],'superseded-before-change')

    def test_phase_is_durable_before_external_side_effect(self):
        commands = Commands(self)
        original = commands.compose
        def run(env,*args,capture=False):
            if 'dist/owner/release-check.js' in args:
                self.assertEqual(self.state()['phase'],'preflight')
                self.assertEqual(self.state()['status'],'in-progress')
            return original(env,*args,capture=capture)
        commands.compose=run
        release.deploy(self.root,self.settings,self.candidate,commands)

    def test_unknown_database_after_startup_blocks_rollback_and_next_release(self):
        commands=Commands(self,'health')
        original=commands.compose
        def compose(env,*args,capture=False):
            try: return original(env,*args,capture=capture)
            except release.ReleaseError:
                commands.db_identity='f'*64
                raise
        commands.compose=compose
        with self.assertRaisesRegex(release.ReleaseError,'ROLLBACK_DATABASE_UNKNOWN'):
            release.deploy(self.root,self.settings,self.candidate,commands)
        self.assertNotEqual(self.state()['status'],'resolved')
        with self.assertRaisesRegex(release.ReleaseError,'UNRESOLVED_RELEASE'): self.deploy()
        self.assertEqual(self.commands.calls,[])

    def test_real_process_timeout_is_normalized(self):
        commands=release.Commands(self.root)
        commands.timeout=0.05
        with self.assertRaisesRegex(release.ReleaseError,'COMMAND_TIMEOUT'):
            commands.run(['python3','-c','import time; time.sleep(30)'])

    def test_real_child_timeout_kills_and_reaps_process_group(self):
        with patch.object(release.subprocess, 'Popen') as popen:
            process = popen.return_value
            process.pid = 12345
            process.communicate.side_effect = [subprocess.TimeoutExpired('test',900), (b'',b'')]
            with patch.object(release.os, 'killpg') as kill:
                with self.assertRaisesRegex(release.ReleaseError, 'COMMAND_TIMEOUT'):
                    release.Commands(self.root).run(['synthetic'])
                kill.assert_called_once_with(12345, release.signal.SIGKILL)
                self.assertEqual(process.communicate.call_count, 2)

    def test_rejects_injection_mutable_tags_unknown_keys_and_schema(self):
        for key,value in [('api','ghcr.io/evil/api@sha256:'+'a'*64),('web','repo:latest'),('sha','$(id)'),('schema','unknown'),('extra','value')]:
            candidate={**self.candidate,key:value}
            with self.assertRaises(release.ReleaseError): release.manifest(candidate)

if __name__=='__main__': unittest.main()
