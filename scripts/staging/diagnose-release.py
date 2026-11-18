#!/usr/bin/env python3
"""Read-only, redacted staging release reconciliation evidence.

Run only through the Owner-gated, host-key-pinned GitHub Actions workflow.
The database check starts a disposable migration *inspection* container; it
only SELECTs the migration table and hashes code, never runs migrations.
"""

import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path('/opt/fair-staging')
SETTINGS = Path('/etc/fair-staging')
SERVICES = {
    'owner-api': 'api',
    'web': 'web',
    'caddy': 'caddy',
    'postgres': 'postgres',
}
OPERATIONS = (
    'fair-staging-release-preflight',
    'fair-staging-release-migrate',
    'fair-staging-release-smoke',
    'fair-staging-backup',
)


class DiagnosticError(Exception):
    pass


def read_json(path):
    if path.is_symlink():
        raise DiagnosticError('SYMLINK_REFUSED')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise DiagnosticError('INVALID_RECORD')
    return value


def safe_sha(value):
    return value if isinstance(value, str) and re.fullmatch('[0-9a-f]{40}', value) else 'INVALID'


def safe_state(value):
    return value if isinstance(value, str) and re.fullmatch('[a-z0-9-]{1,60}', value) else 'INVALID'


def same_mounts(recorded, actual):
    """Docker mount order is not a durable storage-identity property."""
    if not isinstance(recorded, list) or not isinstance(actual, list):
        return False
    if not all(isinstance(x, dict) for x in recorded + actual):
        return False
    return sorted(json.dumps(x, sort_keys=True) for x in recorded) == sorted(
        json.dumps(x, sort_keys=True) for x in actual
    )


def same_migrations(approved, actual):
    if not isinstance(actual, dict) or actual.get('schema') != 'fp003b-v1':
        return False
    configured = actual.get('configuredMigrations')
    applied = actual.get('migrations')
    required = approved.get('configuredMigrations')
    if not all(isinstance(x, list) for x in (configured, applied, required)):
        return False
    if not all(isinstance(name, str) for name in configured + applied + required):
        return False
    return (configured == required and actual.get('hashes') == approved.get('hashes')
            and len(applied) == len(required) and set(applied) == set(required)
            and len(set(applied)) == len(applied))


def evidence_fresh(activation, evidence, now=None):
    policy = activation.get('backupPolicy', 'offsite')
    if policy not in ('offsite', 'local-verified-v1'):
        return False
    if policy == 'local-verified-v1' and evidence.get('backupPolicy') != policy:
        return False
    try:
        when = dt.datetime.fromisoformat(evidence['verifiedAt'])
        now = now or dt.datetime.now(dt.timezone.utc)
        if when.tzinfo is None:
            return False
        age = now - when
        return dt.timedelta(0) <= age < dt.timedelta(days=30)
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


class Docker:
    def run(self, *args, timeout=30, cwd=None):
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                                check=False, timeout=timeout)
        if result.returncode:
            # Docker may write credentials/connection details on stderr. Never emit it.
            raise DiagnosticError('DOCKER_INSPECTION_FAILED')
        return result.stdout

    def inspect(self, name):
        rows = json.loads(self.run('docker', 'inspect', name))
        if len(rows) != 1:
            raise DiagnosticError('INVALID_DOCKER_INSPECT')
        return rows[0]

    def operations_absent(self):
        return all(not self.run('docker', 'ps', '-aq', '--filter', f'name=^/{name}$').strip()
                   for name in OPERATIONS)

    def release_check(self, root):
        # Exact command is read-only at SQL level (SELECT FROM migrations).
        # --rm removes its own transient Docker container on completion.
        raw = self.run('docker', 'compose', '--env-file', 'current.env', '-f', 'compose.yml',
                       'run', '--rm', '--no-deps', '-T', 'migrate',
                       'node', 'dist/owner/release-check.js', timeout=180, cwd=root)
        return json.loads(raw)


def diagnose(root, settings, docker, now=None):
    state = read_json(root / 'release-state.json')
    accepted = read_json(root / 'current.json')
    high = read_json(root / 'high-water.json')
    approval = read_json(settings / 'compatible-migrations.json')
    activation = read_json(settings / 'activation.json')
    restore = read_json(settings / 'restore-verified.json')

    checks = {}
    checks['accepted_schema'] = accepted.get('schema') == 'fp003b-v1'
    checks['activation_schema'] = activation.get('schema') == 'fp003b-v1'
    digest = hashlib.sha256()
    for name in ('compose.yml', 'Caddyfile'):
        digest.update(name.encode() + b'\0' + (root / name).read_bytes())
    checks['accepted_config_hash'] = digest.hexdigest() == accepted.get('configHash')
    checks['no_orphan_operations'] = docker.operations_absent()
    database = None
    for service, key in SERVICES.items():
        info = docker.inspect(f'fair-staging-{service}-1')
        checks[f'{key}_accepted_image'] = info['Config']['Image'] == accepted.get(key)
        checks[f'{key}_healthy'] = (info['State'].get('Running') is True and
                                    info['State'].get('Health', {}).get('Status') == 'healthy')
        if key == 'postgres':
            database = info

    recorded = state.get('database') or {}
    checks['postgres_preflight_id'] = database['Id'] == recorded.get('id')
    checks['postgres_preflight_image_id'] = database['Image'] == recorded.get('image')
    checks['postgres_preflight_mounts_unordered'] = same_mounts(
        recorded.get('mounts'), database.get('Mounts'))
    checks['restore_evidence_recent'] = evidence_fresh(activation, restore, now)

    # A failed query is reported as unavailable. It never prints Docker stderr.
    try:
        checks['database_migrations_match_approved'] = same_migrations(
            approval, docker.release_check(root))
    except (DiagnosticError, ValueError, subprocess.TimeoutExpired):
        checks['database_migrations_match_approved'] = False

    previous = state.get('previous') or {}
    journal = {
        'status': safe_state(state.get('status')),
        'phase': safe_state(state.get('phase')),
        'completed': safe_state(state.get('completed')),
        'candidate_sha': safe_sha(state.get('sha')),
        'accepted_sha': safe_sha(accepted.get('sha')),
        'high_water_sha': safe_sha(high.get('sha')),
    }
    # Only the operator can reconcile; this is a *candidate* status, not approval.
    early = (journal['status'] == 'in-progress' and journal['phase'] == 'preflight'
             and journal['completed'] == 'preflight'
             and safe_sha((state.get('candidate') or {}).get('sha')) == journal['candidate_sha']
             and safe_sha(previous.get('sha')) == journal['accepted_sha']
             and journal['high_water_sha'] == journal['accepted_sha']
             and journal['candidate_sha'] != journal['accepted_sha'])
    return {
        'journal': journal,
        'checks': checks,
        'operator_reconciliation_candidate': early and all(checks.values()),
        'persistent_changes_made': False,
    }


def main():
    if len(sys.argv) != 1:
        raise DiagnosticError('NO_ARGUMENTS_ALLOWED')
    os.umask(0o077)
    # The same lock is held from inspection through the migration SELECT.
    # Open read-only: the diagnostic cannot create/replace the lock file.
    fd = os.open(ROOT / 'deployment.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DiagnosticError('DEPLOYMENT_BUSY') from None
        result = diagnose(ROOT, SETTINGS, Docker())
    finally:
        os.close(fd)
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No unfiltered exception/traceback from the privileged host.
        print('STAGING_DIAGNOSTIC_UNAVAILABLE', file=sys.stderr)
        sys.exit(1)
