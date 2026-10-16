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
import signal
import subprocess
import urllib.request
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
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Commands:
    def __init__(self, root):
        self.root = root
        self.timeout = 900

    def run(self, args, capture=False):
        # All diagnostics stay on the host. Never stream container/SQL/SSH errors to CI.
        process = subprocess.Popen(args, cwd=self.root, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        try:
            stdout, _ = process.communicate(timeout=self.timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt, ReleaseError) as error:
            # Kill/reap the whole local pipeline. Docker daemons are reconciled separately.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise ReleaseError('COMMAND_TIMEOUT' if isinstance(error, subprocess.TimeoutExpired)
                               else 'COMMAND_INTERRUPTED') from None
        if process.returncode:
            raise ReleaseError('COMMAND_INTERRUPTED' if process.returncode < 0 else 'COMMAND_FAILED')
        return stdout.decode() if capture else ''

    def github(self, path):
        request = urllib.request.Request(
            'https://api.github.com/repos/h-zare-dev/fair-platform/' + path,
            headers={'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'fair-staging-release'})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        except Exception:
            raise ReleaseError('RELEASE_ORDER_UNVERIFIED') from None

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


def freshness(commands, accepted, candidate):
    # TLS-authenticated GitHub evidence is fetched on host, never trusted from stdin.
    tip = commands.github('git/ref/heads/development')['object']['sha']
    if tip != candidate:
        raise ReleaseError('RELEASE_SUPERSEDED')
    if accepted != candidate:
        comparison = commands.github('compare/' + accepted + '...' + candidate)
        if (comparison.get('status') != 'ahead'
                or comparison.get('merge_base_commit', {}).get('sha') != accepted):
            raise ReleaseError('RELEASE_NOT_DESCENDANT')


def database_identity(commands, env, expected):
    identity = commands.compose(env, 'ps', '-q', 'postgres', capture=True).strip()
    if not re.fullmatch('[0-9a-f]{64}', identity):
        raise ReleaseError('ACCEPTED_DATABASE_NOT_RUNNING')
    info = json.loads(commands.run(['docker', 'inspect', identity], True))[0]
    if (info['Config']['Image'] != expected or not info['State']['Running']
            or info['State'].get('Health', {}).get('Status') != 'healthy'):
        raise ReleaseError('ACCEPTED_DATABASE_DRIFT')
    return {'id': identity, 'image': info['Image'], 'mounts': info['Mounts']}


def deploy(root, settings_dir, release, commands):
    # Called only while the host deployment lock is held (including all GitHub checks).
    release = manifest(release)
    activation = json.loads((settings_dir / 'activation.json').read_text())
    if activation.get('approval') != 'owner-approved-v1' or activation.get('schema') != SCHEMA:
        raise ReleaseError('STAGING_NOT_ACTIVATED')
    if release['configHash'] != config_hash(root):
        raise ReleaseError('CONFIG_REQUIRES_OPERATOR_UPGRADE')
    previous_path = root / 'current.json'
    if not previous_path.exists():
        raise ReleaseError('INITIAL_ACCEPTANCE_REQUIRED')
    previous = manifest(json.loads(previous_path.read_text()))
    state_path = root / 'release-state.json'
    if state_path.exists() and json.loads(state_path.read_text()).get('status') != 'resolved':
        raise ReleaseError('UNRESOLVED_RELEASE_OPERATOR_REQUIRED')
    # A high-water SHA survives app rollback. Bootstrap from the human-accepted manifest.
    high_path = root / 'high-water.json'
    high = json.loads(high_path.read_text())['sha'] if high_path.exists() else previous['sha']
    if not isinstance(high, str) or not re.fullmatch('[0-9a-f]{40}', high):
        raise ReleaseError('INVALID_HIGH_WATER')
    try:
        freshness(commands, high, release['sha'])
    except (KeyError, TypeError, ValueError):
        raise ReleaseError('RELEASE_ORDER_UNVERIFIED') from None
    if release == previous:
        database_identity(commands, root / 'current.env', previous['postgres'])
        return 'STAGING_RELEASE_ALREADY_ACCEPTED ' + release['sha']
    if release['sha'] == high or release['sha'] == previous['sha']:
        raise ReleaseError('RELEASE_REPLAY_OPERATOR_REQUIRED')
    if previous['schema'] != release['schema'] or previous['configHash'] != release['configHash']:
        raise ReleaseError('SCHEMA_COMPATIBILITY_UNPROVEN')
    if previous['postgres'] != release['postgres']:
        # Operator-reviewed exact transition; image changes never ride along implicitly.
        path = settings_dir / 'compatible-postgres.json'
        if not path.exists() or json.loads(path.read_text()) != {
                'from': previous['postgres'], 'to': release['postgres'], 'sha': release['sha'],
                'schema': SCHEMA}:
            raise ReleaseError('POSTGRES_TRANSITION_UNAPPROVED')
    evidence = json.loads((settings_dir / 'restore-verified.json').read_text())
    restored = datetime.datetime.fromisoformat(evidence['verifiedAt'])
    if restored.tzinfo is None or not 0 <= (datetime.datetime.now(datetime.timezone.utc)-restored).total_seconds() <= 30*86400:
        raise ReleaseError('RESTORE_EVIDENCE_REQUIRED')
    accepted_env = root / 'current.env'
    identity = database_identity(commands, accepted_env, previous['postgres'])
    # Fixed root-owned tooling names cannot be supplied by the SSH caller.
    names = ['fair-staging-release-preflight', 'fair-staging-release-migrate',
             'fair-staging-release-smoke', 'fair-staging-backup']
    for name in names:
        if commands.run(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$'], True).strip():
            raise ReleaseError('ORPHAN_OPERATION_OPERATOR_REQUIRED')
    env = write_env(root, release, activation)
    state = {'sha': release['sha'], 'candidate': release, 'previous': previous, 'database': identity}

    def phase(name, action):
        state.update(phase=name, status='in-progress')
        atomic(state_path, json.dumps(state))  # fsync BEFORE the external side effect
        try:
            result = action()
        except (ReleaseError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            state.update(status='uncertain', failure=(str(error) if isinstance(error, ReleaseError)
                                                    else 'COMMAND_INTERRUPTED_OR_TIMEOUT'))
            atomic(state_path, json.dumps(state))
            if name == 'backup':
                commands.run(['docker', 'rm', '-f', 'fair-staging-backup'])
                if commands.run(['docker', 'ps', '-aq', '--filter', 'name=^/fair-staging-backup$'], True).strip():
                    raise ReleaseError('BACKUP_ORPHAN_OPERATOR_REQUIRED')
            raise ReleaseError(name.upper().replace('-', '_') + '_FAILED_OPERATOR_REQUIRED') from None
        state.update(status='in-progress', completed=name)
        atomic(state_path, json.dumps(state))
        return result

    def resolved(outcome):
        state.update(status='resolved', outcome=outcome)
        atomic(state_path, json.dumps(state))

    def one_shot(service, name, *args, capture=False):
        try:
            return commands.compose(env, 'run', '--rm', '--no-deps', '--name', name,
                                    '-T', service, *args, capture=capture)
        except (ReleaseError, subprocess.TimeoutExpired, KeyboardInterrupt):
            # Killing docker CLI does not stop the container. Remove only our own operation.
            commands.run(['docker', 'rm', '-f', name])
            if commands.run(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$'], True).strip():
                raise ReleaseError('ORPHAN_OPERATION_OPERATOR_REQUIRED')
            raise

    phase('pull', lambda: commands.compose(env, 'pull', 'owner-api', 'web', 'migrate', 'caddy', 'postgres', 'backup'))
    for key in ['api', 'web', 'caddy', 'postgres']:
        image = release[key]
        labels = json.loads(commands.run(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', image], True))
        revision = labels.get('org.opencontainers.image.revision')
        retained_database = key == 'postgres' and release[key] == previous[key]
        if (not isinstance(revision, str) or not re.fullmatch('[0-9a-f]{40}', revision)
                or (not retained_database and revision != release['sha'])
                or labels.get('org.opencontainers.image.source') != 'https://github.com/h-zare-dev/fair-platform'):
            resolved('provenance-rejected')
            raise ReleaseError('IMAGE_PROVENANCE_MISMATCH')
    compatibility = json.loads(phase('preflight', lambda: one_shot('migrate', names[0], 'node', 'dist/owner/release-check.js', capture=True)))
    approved = json.loads((settings_dir / 'compatible-migrations.json').read_text())
    configured = compatibility.get('configuredMigrations')
    if (compatibility.get('schema') != SCHEMA or compatibility.get('hashes') != approved.get('hashes')
            or not isinstance(configured, list) or configured != approved.get('configuredMigrations')
            or any(name not in configured for name in compatibility.get('migrations', []))):
        resolved('compatibility-rejected')
        raise ReleaseError('MIGRATION_COMPATIBILITY_UNPROVEN')
    if database_identity(commands, accepted_env, previous['postgres']) != identity:
        raise ReleaseError('DATABASE_CHANGED_DURING_PREFLIGHT')
    phase('backup', lambda: commands.run([str(root / 'tooling' / 'backup-with-settings.sh')]))
    if database_identity(commands, accepted_env, previous['postgres']) != identity:
        raise ReleaseError('DATABASE_CHANGED_DURING_BACKUP')
    # Recheck branch advancement immediately before risky work. No workflow-order assumption.
    try:
        freshness(commands, high, release['sha'])
    except ReleaseError:
        resolved('superseded-before-change')
        raise
    atomic(high_path, json.dumps({'sha': release['sha']}))
    if previous['postgres'] != release['postgres']:
        phase('database-image', lambda: commands.compose(env, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'postgres'))
    database_after = phase('database-check', lambda: database_identity(commands, env, release['postgres']))
    if database_after['mounts'] != identity['mounts']:
        raise ReleaseError('DATABASE_VOLUME_CHANGED_OPERATOR_REQUIRED')
    state['databaseAfter'] = database_after
    atomic(state_path, json.dumps(state))
    phase('migration', lambda: one_shot('migrate', names[1]))
    if database_identity(commands, env, release['postgres']) != database_after:
        raise ReleaseError('DATABASE_CHANGED_DURING_MIGRATION_OPERATOR_REQUIRED')
    try:
        phase('startup', lambda: commands.compose(env, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'owner-api', 'web', 'caddy'))
        phase('health', lambda: commands.run([str(root / 'tooling' / 'health-monitor.sh')]))
        phase('smoke', lambda: one_shot('smoke', names[2]))
    except ReleaseError:
        # Successful approved migration + healthy expected DB prove app-only fallback scope.
        if phase('rollback-database-check', lambda: database_identity(commands, env, release['postgres'])) != database_after:
            raise ReleaseError('ROLLBACK_DATABASE_UNKNOWN_OPERATOR_REQUIRED')
        phase('rollback-stop', lambda: commands.compose(env, 'stop', '--timeout', '30', 'owner-api', 'web', 'caddy'))
        fallback = {**previous, 'postgres': release['postgres']}
        old_env = write_env(root, fallback, activation)
        phase('rollback-startup', lambda: commands.compose(old_env, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'owner-api', 'web', 'caddy'))
        phase('rollback-health', lambda: commands.run([str(root / 'tooling' / 'health-monitor.sh')]))
        phase('rollback-smoke', lambda: one_shot('smoke', names[2]))
        atomic(root / 'current.env', old_env.read_text())
        atomic(previous_path, json.dumps(fallback))
        resolved('app-rollback')
        raise ReleaseError('APP_FAILED_PREVIOUS_RELEASE_RESTORED') from None
    phase('commit', lambda: None)
    (root / 'releases').mkdir(exist_ok=True)
    atomic(root / 'releases' / (release['sha'] + '.json'), json.dumps(release))
    atomic(root / 'previous.json', json.dumps(previous))
    atomic(root / 'current.env', env.read_text())
    atomic(previous_path, json.dumps(release))
    resolved('accepted')
    return 'STAGING_RELEASE_OK ' + release['sha']


def locked_deploy(root, settings, candidate, commands):
    with (root / 'deployment.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError('DEPLOYMENT_BUSY') from None
        return deploy(root, settings, candidate, commands)


def main():
    os.umask(0o077)
    def interrupted(signum, frame):
        raise ReleaseError('COMMAND_INTERRUPTED')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    if len(sys.argv) != 1 or os.environ.get('SSH_ORIGINAL_COMMAND', '') not in ['', 'fair-staging-release']:
        raise ReleaseError('COMMAND_NOT_ALLOWED')
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096:
        raise ReleaseError('MANIFEST_TOO_LARGE')
    release = manifest(json.loads(raw))
    result = locked_deploy(ROOT, SETTINGS, release, Commands(ROOT))
    if result.startswith('STAGING_RELEASE_OK '):
        print('STAGING_SMOKE_OK')
    print(result)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        code = str(error) if isinstance(error, ReleaseError) else 'STAGING_RELEASE_FAILED'
        print(code, file=sys.stderr)
        subprocess.run(['logger', '-t', 'fair-staging-release', code], check=False)
        subprocess.run(['systemctl', 'start', 'fair-staging-alert@release.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        sys.exit(1)
