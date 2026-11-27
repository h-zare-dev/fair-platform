#!/usr/bin/env python3
"""Owner-only approval of the exact Staging read-only Admin Directory Compose delta.

The key arrives over pinned SSH stdin, not Git, process arguments or Compose env.
This approves host config and provisions a single secret; normal CI deploys the app.
No database migration, image promotion, service restart, or financial API call.
"""

import fcntl
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import urllib.parse
import urllib.request

from release import Commands, atomic, config_hash, database_identity, manifest, same_database_identity


ROOT = Path('/opt/fair-staging')
SETTINGS = Path('/etc/fair-staging')
UPSTREAM = 'https://pasar.fairinternet98.com/api/admins/simple'
KEY_NAME = 'pasarguard_api_key'

ENV_ANCHOR = b'      DATABASE_URL_FILE: /run/secrets/runtime_database_url\n'
ENV_ADDITION = (
    b'      PASARGUARD_BASE_URL: https://pasar.fairinternet98.com\n'
    b'      PASARGUARD_API_KEY_FILE: /run/secrets/pasarguard_api_key\n'
)
SERVICE_ANCHOR = b'    secrets: [runtime_database_url]\n'
SERVICE_REPLACEMENT = b'    secrets: [runtime_database_url, pasarguard_api_key]\n'
SECRET_ANCHOR = b'  runtime_database_url:\n    file: ${SECRETS_DIR:?}/runtime_database_url\n'
SECRET_ADDITION = b'  pasarguard_api_key:\n    file: ${SECRETS_DIR:?}/pasarguard_api_key\n'


class ActivationError(Exception):
    pass


def check_compose(previous: bytes, proposed: bytes):
    """The exact two env entries and one service-scoped secret, nothing else."""
    if (previous.count(ENV_ANCHOR) != 1 or previous.count(SERVICE_ANCHOR) != 1
            or previous.count(SECRET_ANCHOR) != 1 or ENV_ADDITION in previous
            or SECRET_ADDITION in previous or len(proposed) > 50_000):
        raise ActivationError('STAGING_DIRECTORY_CONFIG_DELTA_REJECTED')
    expected = previous.replace(ENV_ANCHOR, ENV_ANCHOR + ENV_ADDITION, 1)
    expected = expected.replace(SERVICE_ANCHOR, SERVICE_REPLACEMENT, 1)
    expected = expected.replace(SECRET_ANCHOR, SECRET_ANCHOR + SECRET_ADDITION, 1)
    if proposed != expected:
        raise ActivationError('STAGING_DIRECTORY_CONFIG_DELTA_REJECTED')


def validate_key(raw: bytes) -> str:
    try:
        key = raw.decode('ascii')
    except UnicodeDecodeError:
        raise ActivationError('STAGING_DIRECTORY_KEY_INVALID') from None
    if not re.fullmatch(r'pg_key_[A-Za-z0-9_-]{12,480}', key):
        raise ActivationError('STAGING_DIRECTORY_KEY_INVALID')
    return key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ActivationError('STAGING_DIRECTORY_READ_PROOF_FAILED')


def verify_read_only_directory(key: str):
    """One authenticated GET, no logged payloads or identity details."""
    url = UPSTREAM + '?' + urllib.parse.urlencode({'offset': 0, 'limit': 1})
    request = urllib.request.Request(url, headers={
        'X-Api-Key': key, 'Accept': 'application/json', 'User-Agent': 'fair-staging-directory-check',
    }, method='GET')
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect(),
    )
    try:
        with opener.open(request, timeout=8) as response:
            if response.status != 200:
                raise ActivationError('STAGING_DIRECTORY_READ_PROOF_FAILED')
            data = json.loads(response.read(65_537).decode('utf-8'))
        if (not isinstance(data, dict) or not isinstance(data.get('admins'), list)
                or len(data['admins']) != 1 or type(data.get('total')) is not int
                or data['total'] < 1 or len(json.dumps(data).encode('utf-8')) > 65_536):
            raise ActivationError('STAGING_DIRECTORY_READ_PROOF_FAILED')
        admin = data['admins'][0]
        if (not isinstance(admin, dict) or type(admin.get('id')) is not int
                or not 0 <= admin['id'] <= 9_007_199_254_740_991
                or not isinstance(admin.get('username'), str)
                or not 1 <= len(admin['username'].strip()) <= 100):
            raise ActivationError('STAGING_DIRECTORY_READ_PROOF_FAILED')
    except Exception:
        # Never expose secret-bearing URLs, HTTP headers or source details to CI.
        raise ActivationError('STAGING_DIRECTORY_READ_PROOF_FAILED') from None


