"""Regression tests for exact additive password runtime grant approval."""
import importlib.util
from pathlib import Path
import sys
import unittest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts/staging'))
spec = importlib.util.spec_from_file_location(
    'approval', REPO / 'scripts/staging/approve-fp004-upgrade.py'
)
approval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(approval)


class PasswordRuntimeGrantApprovalTests(unittest.TestCase):
    def setUp(self):
        self.old_names = ['OwnerPasswordChange1792200000000', 'ReplayArchive1792300000000']
        self.old_hashes = {
            'dist/owner/infrastructure/password-change-migration.js': 'a' * 64,
            'dist/owner/infrastructure/replay-archive-migration.js': 'b' * 64,
        }
        self.new_names = sorted(self.old_names + [approval.PASSWORD_RUNTIME_GRANT_MIGRATION])
        self.new_hashes = {
            **self.old_hashes,
            approval.PASSWORD_RUNTIME_GRANT_FILE: 'c' * 64,
        }
        self.approved = {'configuredMigrations': sorted(self.old_names), 'hashes': self.old_hashes}

    def proof(self, names, hashes, applied=None):
        return {
            'schema': 'fp003b-v1',
            'configuredMigrations': sorted(names),
            'migrations': applied if applied is not None else list(self.old_names),
            'hashes': hashes,
        }

    def check(self, new_names=None, new_hashes=None, applied=None):
        return approval.check_proofs(
            self.approved,
            self.proof(self.old_names, self.old_hashes),
            self.proof(
                self.new_names if new_names is None else new_names,
                self.new_hashes if new_hashes is None else new_hashes,
                applied,
            ),
            'password-runtime-grant',
        )

    def test_accepts_only_new_column_grant_migration(self):
        self.assertEqual(self.check(), {
            'configuredMigrations': self.new_names,
            'hashes': self.new_hashes,
        })

    def test_denies_missing_or_extra_migrations(self):
        for names in (self.old_names, self.new_names + ['UnexpectedMigration1']):
            with self.subTest(names=names):
                with self.assertRaisesRegex(approval.UpgradeError, 'UNEXPECTED_NEW_MIGRATIONS'):
                    self.check(new_names=names)

    def test_denies_modified_old_hashes_and_unexpected_files(self):
        for hashes in (
            {**self.new_hashes, 'dist/owner/infrastructure/password-change-migration.js': 'd' * 64},
            {**self.new_hashes, 'unknown.js': 'e' * 64},
        ):
            with self.subTest(hashes=hashes):
                with self.assertRaisesRegex(approval.UpgradeError, 'PREVIOUS_MIGRATION_HASH_CHANGED'):
                    self.check(new_hashes=hashes)

    def test_denies_database_changes_during_review(self):
        with self.assertRaisesRegex(approval.UpgradeError, 'DATABASE_CHANGED_DURING_REVIEW'):
            self.check(applied=self.old_names + [approval.PASSWORD_RUNTIME_GRANT_MIGRATION])

    def test_denies_compose_changes(self):
        approval.check_compose(b'accepted compose', b'accepted compose', 'password-runtime-grant')
        with self.assertRaisesRegex(approval.UpgradeError, 'CONFIG_CHANGE_NOT_APPROVED'):
            approval.check_compose(b'accepted compose', b'changed compose', 'password-runtime-grant')


if __name__ == '__main__':
    unittest.main()
