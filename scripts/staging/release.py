#!/usr/bin/env python3
"""Root-owned forced-command entrypoint. Only validated image manifests enter via stdin.
Install/config updates are human-controlled; never accept shell commands or Compose uploads.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path('/opt/fair-staging')
SETTINGS = Path('/etc/fair-staging')
SCHEMA = 'fp003b-v1'


class ReleaseError(Exception):
    pass


def manifest(value):
    if not isinstance(value, dict) or set(value) != {'sha', 'api', 'web', 'caddy', 'postgres', 'schema', 'configHash'}:
        raise ReleaseError('INVALID_MANIFEST')
    if value['schema'] != SCHEMA or not re.fullmatch('[0-9a-f]{40}', value['sha']):
        raise ReleaseError('INVALID_MANIFEST')
    for key, suffix in [('api', 'owner-api'), ('web', 'web'), ('caddy', 'caddy'), ('postgres', 'postgres')]:
        pattern = 'ghcr.io/h-zare-dev/fair-platform-' + suffix + '@sha256:[0-9a-f]{64}'
        if not isinstance(value[key], str) or not re.fullmatch(pattern, value[key]):
            raise ReleaseError('INVALID_IMAGE')
    if not re.fullmatch('[0-9a-f]{64}', value['configHash']):
        raise ReleaseError('INVALID_CONFIG')
    return value


def config_hash(root):
    digest = hashlib.sha256()
    for name in ['compose.yml', 'Caddyfile']:
        digest.update(name.encode() + b'\0' + (root / name).read_bytes())
    return digest.hexdigest()


def atomic(path, content):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Commands:
    def __init__(self, root):
        self.root = root

    def run(self, args, capture=False):
        # All diagnostics stay on the host. Never stream container/SQL/SSH errors to CI.
        result = subprocess.run(args, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=900, check=False)
        if result.returncode:
            raise ReleaseError('COMMAND_FAILED')
        return result.stdout.decode() if capture else ''

    def compose(self, env, *args, capture=False):
        return self.run(['docker', 'compose', '--env-file', str(env), '-f', 'compose.yml', *args], capture)


def write_env(root, release, settings):
    # Operator settings contain only non-secret names/paths; reject shell/env injection.
    acme = settings['acmeEmail']
    secret_dir = settings['secretsDir']
    if not re.fullmatch(r'[A-Za-z0-9_.+@-]+', acme) or not re.fullmatch(r'/[A-Za-z0-9_/-]+', secret_dir):
        raise ReleaseError('INVALID_SETTINGS')
    content = f"API_IMAGE={release['api']}\nWEB_IMAGE={release['web']}\nCADDY_IMAGE={release['caddy']}\nPOSTGRES_IMAGE={release['postgres']}\nACME_EMAIL={acme}\nSECRETS_DIR={secret_dir}\n"
    env = root / 'candidate.env'
    atomic(env, content)
    return env


def deploy(root, settings_dir, release, commands):
    release = manifest(release)
    activation = json.loads((settings_dir / 'activation.json').read_text())
    if activation.get('approval') != 'owner-approved-v1' or activation.get('schema') != SCHEMA:
        raise ReleaseError('STAGING_NOT_ACTIVATED')
    if release['configHash'] != config_hash(root):
        raise ReleaseError('CONFIG_REQUIRES_OPERATOR_UPGRADE')
    previous_path = root / 'current.json'
    if not previous_path.exists():
        # First installation and its acceptance are deliberately human-operated.
        raise ReleaseError('INITIAL_ACCEPTANCE_REQUIRED')
    previous = manifest(json.loads(previous_path.read_text()))
    if previous['schema'] != release['schema'] or previous['configHash'] != release['configHash']:
        raise ReleaseError('SCHEMA_COMPATIBILITY_UNPROVEN')
    evidence = json.loads((settings_dir / 'restore-verified.json').read_text())
    restored = datetime.datetime.fromisoformat(evidence['verifiedAt'])
    if restored.tzinfo is None or not 0 <= (datetime.datetime.now(datetime.timezone.utc)-restored).total_seconds() <= 30*86400:
        raise ReleaseError('RESTORE_EVIDENCE_REQUIRED')
    env = write_env(root, release, activation)
    commands.compose(env, 'config', '--quiet')
    commands.compose(env, 'pull', 'owner-api', 'web', 'migrate', 'caddy', 'postgres', 'backup')
    for image in [release[key] for key in ['api', 'web', 'caddy', 'postgres']]:
        labels = json.loads(commands.run(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', image], True))
        if labels.get('org.opencontainers.image.revision') != release['sha'] or labels.get('org.opencontainers.image.source') != 'https://github.com/h-zare-dev/fair-platform':
            raise ReleaseError('IMAGE_PROVENANCE_MISMATCH')
    compatibility = json.loads(commands.compose(env, 'run', '--rm', '-T', 'migrate', 'node', 'dist/owner/release-check.js', capture=True))
    approved = json.loads((settings_dir / 'compatible-migrations.json').read_text())
    if compatibility.get('schema') != SCHEMA or compatibility.get('hashes') != approved.get('hashes'):
        raise ReleaseError('MIGRATION_COMPATIBILITY_UNPROVEN')
    # Back up off-host before ALL migrations. Backup failure stops before database changes.
    commands.run([str(root / 'tooling' / 'backup-with-settings.sh')])
    try:
        commands.compose(env, 'run', '--rm', '-T', 'migrate')
    except ReleaseError:
        raise ReleaseError('MIGRATION_FAILED_OPERATOR_REQUIRED') from None
    try:
        commands.compose(env, 'up', '-d', '--wait', '--wait-timeout', '120', 'postgres', 'owner-api', 'web', 'caddy')
        commands.run([str(root / 'tooling' / 'health-monitor.sh')])
        commands.compose(env, 'run', '--rm', '-T', 'smoke')
    except ReleaseError:
        # Known migration hashes above prove the prior images remain schema compatible.
        # Never run a DOWN migration, restore a DB, remove a volume or prune here.
        fallback = {**previous, 'postgres': release['postgres']}
        old_env = write_env(root, fallback, activation)
        try:
            commands.compose(old_env, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'owner-api', 'web', 'caddy')
            commands.run([str(root / 'tooling' / 'health-monitor.sh')])
            commands.compose(old_env, 'run', '--rm', '-T', 'smoke')
        except ReleaseError:
            raise ReleaseError('ROLLBACK_FAILED_OPERATOR_REQUIRED') from None
        atomic(root / 'current.env', old_env.read_text())
        atomic(previous_path, json.dumps(fallback))
        raise ReleaseError('APP_FAILED_PREVIOUS_RELEASE_RESTORED') from None
    (root / 'releases').mkdir(exist_ok=True)
    atomic(root / 'releases' / (release['sha'] + '.json'), json.dumps(release))
    atomic(root / 'previous.json', json.dumps(previous))
    atomic(root / 'current.env', env.read_text())
    # current.json is the commit marker; old releases remain retained.
    atomic(previous_path, json.dumps(release))
    return 'STAGING_RELEASE_OK ' + release['sha']


def main():
    os.umask(0o077)
    if len(sys.argv) != 1 or os.environ.get('SSH_ORIGINAL_COMMAND', '') not in ['', 'fair-staging-release']:
        raise ReleaseError('COMMAND_NOT_ALLOWED')
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096:
        raise ReleaseError('MANIFEST_TOO_LARGE')
    release = manifest(json.loads(raw))
    with (ROOT / 'deployment.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError('DEPLOYMENT_BUSY') from None
        print(deploy(ROOT, SETTINGS, release, Commands(ROOT)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ReleaseError) else 'STAGING_RELEASE_FAILED'
        print(code, file=sys.stderr)
        subprocess.run(['logger', '-t', 'fair-staging-release', code], check=False)
        subprocess.run(['systemctl', 'start', 'fair-staging-alert@release.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        sys.exit(1)