def activate(root: Path, settings: Path, proposed: bytes, sha: str, key: str, commands: Commands):
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ActivationError('STAGING_DIRECTORY_INVALID_SHA')
    activation = json.loads((settings / 'activation.json').read_text())
    if (activation.get('approval') != 'owner-approved-v1'
            or activation.get('schema') != 'fp003b-v1'
            or activation.get('backupPolicy') != 'staging-no-backup-v1'
            or activation.get('secretsDir') != '/etc/fair-staging/secrets'):
        raise ActivationError('STAGING_DIRECTORY_POLICY_MISMATCH')
    accepted_path = root / 'current.json'
    previous = manifest(json.loads(accepted_path.read_text()))
    before_compose = (root / 'compose.yml').read_bytes()
    if previous['configHash'] != config_hash(root):
        raise ActivationError('STAGING_DIRECTORY_ACCEPTED_CONFIG_DRIFT')
    if (root / 'release-state.json').exists():
        if json.loads((root / 'release-state.json').read_text()).get('status') != 'resolved':
            raise ActivationError('STAGING_DIRECTORY_UNRESOLVED_RELEASE')
    high_path = root / 'high-water.json'
    high = json.loads(high_path.read_text())['sha'] if high_path.exists() else previous['sha']
    if not re.fullmatch('[0-9a-f]{40}', high):
        raise ActivationError('STAGING_DIRECTORY_INVALID_HIGH_WATER')
    if commands.github('git/ref/heads/development')['object']['sha'] != sha:
        raise ActivationError('STAGING_DIRECTORY_NOT_LATEST_TIP')
    if high != sha:
        comparison = commands.github('compare/' + high + '...' + sha)
        if (comparison.get('status') != 'ahead'
                or comparison.get('merge_base_commit', {}).get('sha') != high):
            raise ActivationError('STAGING_DIRECTORY_NOT_DESCENDANT')
    check_compose(before_compose, proposed)

    accepted_env = dict(line.split('=', 1) for line in (root / 'current.env').read_text().splitlines())
    if (accepted_env.get('SECRETS_DIR') != '/etc/fair-staging/secrets'
            or accepted_env.get('API_IMAGE') != previous['api']
            or accepted_env.get('POSTGRES_IMAGE') != previous['postgres']):
        raise ActivationError('STAGING_DIRECTORY_ACCEPTED_ENV_DRIFT')
    before_database = database_identity(commands, root / 'current.env', previous['postgres'])

    secret_dir = settings / 'secrets'
    if not secret_dir.is_dir() or secret_dir.is_symlink():
        raise ActivationError('STAGING_DIRECTORY_SECRET_DIR_INVALID')
    directory_info = secret_dir.stat()
    if directory_info.st_uid != os.geteuid() or (stat.S_IMODE(directory_info.st_mode) & 0o022):
        raise ActivationError('STAGING_DIRECTORY_SECRET_DIR_INSECURE')
    secret = secret_dir / KEY_NAME
    if secret.exists() or secret.is_symlink():
        raise ActivationError('STAGING_DIRECTORY_KEY_ALREADY_PROVISIONED')

    # Verify the actual permission and upstream endpoint before modifying the host.
    verify_read_only_directory(key)
    if commands.github('git/ref/heads/development')['object']['sha'] != sha:
        raise ActivationError('STAGING_DIRECTORY_NOT_LATEST_TIP')
    if config_hash(root) != previous['configHash'] or (root / 'compose.yml').read_bytes() != before_compose:
        raise ActivationError('STAGING_DIRECTORY_ACCEPTED_CONFIG_DRIFT')
    if not same_database_identity(before_database, database_identity(
            commands, root / 'current.env', previous['postgres'])):
        raise ActivationError('STAGING_DIRECTORY_DATABASE_DRIFT')

    original_manifest = accepted_path.read_text()
    original_directory_mode = stat.S_IMODE(secret_dir.stat().st_mode)
    changed_compose = False
    changed_manifest = False
    wrote_key = False
    try:
        # Docker Compose file-backed secrets are bind mounts. The node (non-root)
        # process needs file read access: 0444 in the container, protected on the
        # host by a root-only 0700 parent directory. Only owner-api mounts it.
        secret_dir.chmod(0o700)
        atomic(secret, key)
        wrote_key = True
        secret.chmod(0o444)
        atomic(root / 'compose.yml', proposed.decode('utf-8'))
        changed_compose = True
        commands.run(['docker', 'compose', '--env-file', str(root / 'current.env'),
                      '-f', str(root / 'compose.yml'), 'config', '--quiet'])
        atomic(accepted_path, json.dumps({**previous, 'configHash': config_hash(root)}))
        changed_manifest = True
        if not same_database_identity(before_database, database_identity(
                commands, root / 'current.env', previous['postgres'])):
            raise ActivationError('STAGING_DIRECTORY_DATABASE_DRIFT')
    except Exception:
        if changed_compose:
            atomic(root / 'compose.yml', before_compose.decode('utf-8'))
        if changed_manifest:
            atomic(accepted_path, original_manifest)
        if wrote_key:
            secret.unlink(missing_ok=True)
        secret_dir.chmod(original_directory_mode)
        raise
    return 'STAGING_DIRECTORY_SECRET_AND_CONFIG_APPROVED_DEPLOY_REQUIRED'


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise ActivationError('STAGING_DIRECTORY_INVALID_INVOCATION')
    proposed = Path(sys.argv[2]).read_bytes()
    raw_key = sys.stdin.buffer.read(513)
    key = validate_key(raw_key)
    with (ROOT / 'deployment.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ActivationError('STAGING_DEPLOYMENT_BUSY') from None
        print(activate(ROOT, SETTINGS, proposed, sys.argv[1], key, Commands(ROOT)))


if __name__ == '__main__':
    try:
        main()
    except ActivationError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    except (Exception, KeyboardInterrupt):
        print('STAGING_DIRECTORY_ACTIVATION_FAILED', file=sys.stderr)
        sys.exit(1)
