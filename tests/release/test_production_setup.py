"""Production candidate is a separate, fail-closed deployment; no real host access."""

import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


def script_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts/production' / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


preflight = script_module('production_preflight', 'preflight.py')
provisioning = script_module('production_provisioning', 'provision-secrets.py')


class ProductionSetupTests(unittest.TestCase):
    def example(self, root: Path) -> Path:
        env = root / 'release.env'
        sha = 'a' * 40
        text = (ROOT / 'docker/production/release.env.example').read_text()
        text = text.replace('REPLACE_WITH_40_HEX_REVIEWED_DEVELOPMENT_COMMIT', sha)
        text = text.replace('REPLACE_WITH_64_HEX_DIGEST', 'b' * 64)
        text = text.replace('REPLACE_WITH_OWNER_EMAIL', 'owner@example.com')
        env.write_text(text)
        return env

    def test_pinned_release_accepts_only_exact_digest_and_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            env = self.example(Path(directory))
            self.assertEqual(preflight.validate(env)['RELEASE_SHA'], 'a' * 40)
            original = env.read_text()
            for modified in (
                original.replace('@sha256:' + 'b' * 64, ':latest', 1),
                original.replace('SECRETS_DIR=/etc/fair-production/secrets', 'SECRETS_DIR=/etc/fair-staging/secrets'),
                original.replace('RELEASE_SHA=' + 'a' * 40, 'RELEASE_SHA=unreviewed'),
                original + 'EXTRA_KEY=value\n',
                original + 'ACME_EMAIL=duplicate@example.com\n',
            ):
                env.write_text(modified)
                with self.assertRaises(ValueError):
                    preflight.validate(env)
            env.write_text(original)
            self.assertEqual(len(preflight.validate(env)), 9)

    def test_secrets_are_private_unique_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / 'settings'
            provisioning.provision(settings, os.geteuid(), os.geteuid())
            secret_dir = settings / 'secrets'
            self.assertEqual(secret_dir.stat().st_mode & 0o777, 0o700)
            for secret in secret_dir.iterdir():
                self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
            password = (secret_dir / 'postgres_password').read_text()
            self.assertRegex(password, r'^[0-9a-f]{64}$')
            self.assertIn('/fair_platform', (secret_dir / 'runtime_database_url').read_text())
            self.assertIn('fair_backup', (secret_dir / 'backup_pgpass').read_text())
            self.assertNotEqual(password, (settings / 'runtime_role_password').read_text())
            self.assertNotEqual(password, (settings / 'backup_role_password').read_text())
            with self.assertRaisesRegex(ValueError, 'ALREADY_EXIST'):
                provisioning.provision(settings, os.geteuid(), os.geteuid())
            self.assertEqual((secret_dir / 'postgres_password').read_text(), password)

    def test_compose_is_isolated_and_shadow_requires_second_file(self):
        base = (ROOT / 'docker/production/compose.yml').read_text()
        shadow = (ROOT / 'docker/production/compose.shadow.yml').read_text()
        directory = (ROOT / 'docker/production/compose.directory.yml').read_text()
        self.assertIn('name: fair-production', base)
        self.assertNotIn('fair_staging', base)
        self.assertIn("FAIR_SHADOW_ENABLED: 'false'", base)
        self.assertIn("FAIR_SHADOW_ENABLED: 'true'", shadow)
        self.assertNotIn('PASARGUARD_WEBHOOK_SECRET_FILE:', base)
        self.assertNotIn('pasarguard_api_key', base)
        self.assertIn('PASARGUARD_API_KEY_FILE: /run/secrets/pasarguard_api_key', directory)
        self.assertIn('${PASARGUARD_BASE_URL:?directory URL required}', directory)
        self.assertNotIn('FAIR_SHADOW_ENABLED:', directory)
        self.assertNotIn('PASARGUARD_WEBHOOK_SECRET_FILE:', directory)
        self.assertNotIn('APP_ENCRYPTION_KEY_FILE:', directory)
        self.assertIn('backend:\n    internal: true', base)
        self.assertIn('ports: [\'443:443/tcp\']', base)
        self.assertEqual(base.count('ports:'), 1)
        self.assertNotIn('docker.sock', base)
        self.assertNotIn('down -v', (ROOT / 'scripts/production/install.sh').read_text())
        grants = (ROOT / 'docker/production/runtime-grants.sql').read_text()
        for name in ('fair_platform', 'fair_replay_shadow_runs', 'fair_shadow_reviews',
                     'fair_opening_baseline_control', 'fair_atomic_packages',
                     'fair_replay_shadow_audit_prices'):
            self.assertIn(name, grants)

    def test_operator_scripts_have_valid_bash_syntax(self):
        for name in ('install.sh', 'backup.sh', 'resolve-release.sh', 'setup.sh', 'bootstrap.sh'):
            result = subprocess.run(['bash', '-n', str(ROOT / 'scripts/production' / name)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, f'{name}: {result.stderr}')

    def test_guided_installer_does_not_reinstall_existing_database(self):
        bootstrap = (ROOT / 'scripts/production/bootstrap.sh').read_text()
        setup = (ROOT / 'scripts/production/setup.sh').read_text()
        self.assertIn('git clone --depth=1 --filter=blob:none --sparse', bootstrap)
        self.assertIn('sparse-checkout set docker/production scripts/production', bootstrap)
        self.assertIn('[[ -f /etc/fair-production/installed ]]', bootstrap)
        self.assertIn('git -C "$repo" show "$sha:docker/production/compose.directory.yml"', bootstrap)
        self.assertIn('git ls-remote "$origin" refs/heads/development', bootstrap)
        self.assertIn('Hosts can intentionally retain only deployment files', bootstrap)
        self.assertIn('Existing base Compose differs from the installed pinned release', bootstrap)
        self.assertIn('[[ -f "$settings/installed" ]] && installed=true', setup)
        self.assertIn('Existing Fair Platform installation found.', setup)
        self.assertIn('FAIR_SHADOW_ENABLED=true', setup)
        self.assertIn('docker volume inspect fair-production_postgres_data', setup)
        self.assertIn('run --rm migrate node dist/owner/cli.js bootstrap', setup)
        self.assertIn('read -rs api_key', setup)
        self.assertIn('chown 1000:1000 "$key_tmp"', setup)
        self.assertIn('chmod 0600 "$key_tmp"', setup)
        self.assertIn('--force-recreate --wait owner-api', setup)
        self.assertNotIn('compose.shadow.yml', setup)
        for forbidden in ('down -v', 'docker volume rm', 'git reset --hard',
                          'docker compose pull', 'echo "$api_key"'):
            self.assertNotIn(forbidden, setup)


if __name__ == '__main__':
    unittest.main()
