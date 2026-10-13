"""Disposable local-only backup/restore acceptance. Requires Docker, age and rclone.
The synthetic rclone remote is a temporary directory, never an off-host service.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='fp003b-backup-'))
project = 'fair-fp003b-backup-' + str(os.getpid())
env = {**os.environ, 'COMPOSE_PROJECT_NAME': project}


def run(args, code, input=None, check=True):
    result = subprocess.run(args, cwd=root, env=env, input=input, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if check and result.returncode:
        raise RuntimeError(code)
    return result


compose = ['docker', 'compose', '--env-file', 'current.env', '-f', 'compose.yml']
postgres_image = os.environ.get('UI_POSTGRES_IMAGE', 'fair-fp003b-postgres:test')
try:
    for name in ['compose.yml', 'Caddyfile']:
        shutil.copy(repo/'docker/staging'/name, root/name)
    secrets = root/'secrets'
    secrets.mkdir(mode=0o700)
    values = {
        'postgres_password': 'synthetic-admin-test-only',
        'admin_database_url': 'postgresql://fair_migrator:synthetic-admin-test-only@postgres:5432/fair_staging',
        'runtime_database_url': 'unused-synthetic',
        'seed_encryption_key': '11'*32,
        'backup_pgpass': 'postgres:5432:fair_staging:fair_backup:synthetic-backup-test-only\n',
    }
    for name, value in values.items():
        path = secrets/name
        path.write_text(value)
        path.chmod(0o600)
    settings = {
        'API_IMAGE': os.environ.get('UI_API_IMAGE', 'fair-fp003b-api:test'),
        'WEB_IMAGE': os.environ.get('UI_WEB_IMAGE', 'fair-fp003b-web:test'),
        'CADDY_IMAGE': os.environ.get('UI_CADDY_IMAGE', 'fair-fp003b-caddy:test'),
        'POSTGRES_IMAGE': postgres_image,
        'ACME_EMAIL': 'operator@example.invalid',
        'SECRETS_DIR': str(secrets),
    }
    (root/'current.env').write_text(''.join(f'{key}={value}\n' for key, value in settings.items()))
    run(['docker', 'run', '--rm', '-v', f'{secrets}:/secrets', '--entrypoint', 'sh', postgres_image,
         '-c', 'chown 70:70 /secrets/backup_pgpass && chown 1000:1000 /secrets/admin_database_url /secrets/runtime_database_url /secrets/seed_encryption_key'],
        'SECRET_OWNERSHIP')
    run(compose+['up', '-d', '--wait', 'postgres'], 'POSTGRES_START')
    run(compose+['run', '--rm', '-T', 'migrate'], 'MIGRATION')
    proof = json.loads(run(compose+['run', '--rm', '-T', 'migrate', 'node',
                                   'dist/owner/release-check.js'], 'RELEASE_PROOF').stdout)
    assert proof['schema'] == 'fp003b-v1'
    assert proof['configuredMigrations'] == ['OwnerDashboard1791000000000', 'PasarguardInbox1790000000000']
    assert set(proof['migrations']) == set(proof['configuredMigrations'])
    assert len(proof['hashes']) == 2 and all(len(h) == 64 for h in proof['hashes'].values())
    grants = (repo/'docker/staging/runtime-grants.sql').read_text()
    grants += "\nALTER ROLE fair_backup PASSWORD 'synthetic-backup-test-only';\n"
    run(compose+['exec', '-T', 'postgres', 'psql', '-U', 'fair_migrator', '-d', 'fair_staging',
                 '-v', 'ON_ERROR_STOP=1'], 'GRANTS', grants)
    run(compose+['run', '--rm', '-T', 'migrate', 'node', 'dist/owner/cli.js', 'seed'], 'SEED')
    # Generate a disposable unknown password entirely in process memory, never argv/env/logs.
    bootstrap = """
import {randomBytes} from 'node:crypto';
import {createOwnerDataSource} from './dist/owner/infrastructure/database.js';
import {PostgresOwnerAuth} from './dist/owner/infrastructure/auth-store.js';
import {passwords} from './dist/owner/infrastructure/password.js';
const db=createOwnerDataSource(process.env.DATABASE_URL);await db.initialize();
await new PostgresOwnerAuth(db).bootstrap(await passwords.hash(randomBytes(32).toString('base64url')));
await db.destroy();
"""
    run(compose+['run', '--rm', '-T', 'migrate', 'node', '--input-type=module', '-e', bootstrap],
        'SYNTHETIC_OWNER')
    identity = root/'identity'
    run(['age-keygen', '-o', str(identity)], 'AGE_KEY')
    recipient = run(['age-keygen', '-y', str(identity)], 'AGE_RECIPIENT').stdout.strip()
    remote = root/'synthetic-remote'
    remote.mkdir()
    stale = remote/'fair-staging-old.dump.age'
    stale.write_text('synthetic-expired')
    os.utime(stale, (time.time()-40*86400,)*2)
    unrelated = remote/'retain-unrelated.txt'
    unrelated.write_text('synthetic')
    os.utime(unrelated, (time.time()-40*86400,)*2)
    config = root/'rclone.conf'
    config.write_text('[synthetic]\ntype = local\n')
    config.chmod(0o600)
    env.update(STAGING_ROOT=str(root), BACKUP_RECIPIENT=recipient,
               BACKUP_REMOTE='synthetic:'+str(remote), RCLONE_CONFIG=str(config), BACKUP_RETENTION_DAYS='30')
    run(['bash', str(repo/'scripts/staging/backup.sh')], 'BACKUP')
    assert not stale.exists() and unrelated.exists()
    objects = list(remote.glob('fair-staging-*.dump.age'))
    assert len(objects) == 1
    assert not objects[0].read_bytes().startswith(b'PGDMP')
    evidence = root/'restore-verified.json'
    env['RESTORE_POSTGRES_IMAGE'] = run(
        ['docker', 'image', 'inspect', '--format', '{{.Id}}', postgres_image], 'RESTORE_IMAGE').stdout.strip()
    env.update(BACKUP_OBJECT='synthetic:'+str(objects[0]), BACKUP_IDENTITY_FILE=str(identity),
               RESTORE_EVIDENCE_FILE=str(evidence))
    run(['bash', str(repo/'scripts/staging/restore-verify.sh')], 'RESTORE')
    assert json.loads(evidence.read_text())['verifiedAt']
    evidence.unlink()
    bad = remote/'broken.dump.age'
    bad.write_text('synthetic-corruption')
    env['BACKUP_OBJECT'] = 'synthetic:'+str(bad)
    assert run(['bash', str(repo/'scripts/staging/restore-verify.sh')], 'CORRUPTION', check=False).returncode != 0
    assert not evidence.exists()
    print('SYNTHETIC_ENCRYPTED_BACKUP_RETENTION_RESTORE_AND_CORRUPTION_CHECKS_PASS')
finally:
    assert root.name.startswith('fp003b-backup-') and project.startswith('fair-fp003b-backup-')
    run(compose+['down', '--volumes'], 'DISPOSABLE_CLEANUP', check=False)
    # Only this test's generated directory is mounted for cleanup of container-owned fixtures.
    run(['docker', 'run', '--rm', '-v', f'{root}:/test', '--entrypoint', 'sh', postgres_image,
         '-c', 'rm -f /test/secrets/*'], 'TEST_SECRET_CLEANUP', check=False)
    shutil.rmtree(root, ignore_errors=True)
