#!/usr/bin/env python3
"""One-time Owner approval of exact FP-005 Staging-only ingress/config/schema.

Does not restart applications, run migrations, change the database image or
alter any upstream/legacy bot endpoint. A subsequent protected CI deploy does.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

from release import Commands, atomic, config_hash, database_identity, manifest, same_database_identity

ROOT = Path('/opt/fair-staging')
SETTINGS = Path('/etc/fair-staging')
NEW_NAMES = {'PasarguardBillingProjection1791500000000', 'FairShadowCreate1791600000000'}
NEW_FILES = {
    'node_modules/@fair-platform/pasarguard/dist/infrastructure/billing-projection-migration.js',
    'dist/owner/infrastructure/shadow-migration.js',
}
REGISTRY = 'ghcr.io/h-zare-dev/fair-platform-'

class ApprovalError(Exception):
    pass

def compose_delta(old: bytes) -> bytes:
    changes = [
        (b'      FAIR_TIME_ZONE: ${FAIR_TIME_ZONE:-Asia/Tehran}\n',
         b'      FAIR_TIME_ZONE: ${FAIR_TIME_ZONE:-Asia/Tehran}\n'
         b"      FAIR_SHADOW_ENABLED: 'true'\n"
         b"      FAIR_SHADOW_CLOSE_TIME: '02:10'\n"),
        (b'      DATABASE_URL_FILE: /run/secrets/runtime_database_url\n',
         b'      DATABASE_URL_FILE: /run/secrets/runtime_database_url\n'
         b'      APP_ENCRYPTION_KEY_FILE: /run/secrets/seed_encryption_key\n'
         b'      PASARGUARD_WEBHOOK_SECRET_FILE: /run/secrets/shadow_webhook_secret\n'),
        (b'    secrets: [runtime_database_url, pasarguard_api_key]\n',
         b'    secrets:\n      [\n        runtime_database_url,\n        pasarguard_api_key,\n'
         b'        seed_encryption_key,\n        shadow_webhook_secret,\n      ]\n'),
        (b'  pasarguard_api_key:\n    file: ${SECRETS_DIR:?}/pasarguard_api_key\n',
         b'  pasarguard_api_key:\n    file: ${SECRETS_DIR:?}/pasarguard_api_key\n'
         b'  shadow_webhook_secret:\n    file: ${SECRETS_DIR:?}/shadow_webhook_secret\n'),
    ]
    for anchor, replacement in changes:
        if old.count(anchor) != 1 or replacement in old:
            raise ApprovalError('STAGING_SHADOW_CONFIG_DELTA_REJECTED')
        old = old.replace(anchor, replacement, 1)
    return old

def caddy_delta(old: bytes) -> bytes:
    old_body = b'\trequest_body {\n\t\tmax_size 4KB\n\t}\n'
    owner = b'\t@owner path /api/v1/owner/* /health/live /health/ready\n'
    webhook = b'''\t@webhook path /api/v1/owner/webhook/pasarguard
\thandle @webhook {
\t\trequest_body {
\t\t\tmax_size 256KB
\t\t}
\t\treverse_proxy owner-api:3001 {
\t\t\theader_up -Forwarded
\t\t\theader_up -X-Forwarded-For
\t\t\theader_up -X-Forwarded-Host
\t\t\theader_up -X-Forwarded-Proto
\t\t\ttransport http {
\t\t\t\tdial_timeout 5s
\t\t\t\tresponse_header_timeout 10s
\t\t\t}
\t\t}
\t}
'''
    if old.count(old_body)!=1 or old.count(owner)!=1 or b'@webhook' in old:
        raise ApprovalError('STAGING_SHADOW_CADDY_DELTA_REJECTED')
    changed = old.replace(old_body,b'',1).replace(owner,webhook+owner,1)
    owner_handle = b'\thandle @owner {\n'
    generic_handle = b'\thandle {\n\t\treverse_proxy web:3000\n'
    if changed.count(owner_handle)!=1 or changed.count(generic_handle)!=1:
        raise ApprovalError('STAGING_SHADOW_CADDY_DELTA_REJECTED')
    return (changed.replace(owner_handle,
                owner_handle+b'\t\trequest_body {\n\t\t\tmax_size 4KB\n\t\t}\n',1)
            .replace(generic_handle,
                b'\thandle {\n\t\trequest_body {\n\t\t\tmax_size 4KB\n\t\t}\n\t\treverse_proxy web:3000\n',1))

def image(commands, sha, suffix):
    tag = REGISTRY + suffix + ':' + sha
    commands.run(['docker','pull',tag])
    record = json.loads(commands.run(['docker','image','inspect',tag],capture=True))[0]
    labels = record['Config']['Labels']
    if (labels.get('org.opencontainers.image.revision') != sha or
        labels.get('org.opencontainers.image.source') != 'https://github.com/h-zare-dev/fair-platform'):
        raise ApprovalError('STAGING_SHADOW_IMAGE_PROVENANCE_FAILED')
    candidate = [digest for digest in record.get('RepoDigests',[])
        if re.fullmatch(re.escape(REGISTRY+suffix)+r'@sha256:[0-9a-f]{64}',digest)]
    if len(candidate)!=1:
        raise ApprovalError('STAGING_SHADOW_DIGEST_UNVERIFIED')
    return candidate[0]

def read_proof(commands, compose, env, name):
    output = commands.run(['docker','compose','--env-file',str(env),'-f',str(compose),
        'run','--rm','--no-deps','--name',name,'-T','migrate',
        'node','dist/owner/release-check.js'],capture=True)
    return json.loads(output)

def check_proof(baseline, old, proposed):
    if old.get('schema')!='fp003b-v1' or proposed.get('schema')!='fp003b-v1':
        raise ApprovalError('STAGING_SHADOW_SCHEMA_UNVERIFIED')
    if (old.get('configuredMigrations')!=baseline.get('configuredMigrations') or
        old.get('hashes')!=baseline.get('hashes') or
        proposed.get('migrations')!=old.get('migrations')):
        raise ApprovalError('STAGING_SHADOW_SCHEMA_DRIFT')
    if set(proposed.get('configuredMigrations',[]))!=set(old['configuredMigrations'])|NEW_NAMES:
        raise ApprovalError('STAGING_SHADOW_MIGRATION_UNEXPECTED')
    hashes = proposed.get('hashes',{})
    if (set(hashes)!=set(old['hashes'])|NEW_FILES or
        any(hashes.get(name)!=digest for name,digest in old['hashes'].items()) or
        not all(re.fullmatch('[0-9a-f]{64}',hashes[name]) for name in NEW_FILES)):
        raise ApprovalError('STAGING_SHADOW_OLD_HASH_CHANGED')
    return {'configuredMigrations':proposed['configuredMigrations'],'hashes':hashes}

def approve(sha, proposed_compose, proposed_caddy, secret, commands):
    if not re.fullmatch('[0-9a-f]{40}',sha):
        raise ApprovalError('STAGING_SHADOW_BAD_SHA')
    accepted = manifest(json.loads((ROOT/'current.json').read_text()))
    activation = json.loads((SETTINGS/'activation.json').read_text())
    if (activation.get('backupPolicy')!='staging-no-backup-v1' or
        activation.get('approval')!='owner-approved-v1' or
        activation.get('schema')!='fp003b-v1' or
        accepted['configHash']!=config_hash(ROOT)):
        raise ApprovalError('STAGING_SHADOW_POLICY_OR_CONFIG_DRIFT')
    if ((ROOT/'release-state.json').exists() and
        json.loads((ROOT/'release-state.json').read_text()).get('status')!='resolved'):
        raise ApprovalError('STAGING_SHADOW_UNRESOLVED_RELEASE')
    tip = commands.github('git/ref/heads/development')['object']['sha']
    if tip!=sha:
        raise ApprovalError('STAGING_SHADOW_NOT_LATEST_TIP')
    high_file=ROOT/'high-water.json'
    high=json.loads(high_file.read_text())['sha'] if high_file.exists() else accepted['sha']
    if high!=sha:
        comparison=commands.github('compare/'+high+'...'+sha)
        if comparison.get('status')!='ahead' or comparison.get('merge_base_commit',{}).get('sha')!=high:
            raise ApprovalError('STAGING_SHADOW_NON_DESCENDANT')
    old_compose=(ROOT/'compose.yml').read_bytes()
    old_caddy=(ROOT/'Caddyfile').read_bytes()
    if compose_delta(old_compose)!=proposed_compose or caddy_delta(old_caddy)!=proposed_caddy:
        raise ApprovalError('STAGING_SHADOW_CONFIG_DELTA_REJECTED')
    old_db=database_identity(commands,ROOT/'current.env',accepted['postgres'])
    secret_dir=SETTINGS/'secrets'
    if (not secret_dir.is_dir() or secret_dir.is_symlink() or
        secret_dir.stat().st_uid!=os.geteuid() or
        stat.S_IMODE(secret_dir.stat().st_mode)&0o022):
        raise ApprovalError('STAGING_SHADOW_SECRET_DIRECTORY_INVALID')
    key_file=secret_dir/'shadow_webhook_secret'
    if key_file.exists() or key_file.is_symlink():
        raise ApprovalError('STAGING_SHADOW_SECRET_ALREADY_PRESENT')
    api_digest=image(commands,sha,'owner-api')
    postgres_digest=image(commands,sha,'postgres')
    # Provision a root-owned secret to validate the exact *candidate* Compose;
    # keep it only after all read-only checks and metadata writes pass.
    originals={
        ROOT/'compose.yml':old_compose.decode(),
        ROOT/'Caddyfile':old_caddy.decode(),
        ROOT/'current.json':(ROOT/'current.json').read_text(),
        SETTINGS/'compatible-migrations.json':(SETTINGS/'compatible-migrations.json').read_text(),
    }
    transition=SETTINGS/'compatible-postgres.json'
    old_transition=transition.read_text() if transition.exists() else None
    accepted_env=dict(line.split('=',1) for line in (ROOT/'current.env').read_text().splitlines())
    if accepted_env.get('API_IMAGE')!=accepted['api'] or accepted_env.get('POSTGRES_IMAGE')!=accepted['postgres']:
        raise ApprovalError('STAGING_SHADOW_ENV_DRIFT')
    baseline=json.loads(originals[SETTINGS/'compatible-migrations.json'])
    try:
        atomic(key_file,secret)
        key_file.chmod(0o444)
        with tempfile.TemporaryDirectory(prefix='.fp005-shadow-',dir=ROOT) as tmp:
            work=Path(tmp)
            (work/'compose.yml').write_bytes(proposed_compose)
            (work/'Caddyfile').write_bytes(proposed_caddy)
            candidate_env={**accepted_env,'API_IMAGE':api_digest,'POSTGRES_IMAGE':postgres_digest}
            env_path=work/'candidate.env'
            env_path.write_text(''.join(k+'='+v+'\n' for k,v in candidate_env.items()))
            env_path.chmod(0o600)
            commands.run(['docker','compose','--env-file',str(env_path),'-f',str(work/'compose.yml'),'config','--quiet'])
            old_proof=read_proof(commands,ROOT/'compose.yml',ROOT/'current.env',
                'fair-staging-fp005-old-proof')
            new_proof=read_proof(commands,work/'compose.yml',env_path,
                'fair-staging-fp005-new-proof')
            reviewed=check_proof(baseline,old_proof,new_proof)
        if not same_database_identity(old_db,database_identity(commands,ROOT/'current.env',accepted['postgres'])):
            raise ApprovalError('STAGING_SHADOW_DATABASE_DRIFT')
        if commands.github('git/ref/heads/development')['object']['sha']!=sha:
            raise ApprovalError('STAGING_SHADOW_TIP_CHANGED')
        if config_hash(ROOT)!=accepted['configHash']:
            raise ApprovalError('STAGING_SHADOW_CONFIG_CHANGED')
        atomic(ROOT/'compose.yml',proposed_compose.decode())
        atomic(ROOT/'Caddyfile',proposed_caddy.decode())
        atomic(ROOT/'current.json',json.dumps({**accepted,'configHash':config_hash(ROOT)}))
        atomic(SETTINGS/'compatible-migrations.json',json.dumps(reviewed))
        atomic(transition,json.dumps({'from':accepted['postgres'],'to':postgres_digest,
            'sha':sha,'schema':'fp003b-v1'}))
    except Exception:
        for path,content in originals.items():
            atomic(path,content)
        if old_transition is None:
            transition.unlink(missing_ok=True)
        else:
            atomic(transition,old_transition)
        key_file.unlink(missing_ok=True)
        raise
    return 'STAGING_FP005_SHADOW_OPERATOR_APPROVED_REDEPLOY_REQUIRED'

def main():
    os.umask(0o077)
    if os.geteuid()!=0 or len(sys.argv)!=4:
        raise ApprovalError('STAGING_SHADOW_BAD_INVOCATION')
    sha=sys.argv[1]
    proposed_compose=Path(sys.argv[2]).read_bytes()
    proposed_caddy=Path(sys.argv[3]).read_bytes()
    if len(proposed_compose)>50000 or len(proposed_caddy)>20000:
        raise ApprovalError('STAGING_SHADOW_CONFIG_TOO_LARGE')
    raw=sys.stdin.buffer.read(513)
    try:
        secret=raw.decode('ascii')
    except UnicodeDecodeError:
        raise ApprovalError('STAGING_SHADOW_INVALID_SECRET') from None
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}',secret):
        raise ApprovalError('STAGING_SHADOW_INVALID_SECRET')
    with (ROOT/'deployment.lock').open('a') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            raise ApprovalError('STAGING_DEPLOYMENT_BUSY') from None
        print(approve(sha,proposed_compose,proposed_caddy,secret,Commands(ROOT)))

if __name__=='__main__':
    try:
        main()
    except ApprovalError as err:
        print(str(err),file=sys.stderr)
        sys.exit(1)
    except (Exception,KeyboardInterrupt):
        print('STAGING_FP005_OPERATOR_APPROVAL_FAILED',file=sys.stderr)
        sys.exit(1)
