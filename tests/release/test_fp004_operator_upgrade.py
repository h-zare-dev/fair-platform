import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts/staging'))
import release  # noqa: E402

spec = importlib.util.spec_from_file_location('fp004_upgrade', REPO / 'scripts/staging/approve-fp004-upgrade.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)

OLD = ['OwnerDashboard1791000000000', 'PricingEngine1791200000000']
OLD_HASHES = {'old-a.js': 'a' * 64, 'old-b.js': 'b' * 64}
NEW_HASHES = {**OLD_HASHES, upgrade.NEW_MIGRATION_FILE: 'c' * 64}


def report(names, hashes):
    return {
        'schema': 'fp003b-v1',
        'configuredMigrations': sorted(names),
        'migrations': ['OwnerDashboard1791000000000'],
        'hashes': hashes,
    }


class FakeCommands:
    def __init__(self, accepted, target_sha):
        self.accepted = accepted
        self.target_sha = target_sha
        self.calls = []
        self.old = report(OLD, OLD_HASHES)
        self.new = report(OLD + [upgrade.NEW_MIGRATION], NEW_HASHES)
        self.new_image = 'ghcr.io/h-zare-dev/fair-platform-owner-api@sha256:' + '4' * 64

    def github(self, path):
        if path == 'git/ref/heads/development':
            return {'object': {'sha': self.target_sha}}
        return {'status': 'ahead', 'merge_base_commit': {'sha': self.accepted['sha']}}

    def compose(self, env, *args, capture=False):
        self.calls.append(args)
        if args[0] == 'ps':
            return 'd' * 64
        raise AssertionError('unexpected compose command')

    def run(self, args, capture=False):
        self.calls.append(args)
        if args[:2] == ['docker', 'inspect']:
            return json.dumps([{'Config': {'Image': self.accepted['postgres']},
                                'Image': 'sha256:' + 'e' * 64,
                                'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                                'Mounts': [{'Name': 'accepted-pg-volume'}]}])
        if args[:3] == ['docker', 'image', 'inspect']:
            return json.dumps([{'Config': {'Labels': {
                'org.opencontainers.image.revision': self.target_sha,
                'org.opencontainers.image.source': 'https://github.com/h-zare-dev/fair-platform'}},
                'RepoDigests': [self.new_image]}])
        if 'dist/owner/release-check.js' in args:
            env = args[args.index('--env-file') + 1]
            return json.dumps(self.old if env.endswith('/current.env') else self.new)
        if args[:2] == ['docker', 'pull'] or 'config' in args:
            return ''
        raise AssertionError('unexpected command: ' + repr(args))


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / 'staging'
        self.root.mkdir()
        self.settings = Path(tmp.name) / 'settings'
        self.settings.mkdir()
        candidate = (REPO / 'docker/staging/compose.yml').read_bytes()
        self.old_compose = candidate.replace(upgrade.ADDITION, b'')
        self.proposed = candidate
        (self.root / 'compose.yml').write_bytes(self.old_compose)
        (self.root / 'Caddyfile').write_text('unchanged caddy')
        self.accepted = {
            'sha': 'a' * 40, 'schema': 'fp003b-v1', 'configHash': release.config_hash(self.root),
            'api': 'ghcr.io/h-zare-dev/fair-platform-owner-api@sha256:' + '1' * 64,
            'web': 'ghcr.io/h-zare-dev/fair-platform-web@sha256:' + '2' * 64,
            'caddy': 'ghcr.io/h-zare-dev/fair-platform-caddy@sha256:' + '3' * 64,
            'postgres': 'ghcr.io/h-zare-dev/fair-platform-postgres@sha256:' + '5' * 64,
        }
        (self.root / 'current.json').write_text(json.dumps(self.accepted))
        (self.root / 'current.env').write_text(
            f"API_IMAGE={self.accepted['api']}\nPOSTGRES_IMAGE={self.accepted['postgres']}\n"
            f"WEB_IMAGE={self.accepted['web']}\nCADDY_IMAGE={self.accepted['caddy']}\n"
            'SECRETS_DIR=/etc/fair-staging/secrets\nACME_EMAIL=example@example.invalid\n')
        (self.settings / 'activation.json').write_text(json.dumps({
            'approval': 'owner-approved-v1', 'schema': 'fp003b-v1',
            'backupPolicy': 'staging-no-backup-v1',
        }))
        (self.settings / 'compatible-migrations.json').write_text(json.dumps({
            'configuredMigrations': sorted(OLD), 'hashes': OLD_HASHES,
        }))
        self.target_sha = 'b' * 40
        self.commands = FakeCommands(self.accepted, self.target_sha)

    def approve(self):
        return upgrade.review_and_approve(self.root, self.settings, self.proposed,
                                          self.target_sha, self.commands)

    def test_only_exact_mapping_allowed(self):
        upgrade.check_compose(self.old_compose, self.proposed)
        for proposed in (self.old_compose, self.proposed + b'other: value\n',
                         self.proposed.replace(b'Asia/Tehran', b'Europe/Berlin'),
                         self.proposed + upgrade.ADDITION):
            with self.subTest(proposed=proposed[-80:]):
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.check_compose(self.old_compose, proposed)

    def test_accepts_only_one_new_migration_and_unchanged_old_hashes(self):
        approved = {'configuredMigrations': sorted(OLD), 'hashes': OLD_HASHES}
        self.assertEqual(upgrade.check_proofs(approved, report(OLD, OLD_HASHES),
                         report(OLD + [upgrade.NEW_MIGRATION], NEW_HASHES))['hashes'], NEW_HASHES)
        for names, hashes in [
            (OLD, NEW_HASHES),
            (OLD + [upgrade.NEW_MIGRATION, 'HiddenMigration1'], NEW_HASHES),
            (OLD + [upgrade.NEW_MIGRATION], {**NEW_HASHES, 'old-a.js': 'f' * 64}),
            (OLD + [upgrade.NEW_MIGRATION], {**NEW_HASHES, 'unknown.js': 'f' * 64}),
        ]:
            with self.subTest(names=names, hashes=hashes):
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.check_proofs(approved, report(OLD, OLD_HASHES), report(names, hashes))

    def test_approves_metadata_without_running_migration_or_restart(self):
        self.assertEqual(self.approve(), 'STAGING_FP004_CONFIG_AND_MIGRATION_APPROVED')
        updated = json.loads((self.root / 'current.json').read_text())
        self.assertEqual(updated['sha'], self.accepted['sha'])
        self.assertEqual(updated['api'], self.accepted['api'])
        self.assertEqual(updated['configHash'], release.config_hash(self.root))
        self.assertEqual((self.root / 'compose.yml').read_bytes(), self.proposed)
        self.assertEqual(json.loads((self.settings / 'compatible-migrations.json').read_text())['hashes'], NEW_HASHES)
        self.assertFalse(any('up' in call or 'migrate' in call for call in self.commands.calls
                             if call[:2] != ['docker', 'compose']))
        self.assertFalse(any(call[0] == 'up' for call in self.commands.calls))

    def test_rejects_changed_accepted_config_without_promotion(self):
        (self.root / 'Caddyfile').write_text('drift')
        with self.assertRaisesRegex(upgrade.UpgradeError, 'CONFIG_DRIFT'):
            self.approve()
        self.assertEqual((self.root / 'compose.yml').read_bytes(), self.old_compose)

    def test_rejects_extra_migration_without_promotion(self):
        self.commands.new['configuredMigrations'].append('UnreviewedMigration1')
        with self.assertRaisesRegex(upgrade.UpgradeError, 'UNEXPECTED_NEW_MIGRATIONS'):
            self.approve()
        self.assertEqual((self.root / 'compose.yml').read_bytes(), self.old_compose)

    def test_rejects_changed_old_file_hash_without_promotion(self):
        self.commands.new['hashes']['old-a.js'] = 'd' * 64
        with self.assertRaisesRegex(upgrade.UpgradeError, 'PREVIOUS_MIGRATION_HASH_CHANGED'):
            self.approve()
        self.assertEqual((self.root / 'compose.yml').read_bytes(), self.old_compose)

    def test_rejects_unresolved_release_without_docker_actions(self):
        (self.root / 'release-state.json').write_text(json.dumps({'status': 'uncertain'}))
        with self.assertRaisesRegex(upgrade.UpgradeError, 'UNRESOLVED_RELEASE'):
            self.approve()
        self.assertEqual(self.commands.calls, [])

    def test_approves_only_safe_group_delete_migration_without_config_change(self):
        (self.root / 'compose.yml').write_bytes(self.proposed)
        self.accepted['configHash'] = release.config_hash(self.root)
        (self.root / 'current.json').write_text(json.dumps(self.accepted))
        names = OLD + [upgrade.NEW_MIGRATION]
        hashes = NEW_HASHES
        (self.settings / 'compatible-migrations.json').write_text(json.dumps({
            'configuredMigrations': sorted(names), 'hashes': hashes,
        }))
        self.commands.old = report(names, hashes)
        new_hashes = {**hashes, upgrade.GROUP_MIGRATION_FILE: 'd' * 64}
        self.commands.new = report(names + [upgrade.GROUP_MIGRATION], new_hashes)
        result = upgrade.review_and_approve(self.root, self.settings, self.proposed,
                                            self.target_sha, self.commands, 'group-delete')
        self.assertEqual(result, 'STAGING_GROUP_DELETE_MIGRATION_APPROVED')
        self.assertEqual((self.root / 'compose.yml').read_bytes(), self.proposed)
        self.assertEqual(json.loads((self.root / 'current.json').read_text()), self.accepted)
        self.assertEqual(json.loads((self.settings / 'compatible-migrations.json').read_text())['hashes'], new_hashes)
        with self.assertRaisesRegex(upgrade.UpgradeError, 'CONFIG_CHANGE_NOT_APPROVED'):
            upgrade.check_compose(self.proposed, self.proposed + b'unsafe\n', 'group-delete')
        with self.assertRaisesRegex(upgrade.UpgradeError, 'PREVIOUS_MIGRATION_HASH_CHANGED'):
            upgrade.check_proofs({'configuredMigrations': sorted(names), 'hashes': hashes},
                                 report(names, hashes), report(names + [upgrade.GROUP_MIGRATION],
                                    {**new_hashes, upgrade.NEW_MIGRATION_FILE: 'f' * 64}), 'group-delete')

    def test_group_delete_workflow_is_owner_only_and_serialized(self):
        workflow = (REPO / '.github/workflows/staging-fp004-group-delete-approval.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertIn("github.actor == 'h-zare-dev'", workflow)
        self.assertIn('github.ref_protected', workflow)
        self.assertIn('group: fair-staging-deployment', workflow)
        self.assertIn('environment: staging-bootstrap', workflow)
        self.assertIn('APPROVE_FP004_GROUP_DELETE', workflow)
        self.assertIn('group-delete', workflow)

    def test_opening_baseline_approves_only_one_additive_migration(self):
        (self.root / 'compose.yml').write_bytes(self.proposed)
        self.accepted['configHash'] = release.config_hash(self.root)
        (self.root / 'current.json').write_text(json.dumps(self.accepted))
        names = OLD + [upgrade.NEW_MIGRATION, upgrade.GROUP_MIGRATION]
        hashes = {**NEW_HASHES, upgrade.GROUP_MIGRATION_FILE: 'd' * 64}
        (self.settings / 'compatible-migrations.json').write_text(json.dumps({
            'configuredMigrations': sorted(names), 'hashes': hashes,
        }))
        self.commands.old = report(names, hashes)
        updated = {**hashes, upgrade.OPENING_MIGRATION_FILE: 'e' * 64}
        self.commands.new = report(names + [upgrade.OPENING_MIGRATION], updated)
        result = upgrade.review_and_approve(self.root, self.settings, self.proposed,
                                            self.target_sha, self.commands, 'opening-baseline')
        self.assertEqual(result, 'STAGING_OPENING_BASELINE_MIGRATION_APPROVED')
        self.assertEqual((self.root / 'compose.yml').read_bytes(), self.proposed)
        self.assertEqual(json.loads((self.settings / 'compatible-migrations.json').read_text())['hashes'], updated)
        with self.assertRaisesRegex(upgrade.UpgradeError, 'CONFIG_CHANGE_NOT_APPROVED'):
            upgrade.check_compose(self.proposed, self.proposed + b'unsafe\n', 'opening-baseline')
        with self.assertRaisesRegex(upgrade.UpgradeError, 'PREVIOUS_MIGRATION_HASH_CHANGED'):
            upgrade.check_proofs({'configuredMigrations': sorted(names), 'hashes': hashes},
                                 report(names, hashes), report(names + [upgrade.OPENING_MIGRATION],
                                     {**updated, 'unexpected.js': 'a' * 64}), 'opening-baseline')

    def test_opening_baseline_workflow_requires_owner_protected_branch(self):
        workflow = (REPO / '.github/workflows/staging-fp006-opening-baseline-approval.yml').read_text()
        for required in ('workflow_dispatch:', "github.actor == 'h-zare-dev'",
                         'github.ref_protected', 'group: fair-staging-deployment',
                         'environment: staging-bootstrap', 'APPROVE_FP006_OPENING_BASELINE',
                         'opening-baseline'):
            self.assertIn(required, workflow)
        self.assertNotIn('pull_request:', workflow)

    def test_workflow_is_manual_owner_only_protected_and_serialized(self):
        workflow = (REPO / '.github/workflows/staging-fp004-operator-upgrade.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotIn('pull_request:', workflow)
        self.assertIn("github.actor == 'h-zare-dev'", workflow)
        self.assertIn('github.ref_protected', workflow)
        self.assertIn('group: fair-staging-deployment', workflow)
        self.assertIn('environment: staging-bootstrap', workflow)
        self.assertIn('APPROVE_FP004_STAGING_UPGRADE', workflow)
        self.assertIn('docker/staging/compose.yml', workflow)
        self.assertNotIn('STAGING_BOOTSTRAP_ROOT_PASSWORD: ${{ github.token }}', workflow)


if __name__ == '__main__':
    unittest.main()
