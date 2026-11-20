"""Staging-only read-only directory approval must never weaken release gates."""

import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts' / 'staging'))
import release  # noqa: E402

spec = importlib.util.spec_from_file_location(
    'activate_pasarguard_directory', REPO / 'scripts/staging/activate-pasarguard-directory.py',
)
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)

PROPOSED = (REPO / 'docker/staging/compose.yml').read_bytes()
PREVIOUS = PROPOSED.replace(activation.ENV_ADDITION, b'').replace(
    activation.SERVICE_REPLACEMENT, activation.SERVICE_ANCHOR,
).replace(activation.SECRET_ADDITION, b'')
KEY = 'pg_key_testonly0123456789'


class FakeCommands:
    def __init__(self):
        self.calls = []

    def github(self, path):
        self.calls.append(('github', path))
        if path == 'git/ref/heads/development':
            return {'object': {'sha': 'b' * 40}}
        return {'status': 'ahead', 'merge_base_commit': {'sha': 'a' * 40}}

    def run(self, args, capture=False):
        self.calls.append(('run', args))
        assert args[-2:] == ['config', '--quiet']
        return ''


class ComposeDeltaTests(unittest.TestCase):
    def test_only_exact_reviewed_delta_is_allowed(self):
        activation.check_compose(PREVIOUS, PROPOSED)
        with self.assertRaises(activation.ActivationError):
            activation.check_compose(PREVIOUS, PROPOSED.replace(b'read_only: true', b'read_only: false'))
        with self.assertRaises(activation.ActivationError):
            activation.check_compose(PREVIOUS, PROPOSED.replace(b'/run/secrets/pasarguard_api_key', b'/tmp/key'))
        with self.assertRaises(activation.ActivationError):
            activation.check_compose(PROPOSED, PROPOSED)

    def test_key_validation_never_normalizes_unexpected_input(self):
        self.assertEqual(activation.validate_key(KEY.encode()), KEY)
        for invalid in (b'', b'foo', b'pg_key_short', KEY.encode() + b'\n',
                        KEY.encode() + b'\x00', b'pg_key_' + b'x' * 510):
            with self.subTest(value=invalid[:20]):
                with self.assertRaises(activation.ActivationError):
                    activation.validate_key(invalid)

    def test_read_proof_calls_only_bounded_upstream_get(self):
        seen = []

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, size):
                self_test.assertEqual(size, 65_537)
                return b'{"admins":[{"id":9001,"username":"demo"}],"total":10}'

        class FakeOpener:
            def open(self, request, timeout):
                seen.append((request.full_url, request.get_method(), request.get_header('X-api-key'), timeout))
                return FakeResponse()

        self_test = self
        with mock.patch.object(activation.urllib.request, 'build_opener', return_value=FakeOpener()):
            activation.verify_read_only_directory(KEY)
        self.assertEqual(seen, [(activation.UPSTREAM + '?offset=0&limit=1', 'GET', KEY, 8)])

    def test_read_proof_rejects_unexpected_response_without_echoing_content(self):
        class FakeOpener:
            def open(self, request, timeout):
                class Response:
                    status = 200

                    def __enter__(self):
                        return self

                    def __exit__(self, *_):
                        return False

                    def read(self, size):
                        return b'{"admins":[{"id":"bad","username":"private"}],"total":1}'

                return Response()

        with mock.patch.object(activation.urllib.request, 'build_opener', return_value=FakeOpener()):
            with self.assertRaisesRegex(activation.ActivationError, '^STAGING_DIRECTORY_READ_PROOF_FAILED$'):
                activation.verify_read_only_directory(KEY)


class HostApprovalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'root'
        self.settings = Path(self.temp.name) / 'settings'
        self.root.mkdir()
        (self.settings / 'secrets').mkdir(parents=True)
        (self.settings / 'secrets').chmod(0o750)
        self.caddy = b'test fixture, untouched caddy\n'
        (self.root / 'compose.yml').write_bytes(PREVIOUS)
        (self.root / 'Caddyfile').write_bytes(self.caddy)
        self.previous = {
            'sha': 'a' * 40,
            'api': 'ghcr.io/h-zare-dev/fair-platform-owner-api@sha256:' + '0' * 64,
            'web': 'ghcr.io/h-zare-dev/fair-platform-web@sha256:' + '1' * 64,
            'caddy': 'ghcr.io/h-zare-dev/fair-platform-caddy@sha256:' + '2' * 64,
            'postgres': 'ghcr.io/h-zare-dev/fair-platform-postgres@sha256:' + '3' * 64,
            'schema': 'fp003b-v1', 'configHash': release.config_hash(self.root),
        }
        (self.root / 'current.json').write_text(json.dumps(self.previous))
        (self.root / 'current.env').write_text(
            'SECRETS_DIR=/etc/fair-staging/secrets\nAPI_IMAGE=' + self.previous['api']
            + '\nPOSTGRES_IMAGE=' + self.previous['postgres'] + '\n',
        )
        (self.settings / 'activation.json').write_text(json.dumps({
            'approval': 'owner-approved-v1', 'schema': 'fp003b-v1',
            'backupPolicy': 'staging-no-backup-v1',
            'secretsDir': '/etc/fair-staging/secrets',
        }))
        self.commands = FakeCommands()
        self.identity = {'id': 'f' * 64, 'image': 'sha256:test', 'mounts': []}

    def run_activation(self):
        with mock.patch.object(activation, 'verify_read_only_directory'), mock.patch.object(
            activation, 'database_identity', return_value=self.identity,
        ):
            return activation.activate(self.root, self.settings, PROPOSED, 'b' * 40, KEY, self.commands)

    def test_activation_requires_real_read_proof_then_mounts_key_only_on_api(self):
        self.assertEqual(
            self.run_activation(), 'STAGING_DIRECTORY_SECRET_AND_CONFIG_APPROVED_DEPLOY_REQUIRED',
        )
        secret = self.settings / 'secrets' / activation.KEY_NAME
        self.assertEqual(secret.read_text(), KEY)
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE(secret.parent.stat().st_mode), 0o700)
        self.assertEqual((self.root / 'compose.yml').read_bytes(), PROPOSED)
        self.assertEqual((self.root / 'Caddyfile').read_bytes(), self.caddy)
        next_manifest = json.loads((self.root / 'current.json').read_text())
        self.assertEqual(next_manifest, {**self.previous, 'configHash': release.config_hash(self.root)})
        self.assertEqual(len([call for call in self.commands.calls if call[0] == 'run']), 1)

    def test_unavailable_upstream_preserves_every_host_file(self):
        with mock.patch.object(activation, 'verify_read_only_directory', side_effect=activation.ActivationError(
            'STAGING_DIRECTORY_READ_PROOF_FAILED',
        )), mock.patch.object(activation, 'database_identity', return_value=self.identity):
            with self.assertRaises(activation.ActivationError):
                activation.activate(self.root, self.settings, PROPOSED, 'b' * 40, KEY, self.commands)
        self.assertEqual((self.root / 'compose.yml').read_bytes(), PREVIOUS)
        self.assertEqual(json.loads((self.root / 'current.json').read_text()), self.previous)
        self.assertFalse((self.settings / 'secrets' / activation.KEY_NAME).exists())

    def test_failed_compose_validation_rolls_back_secret_and_config(self):
        def reject_compose(args, capture=False):
            raise release.ReleaseError('COMMAND_FAILED')

        self.commands.run = reject_compose
        with mock.patch.object(activation, 'verify_read_only_directory'), mock.patch.object(
            activation, 'database_identity', return_value=self.identity,
        ):
            with self.assertRaises(release.ReleaseError):
                activation.activate(self.root, self.settings, PROPOSED, 'b' * 40, KEY, self.commands)
        self.assertEqual((self.root / 'compose.yml').read_bytes(), PREVIOUS)
        self.assertEqual(json.loads((self.root / 'current.json').read_text()), self.previous)
        self.assertFalse((self.settings / 'secrets' / activation.KEY_NAME).exists())
        self.assertEqual(stat.S_IMODE((self.settings / 'secrets').stat().st_mode), 0o750)


if __name__ == '__main__':
    unittest.main()
