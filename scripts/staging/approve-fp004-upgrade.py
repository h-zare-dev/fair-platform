#!/usr/bin/env python3
"""One-time, Owner-dispatched FP-004 Staging config/migration approval.

No database mutations, schema migrations, service restarts or image promotions.
The ordinary release path performs the actual migration and deployment afterward.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from release import Commands, atomic, config_hash, database_identity, manifest, same_database_identity


ROOT = Path('/opt/fair-staging')
SETTINGS = Path('/etc/fair-staging')
ADDITION = b'      FAIR_TIME_ZONE: ${FAIR_TIME_ZONE:-Asia/Tehran}\n'
ANCHOR = b'      OWNER_ORIGIN: https://panel.fairisfair.ir\n'
NEW_MIGRATION = 'AtomicCatalog1791300000000'
NEW_MIGRATION_FILE = 'dist/owner/infrastructure/catalog-migration.js'
GROUP_MIGRATION = 'OwnerSafeGroupDelete1791400000000'
GROUP_MIGRATION_FILE = 'dist/owner/infrastructure/group-delete-migration.js'
OPENING_MIGRATION = 'OpeningBaseline1791700000000'
OPENING_MIGRATION_FILE = 'dist/owner/infrastructure/opening-baseline-migration.js'
BASELINE_CONTROL_MIGRATION = 'OpeningBaselineControl1791800000000'
BASELINE_CONTROL_FILE = 'dist/owner/infrastructure/opening-baseline-control-migration.js'
REPLAY_JOURNAL_MIGRATION = 'ReplayShadowJournal1791900000000'
REPLAY_JOURNAL_FILE = 'dist/owner/infrastructure/replay-shadow-journal-migration.js'
REPLAY_AUDIT_MIGRATION = 'ReplayShadowAudit1792000000000'
REPLAY_AUDIT_FILE = 'dist/owner/infrastructure/replay-shadow-audit-migration.js'
PRIVATE_IDENTITY_MIGRATION = 'PrivateReplayIdentity1792100000000'
PRIVATE_IDENTITY_FILE = 'dist/owner/infrastructure/private-replay-identity-migration.js'
REPLAY_ARCHIVE_MIGRATION = 'ReplayArchive1792300000000'
REPLAY_ARCHIVE_FILE = 'dist/owner/infrastructure/replay-archive-migration.js'
SHADOW_CREDIT_ANCHOR = b"      FAIR_SHADOW_CLOSE_TIME: '02:10'\n"
SHADOW_CREDIT_ADDITION = b'      FAIR_SHADOW_DELETE_CREDIT_ENABLED: ${FAIR_SHADOW_DELETE_CREDIT_ENABLED:-false}\n'
REPORT_WEEK_ANCHOR = SHADOW_CREDIT_ADDITION
REPORT_WEEK_ADDITION = b'      FAIR_REPORT_WEEK_START_DAY: ${FAIR_REPORT_WEEK_START_DAY:-SATURDAY}\n'
IMAGE_RE = re.compile(r'ghcr\.io/h-zare-dev/fair-platform-owner-api@sha256:[0-9a-f]{64}')


class UpgradeError(Exception):
    pass


def check_compose(previous, proposed, mode='initial'):
    """Only the one exact reviewed environment mapping may be added."""
    if mode in ('group-delete', 'opening-baseline', 'private-identity', 'replay-archive'):
        if proposed != previous:
            raise UpgradeError('STAGING_CONFIG_CHANGE_NOT_APPROVED')
        return
    if mode == 'accounting-shadow':
        if previous.count(SHADOW_CREDIT_ADDITION) != 0 or previous.count(SHADOW_CREDIT_ANCHOR) != 1:
            raise UpgradeError('STAGING_CONFIG_CHANGE_NOT_APPROVED')
        if proposed != previous.replace(SHADOW_CREDIT_ANCHOR,
                                        SHADOW_CREDIT_ANCHOR + SHADOW_CREDIT_ADDITION, 1):
            raise UpgradeError('STAGING_CONFIG_CHANGE_NOT_APPROVED')
        return
    if mode == 'shadow-audit':
        if previous.count(REPORT_WEEK_ADDITION) != 0 or previous.count(REPORT_WEEK_ANCHOR) != 1:
            raise UpgradeError('STAGING_CONFIG_CHANGE_NOT_APPROVED')
        if proposed != previous.replace(REPORT_WEEK_ANCHOR,
                                        REPORT_WEEK_ANCHOR + REPORT_WEEK_ADDITION, 1):
            raise UpgradeError('STAGING_CONFIG_CHANGE_NOT_APPROVED')
        return
    if previous.count(ADDITION) != 0 or previous.count(ANCHOR) != 1:
        raise UpgradeError('STAGING_CONFIG_CHANGE_NOT_APPROVED')
    if proposed != previous.replace(ANCHOR, ANCHOR + ADDITION, 1):
        raise UpgradeError('STAGING_CONFIG_CHANGE_NOT_APPROVED')


def check_proofs(approved, old, new, mode='initial'):
    """Exact additive migration: preserve every previously accepted code hash."""
    additions = {
        'initial': [(NEW_MIGRATION, NEW_MIGRATION_FILE)],
        'group-delete': [(GROUP_MIGRATION, GROUP_MIGRATION_FILE)],
        'opening-baseline': [(OPENING_MIGRATION, OPENING_MIGRATION_FILE)],
        'accounting-shadow': [
            (BASELINE_CONTROL_MIGRATION, BASELINE_CONTROL_FILE),
            (REPLAY_JOURNAL_MIGRATION, REPLAY_JOURNAL_FILE),
        ],
        'shadow-audit': [(REPLAY_AUDIT_MIGRATION, REPLAY_AUDIT_FILE)],
        'private-identity': [(PRIVATE_IDENTITY_MIGRATION, PRIVATE_IDENTITY_FILE)],
        'replay-archive': [(REPLAY_ARCHIVE_MIGRATION, REPLAY_ARCHIVE_FILE)],
    }
    added = additions[mode]
    for proof in (old, new):
        if proof.get('schema') != 'fp003b-v1':
            raise UpgradeError('STAGING_MIGRATION_PROOF_INVALID')
        if not isinstance(proof.get('configuredMigrations'), list) or not isinstance(proof.get('hashes'), dict):
            raise UpgradeError('STAGING_MIGRATION_PROOF_INVALID')
        if not isinstance(proof.get('migrations'), list):
            raise UpgradeError('STAGING_MIGRATION_PROOF_INVALID')
        if not all(isinstance(x, str) for x in proof['migrations']):
            raise UpgradeError('STAGING_MIGRATION_PROOF_INVALID')
        if not all(isinstance(k, str) and re.fullmatch('[0-9a-f]{64}', v)
                   for k, v in proof['hashes'].items()):
            raise UpgradeError('STAGING_MIGRATION_PROOF_INVALID')
    if (old['configuredMigrations'] != approved.get('configuredMigrations')
            or old['hashes'] != approved.get('hashes')
            or any(name not in old['configuredMigrations'] for name in old['migrations'])):
        raise UpgradeError('STAGING_ACCEPTED_MIGRATIONS_DRIFT')
    if any(name in old['configuredMigrations'] or file in old['hashes'] for name, file in added):
        raise UpgradeError('STAGING_MIGRATION_ALREADY_APPROVED')
    if new['configuredMigrations'] != sorted(old['configuredMigrations'] + [name for name, _ in added]):
        raise UpgradeError('STAGING_UNEXPECTED_NEW_MIGRATIONS')
    if new['migrations'] != old['migrations']:
        raise UpgradeError('STAGING_DATABASE_CHANGED_DURING_REVIEW')
    if (set(new['hashes']) != set(old['hashes']) | {file for _, file in added}
            or any(new['hashes'].get(k) != v for k, v in old['hashes'].items())):
        raise UpgradeError('STAGING_PREVIOUS_MIGRATION_HASH_CHANGED')
    return {'configuredMigrations': new['configuredMigrations'], 'hashes': new['hashes']}


def proven_image(commands, sha):
    tag = 'ghcr.io/h-zare-dev/fair-platform-owner-api:' + sha
    commands.run(['docker', 'pull', tag])
    image = json.loads(commands.run(['docker', 'image', 'inspect', tag], capture=True))[0]
    labels = image['Config']['Labels']
    if (labels.get('org.opencontainers.image.revision') != sha
            or labels.get('org.opencontainers.image.source') != 'https://github.com/h-zare-dev/fair-platform'):
        raise UpgradeError('STAGING_CANDIDATE_IMAGE_PROVENANCE_FAILED')
    refs = [ref for ref in image.get('RepoDigests', []) if IMAGE_RE.fullmatch(ref)]
    if len(refs) != 1:
        raise UpgradeError('STAGING_CANDIDATE_DIGEST_UNVERIFIED')
    return refs[0]


def read_proof(commands, root, compose_path, env_path, name):
    output = commands.run([
        'docker', 'compose', '--env-file', str(env_path), '-f', str(compose_path),
        'run', '--rm', '--no-deps', '--name', name, '-T',
        'migrate', 'node', 'dist/owner/release-check.js',
    ], capture=True)
    return json.loads(output)


def review_and_approve(root, settings, proposed, sha, commands, mode='initial'):
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise UpgradeError('STAGING_OPERATOR_INVALID_SHA')
    if not (root / 'current.json').is_file() or not (root / 'current.env').is_file():
        raise UpgradeError('STAGING_ACCEPTED_RELEASE_MISSING')
    activation = json.loads((settings / 'activation.json').read_text())
    if (activation.get('approval') != 'owner-approved-v1'
            or activation.get('schema') != 'fp003b-v1'
            or activation.get('backupPolicy') != 'staging-no-backup-v1'):
        raise UpgradeError('STAGING_OPERATOR_POLICY_MISMATCH')
    accepted = manifest(json.loads((root / 'current.json').read_text()))
    if accepted['configHash'] != config_hash(root):
        raise UpgradeError('STAGING_ACCEPTED_CONFIG_DRIFT')
    journal = root / 'release-state.json'
    if journal.exists() and json.loads(journal.read_text()).get('status') != 'resolved':
        raise UpgradeError('STAGING_UNRESOLVED_RELEASE')
    if (root / 'high-water.json').exists():
        high = json.loads((root / 'high-water.json').read_text())['sha']
    else:
        high = accepted['sha']
    if commands.github('git/ref/heads/development')['object']['sha'] != sha:
        raise UpgradeError('STAGING_OPERATOR_NOT_LATEST_TIP')
    if high != sha:
        comparison = commands.github('compare/' + high + '...' + sha)
        if (comparison.get('status') != 'ahead'
                or comparison.get('merge_base_commit', {}).get('sha') != high):
            raise UpgradeError('STAGING_OPERATOR_NOT_DESCENDANT')
    check_compose((root / 'compose.yml').read_bytes(), proposed, mode)
    baseline = json.loads((settings / 'compatible-migrations.json').read_text())
    before = database_identity(commands, root / 'current.env', accepted['postgres'])

    # Candidate Compose must stay alongside its unchanged relative Caddyfile.
    # The same Compose project name keeps this read-only tool on the accepted DB network.
    with tempfile.TemporaryDirectory(prefix='.fp004-approval-', dir=root) as work:
        work = Path(work)
        candidate_compose = work / 'compose.yml'
        candidate_compose.write_bytes(proposed)
        (work / 'Caddyfile').write_bytes((root / 'Caddyfile').read_bytes())
        # Relative paths are resolved from the candidate file's directory; the
        # preflight uses only migrate, whose secret paths are absolute.
        candidate_image = proven_image(commands, sha)
        accepted_env = dict(line.split('=', 1) for line in (root / 'current.env').read_text().splitlines())
        if accepted_env.get('API_IMAGE') != accepted['api'] or accepted_env.get('POSTGRES_IMAGE') != accepted['postgres']:
            raise UpgradeError('STAGING_ACCEPTED_ENV_DRIFT')
        accepted_env['API_IMAGE'] = candidate_image
        candidate_env = work / 'candidate.env'
        candidate_env.write_text(''.join(k + '=' + v + '\n' for k, v in accepted_env.items()))
        candidate_env.chmod(0o600)
        commands.run(['docker', 'compose', '--env-file', str(candidate_env), '-f', str(candidate_compose), 'config', '--quiet'])
        old = read_proof(commands, root, root / 'compose.yml', root / 'current.env',
                         'fair-staging-operator-accepted-preflight')
        new = read_proof(commands, root, candidate_compose, candidate_env,
                         'fair-staging-operator-candidate-preflight')
        reviewed = check_proofs(baseline, old, new, mode)

    after = database_identity(commands, root / 'current.env', accepted['postgres'])
    if not same_database_identity(before, after):
        raise UpgradeError('STAGING_DATABASE_CHANGED_DURING_REVIEW')
    # Recheck immutable branch tip and files immediately before updating approval.
    if commands.github('git/ref/heads/development')['object']['sha'] != sha:
        raise UpgradeError('STAGING_OPERATOR_NOT_LATEST_TIP')
    if accepted['configHash'] != config_hash(root):
        raise UpgradeError('STAGING_ACCEPTED_CONFIG_DRIFT')
    check_compose((root / 'compose.yml').read_bytes(), proposed, mode)
    if baseline != json.loads((settings / 'compatible-migrations.json').read_text()):
        raise UpgradeError('STAGING_MIGRATION_APPROVAL_DRIFT')

    # No DB change; only root-owned Compose and exact approval metadata update.
    original_compose = (root / 'compose.yml').read_bytes()
    original_manifest = (root / 'current.json').read_text()
    original_compat = (settings / 'compatible-migrations.json').read_text()
    new_manifest = {**accepted, 'configHash': ''}
    try:
        if mode in ('initial', 'accounting-shadow', 'shadow-audit'):
            atomic(root / 'compose.yml', proposed.decode('utf-8'))
            new_manifest['configHash'] = config_hash(root)
            atomic(root / 'current.json', json.dumps(new_manifest))
        atomic(settings / 'compatible-migrations.json', json.dumps(reviewed))
    except Exception:
        # Keep the previously accepted config valid if any local write fails.
        atomic(root / 'compose.yml', original_compose.decode('utf-8'))
        atomic(root / 'current.json', original_manifest)
        atomic(settings / 'compatible-migrations.json', original_compat)
        raise
    return ({'group-delete': 'STAGING_GROUP_DELETE_MIGRATION_APPROVED',
             'opening-baseline': 'STAGING_OPENING_BASELINE_MIGRATION_APPROVED',
             'accounting-shadow': 'STAGING_ACCOUNTING_SHADOW_MIGRATIONS_APPROVED',
             'shadow-audit': 'STAGING_SHADOW_AUDIT_MIGRATION_APPROVED',
             'private-identity': 'STAGING_PRIVATE_IDENTITY_MIGRATION_APPROVED',
             'replay-archive': 'STAGING_REPLAY_ARCHIVE_MIGRATION_APPROVED'}
            .get(mode, 'STAGING_FP004_CONFIG_AND_MIGRATION_APPROVED'))


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3):
        raise UpgradeError('STAGING_OPERATOR_INVALID_INVOCATION')
    mode = sys.argv[2] if len(sys.argv) == 3 else 'initial'
    if mode not in ('initial', 'group-delete', 'opening-baseline', 'accounting-shadow',
                    'shadow-audit', 'private-identity', 'replay-archive'):
        raise UpgradeError('STAGING_OPERATOR_INVALID_INVOCATION')
    proposed = sys.stdin.buffer.read(30001)
    if len(proposed) > 30000:
        raise UpgradeError('STAGING_OPERATOR_COMPOSE_TOO_LARGE')
    with (ROOT / 'deployment.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UpgradeError('STAGING_DEPLOYMENT_BUSY') from None
        print(review_and_approve(ROOT, SETTINGS, proposed, sys.argv[1], Commands(ROOT), mode))


if __name__ == '__main__':
    try:
        main()
    except UpgradeError as error:
        # UpgradeError messages are fixed secret-free gate codes only.
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (Exception, KeyboardInterrupt):
        # Never echo Docker stderr, secrets, DB records or traceback to public CI.
        print('STAGING_FP004_OPERATOR_REVIEW_FAILED', file=sys.stderr)
        sys.exit(1)
