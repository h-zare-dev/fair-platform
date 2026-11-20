"""Owner-only FP-005 operator gate accepts exactly reviewed host deltas."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'approve_fp005_shadow', ROOT/'scripts/staging/approve-fp005-shadow.py',
)
import sys
sys.path.insert(0,str(ROOT/'scripts/staging'))
approval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(approval)

class ExactDeltas(unittest.TestCase):
    def test_only_new_receiver_secrets_and_nightly_mapping(self):
        proposed=(ROOT/'docker/staging/compose.yml').read_bytes()
        old=proposed.replace(
            b"      FAIR_SHADOW_ENABLED: 'true'\n      FAIR_SHADOW_CLOSE_TIME: '02:10'\n",b'',
        ).replace(
            b'      APP_ENCRYPTION_KEY_FILE: /run/secrets/seed_encryption_key\n'
            b'      PASARGUARD_WEBHOOK_SECRET_FILE: /run/secrets/shadow_webhook_secret\n',b'',
        ).replace(
            b'    secrets:\n      [\n        runtime_database_url,\n        pasarguard_api_key,\n'
            b'        seed_encryption_key,\n        shadow_webhook_secret,\n      ]\n',
            b'    secrets: [runtime_database_url, pasarguard_api_key]\n',
        ).replace(
            b'  shadow_webhook_secret:\n    file: ${SECRETS_DIR:?}/shadow_webhook_secret\n',b'',
        )
        self.assertEqual(approval.compose_delta(old),proposed)
        self.assertNotEqual(approval.compose_delta(
            old.replace(b'read_only: true',b'read_only: false'),
        ),proposed)

    def test_caddy_expands_only_the_authenticated_destination_limit(self):
        proposed=(ROOT/'docker/staging/Caddyfile').read_bytes()
        old=proposed.replace(
            b'\t@webhook path /api/v1/owner/webhook/pasarguard\n',
            b'\t@webhook path /api/v1/owner/webhook/pasarguard\n',
        )
        # Fixture reconstructs the previous reviewed Caddyfile by removing
        # the exact new handler and reinserting the old global 4 KiB bound.
        start=old.index(b'\t@webhook path')
        finish=old.index(b'\t@owner path',start)
        old=old[:start]+old[finish:]
        old=old.replace(b'\thandle @owner {\n\t\trequest_body {\n\t\t\tmax_size 4KB\n\t\t}\n',
            b'\thandle @owner {\n',1)
        old=old.replace(b'\thandle {\n\t\trequest_body {\n\t\t\tmax_size 4KB\n\t\t}\n',
            b'\thandle {\n',1)
        old=old.replace(b'\t@owner path',b'\trequest_body {\n\t\tmax_size 4KB\n\t}\n\t@owner path',1)
        self.assertEqual(approval.caddy_delta(old),proposed)
        self.assertNotEqual(approval.caddy_delta(
            old.replace(b'protocols h1 h2',b'protocols h3'),
        ),proposed)

    def test_migration_proof_preserves_existing_hashes(self):
        approved={'configuredMigrations':['A'],'hashes':{'old.js':'a'*64}}
        old={'schema':'fp003b-v1','migrations':['A'],**approved}
        new={'schema':'fp003b-v1','migrations':['A'],
             'configuredMigrations':['A',*sorted(approval.NEW_NAMES)],
             'hashes':{'old.js':'a'*64,**{path:'b'*64 for path in approval.NEW_FILES}}}
        self.assertEqual(approval.check_proof(approved,old,new)['hashes'],new['hashes'])
        with self.assertRaises(approval.ApprovalError):
            approval.check_proof(approved,old,{**new,'hashes':{**new['hashes'],'old.js':'c'*64}})

if __name__=='__main__':
    unittest.main()
