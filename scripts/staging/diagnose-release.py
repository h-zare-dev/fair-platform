#!/usr/bin/env python3
"""Redacted staging diagnostics and tightly gated one-time journal resolutions.

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
import tempfile


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
RECOVERY_CANDIDATE = '91177cf00a8a2a141fc98068469a4ed15b0fee81'
RECOVERY_ACCEPTED = '06715bb74698074e5b8d536c563d8a1a9e791602'
RECOVERY_BACKUP_CANDIDATE = '5f02f07f4445a6fe5dc7365dc7a01dc514267b7a'
RECOVERY_NOV19_PREFLIGHT_CANDIDATE = '74a1cf8882f45d0201ddadfc6474b276f62e0323'


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
    if policy == 'staging-no-backup-v1':
        return True  # Deliberate Owner policy; no restore evidence is required.
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


def accepted_env_matches(root, accepted):
    path = root / 'current.env'
    if path.is_symlink():
        return False
    variables = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            return False
        key, value = line.split('=', 1)
        if key in variables:
            return False
        variables[key] = value
    return all(variables.get(f'{label}_IMAGE') == accepted.get(key)
               for label, key in (('API', 'api'), ('WEB', 'web'),
                                  ('CADDY', 'caddy'), ('POSTGRES', 'postgres')))


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

    def backup_inactive(self):
        # A daily backup must not be running during journal resolution.
        for name in ('fair-staging-backup.timer', 'fair-staging-backup.service'):
            try:
                result = subprocess.run(['systemctl', 'is-active', name],
                                        capture_output=True, text=True, timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                return False
            if result.returncode not in (3, 4) or result.stdout.strip() not in ('inactive', 'unknown'):
                return False
        return True


def diagnose(root, settings, docker, now=None):
    state = read_json(root / 'release-state.json')
    accepted = read_json(root / 'current.json')
    high = read_json(root / 'high-water.json')
    approval = read_json(settings / 'compatible-migrations.json')
    activation = read_json(settings / 'activation.json')
    no_backup = activation.get('backupPolicy') == 'staging-no-backup-v1'
    restore = {} if no_backup else read_json(settings / 'restore-verified.json')

    checks = {}
    checks['accepted_schema'] = accepted.get('schema') == 'fp003b-v1'
    checks['activation_schema'] = activation.get('schema') == 'fp003b-v1'
    checks['activation_owner_approved'] = activation.get('approval') == 'owner-approved-v1'
    checks['backup_policy_approved'] = activation.get('backupPolicy') in ('local-verified-v1', 'staging-no-backup-v1')
    if no_backup:
        checks['automatic_backup_inactive'] = docker.backup_inactive()
    checks['accepted_env_images'] = accepted_env_matches(root, accepted)
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
    # For staging-no-backup-v1 this means explicit Owner policy, NOT a verified restore.
    checks['recovery_policy_gate_satisfied'] = evidence_fresh(activation, restore, now)

    # A failed query is reported as unavailable. It never prints Docker stderr.
    try:
        checks['database_migrations_match_approved'] = same_migrations(
            approval, docker.release_check(root))
    except (DiagnosticError, ValueError, subprocess.TimeoutExpired):
        checks['database_migrations_match_approved'] = False

    previous = state.get('previous') or {}
    checks['journal_previous_equals_accepted'] = previous == accepted
    journal = {
        'status': safe_state(state.get('status')),
        'phase': safe_state(state.get('phase')),
        'completed': safe_state(state.get('completed')),
        'candidate_sha': safe_sha(state.get('sha')),
        'accepted_sha': safe_sha(accepted.get('sha')),
        'high_water_sha': safe_sha(high.get('sha')),
        # Safe, phase-only metadata survives a successful app rollback; the
        # original underlying container/SQL errors remain host-private.
        'failed_app_phase': safe_state((state.get('appFailure') or {}).get('phase'))
        if state.get('outcome') == 'app-rollback' and isinstance(state.get('appFailure'), dict)
        else 'none',
    }
    # Only the operator can reconcile; this is a *candidate* status, not approval.
    early = (journal['status'] == 'in-progress' and journal['phase'] == 'preflight'
             and journal['completed'] == 'preflight'
             and safe_sha((state.get('candidate') or {}).get('sha')) == journal['candidate_sha']
             and safe_sha(previous.get('sha')) == journal['accepted_sha']
             and journal['high_water_sha'] == journal['accepted_sha']
             and journal['candidate_sha'] != journal['accepted_sha'])
    failed_backup = (
        no_backup and journal['status'] == 'uncertain' and journal['phase'] == 'backup'
        and journal['completed'] == 'preflight'
        and journal['candidate_sha'] == RECOVERY_BACKUP_CANDIDATE
        and safe_sha((state.get('candidate') or {}).get('sha')) == RECOVERY_BACKUP_CANDIDATE
        and journal['accepted_sha'] == RECOVERY_ACCEPTED
        and journal['high_water_sha'] == RECOVERY_ACCEPTED
        and safe_sha(previous.get('sha')) == RECOVERY_ACCEPTED
    )
    return {
        'journal': journal,
        'checks': checks,
        'operator_reconciliation_candidate': early and all(checks.values()),
        'operator_failed_backup_reconciliation_candidate': failed_backup and all(checks.values()),
        'persistent_changes_made': False,
    }


def reconcile_failed_backup(root, settings, docker, now=None):
    """Resolve only observed Nov 18 backup failure; no backup, DB or service writes.

    Caller MUST hold deployment.lock. Never retry the abandoned deployment.
    """
    report = diagnose(root, settings, docker, now)
    if not report['operator_failed_backup_reconciliation_candidate']:
        raise DiagnosticError('BACKUP_RECONCILIATION_REFUSED')
    path = root / 'release-state.json'
    if path.is_symlink():
        raise DiagnosticError('SYMLINK_REFUSED')
    original = path.read_bytes()
    state = json.loads(original)
    if (state.get('sha') != RECOVERY_BACKUP_CANDIDATE
            or state.get('status') != 'uncertain' or state.get('phase') != 'backup'
            or state.get('completed') != 'preflight'
            or (state.get('candidate') or {}).get('sha') != RECOVERY_BACKUP_CANDIDATE
            or state.get('previous') != read_json(root / 'current.json')
            or read_json(root / 'current.json').get('sha') != RECOVERY_ACCEPTED
            or read_json(root / 'high-water.json').get('sha') != RECOVERY_ACCEPTED):
        raise DiagnosticError('RECORD_CHANGED_DURING_RECONCILIATION')

    archive = root / ('release-state.before-' + RECOVERY_BACKUP_CANDIDATE[:8] + '.json')
    fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as file:
        file.write(original)
        file.flush()
        os.fsync(file.fileno())
    updated = dict(state)
    updated['status'] = 'resolved'
    updated['outcome'] = 'owner-verified-aborted-in-obsolete-backup-stage'
    updated['resolution'] = {
        'acceptedSha': RECOVERY_ACCEPTED,
        'candidateSha': RECOVERY_BACKUP_CANDIDATE,
        'verifiedAt': (now or dt.datetime.now(dt.timezone.utc)).isoformat(),
        'checks': {key: 'PASS' for key in report['checks']},
        'authorization': 'Owner-approved-staging-no-backup-reconciliation',
    }
    fd, temporary = tempfile.mkstemp(prefix='.failed-backup-reconcile-', dir=root)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(updated, file, sort_keys=True)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {
        'status': 'resolved', 'outcome': updated['outcome'],
        'reconciled_candidate_sha': RECOVERY_BACKUP_CANDIDATE,
        'retained_accepted_sha': RECOVERY_ACCEPTED,
        'original_journal_preserved': True, 'database_or_service_changes': False,
    }


def reconcile_preflight(root, settings, docker, now=None, *, candidate=RECOVERY_CANDIDATE):
    """Resolve one exactly enumerated, witnessed abandoned *preflight* journal.

    Caller MUST hold deployment.lock exclusively across this whole call.
    This function does not touch accepted manifests, containers or the DB.
    """
    if candidate not in (RECOVERY_CANDIDATE, RECOVERY_NOV19_PREFLIGHT_CANDIDATE):
        raise DiagnosticError('PREFLIGHT_RECONCILIATION_NOT_APPROVED')
    if (candidate == RECOVERY_NOV19_PREFLIGHT_CANDIDATE
            and read_json(settings / 'activation.json').get('backupPolicy') != 'staging-no-backup-v1'):
        raise DiagnosticError('NO_BACKUP_POLICY_REQUIRED')
    report = diagnose(root, settings, docker, now)
    journal = report['journal']
    if (not report['operator_reconciliation_candidate']
            or journal['candidate_sha'] != candidate
            or journal['accepted_sha'] != RECOVERY_ACCEPTED
            or journal['high_water_sha'] != RECOVERY_ACCEPTED):
        raise DiagnosticError('PREFLIGHT_RECONCILIATION_REFUSED')

    state_path = root / 'release-state.json'
    if state_path.is_symlink():
        raise DiagnosticError('SYMLINK_REFUSED')
    original = state_path.read_bytes()
    state = json.loads(original)
    # Guard against an uncoordinated change even though the lock is held.
    if (state.get('sha') != candidate
            or state.get('status') != 'in-progress'
            or state.get('phase') != 'preflight'
            or state.get('completed') != 'preflight'
            or (state.get('candidate') or {}).get('sha') != candidate
            or state.get('previous') != read_json(root / 'current.json')
            or read_json(root / 'current.json').get('sha') != RECOVERY_ACCEPTED
            or read_json(root / 'high-water.json').get('sha') != RECOVERY_ACCEPTED):
        raise DiagnosticError('RECORD_CHANGED_DURING_RECONCILIATION')

    # Preserve the exact old journal as immutable evidence, mode 0600.
    backup = root / ('release-state.before-' + candidate[:8] + '.json')
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as file:
        file.write(original)
        file.flush()
        os.fsync(file.fileno())

    updated = dict(state)
    updated['status'] = 'resolved'
    updated['outcome'] = 'owner-verified-aborted-after-preflight'
    updated['resolution'] = {
        'acceptedSha': RECOVERY_ACCEPTED,
        'candidateSha': candidate,
        'verifiedAt': (now or dt.datetime.now(dt.timezone.utc)).isoformat(),
        'checks': {key: 'PASS' for key in report['checks']},
        'authorization': 'Owner-approved-protected-staging-reconciliation',
    }
    fd, temporary = tempfile.mkstemp(prefix='.preflight-reconcile-', dir=root)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(updated, file, sort_keys=True)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, state_path)
        dirfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {
        'status': 'resolved',
        'outcome': updated['outcome'],
        'reconciled_candidate_sha': candidate,
        'retained_accepted_sha': RECOVERY_ACCEPTED,
        'original_journal_preserved': True,
        'database_or_service_changes': False,
    }


def main():
    if sys.argv[1:] not in ([], ['--reconcile-preflight'], ['--reconcile-failed-backup'],
                            ['--reconcile-nov19-preflight']):
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
        if sys.argv[1:] == ['--reconcile-preflight']:
            result = reconcile_preflight(ROOT, SETTINGS, Docker())
        elif sys.argv[1:] == ['--reconcile-nov19-preflight']:
            result = reconcile_preflight(ROOT, SETTINGS, Docker(),
                                         candidate=RECOVERY_NOV19_PREFLIGHT_CANDIDATE)
        elif sys.argv[1:] == ['--reconcile-failed-backup']:
            result = reconcile_failed_backup(ROOT, SETTINGS, Docker())
        else:
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
