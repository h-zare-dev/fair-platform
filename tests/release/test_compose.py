"""Real PostgreSQL 17 / Compose safety checks; opt in explicitly, never mock Docker.
Run: FAIR_RELEASE_DOCKER_TEST=1 python3 -m unittest discover -s tests/release -p test_compose.py
"""
import json
import os
from pathlib import Path
import subprocess
import unittest
from test_release import ReleaseTests, Commands, release


@unittest.skipUnless(os.environ.get('FAIR_RELEASE_DOCKER_TEST') == '1', 'explicit disposable Docker gate required')
class ComposeTests(ReleaseTests):
    def setUp(self):
        super().setUp()
        self.project = 'fair-release-test-' + self.root.name.lower().replace('_', '-')
        self.image = os.environ.get('RELEASE_TEST_POSTGRES_IMAGE', 'postgres:17-alpine')
        # Two distinct local tags for the same engine reproduce changed image selection.
        self.old_tag = self.project + ':accepted'
        self.new_tag = self.project + ':candidate'
        self.shell(['docker', 'tag', self.image, self.old_tag])
        subprocess.run(['docker','build','-t',self.new_tag,'-'], input='FROM '+self.old_tag+'\nLABEL fair.synthetic.release=candidate\n', text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=120)
        self.assertNotEqual(self.shell(['docker','image','inspect','--format','{{.Id}}',self.old_tag]), self.shell(['docker','image','inspect','--format','{{.Id}}',self.new_tag]))
        (self.root/'compose.yml').write_text('''services:
  postgres:
    image: ${POSTGRES_IMAGE}
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
      POSTGRES_DB: synthetic
    volumes: [data:/var/lib/postgresql/data]
    healthcheck:
      test: [CMD-SHELL, pg_isready -h 127.0.0.1 -U postgres -d synthetic]
      interval: 1s
      timeout: 3s
      retries: 30
  migrate:
    image: ${POSTGRES_IMAGE}
    entrypoint: [psql, -h, postgres, -U, postgres, -d, synthetic, -Atc]
    depends_on:
      postgres: {condition: service_healthy}
volumes:
  data:
''')
        self.previous['configHash'] = release.config_hash(self.root)
        self.candidate['configHash'] = release.config_hash(self.root)
        (self.root/'current.json').write_text(json.dumps(self.previous))
        self.real_env = self.root/'real.env'
        self.real_env.write_text('POSTGRES_IMAGE='+self.old_tag+'\n')
        self.addCleanup(self.destroy)
        self.compose('up', '-d', '--wait', 'postgres')
        self.compose('exec','-T','postgres','psql','-U','postgres','-d','synthetic','-c',
                     "CREATE TABLE preserved(value text); INSERT INTO preserved VALUES ('synthetic-preserved');")

    def shell(self, args):
        return subprocess.check_output(args, cwd=self.root, stderr=subprocess.PIPE, text=True, timeout=120)

    def compose(self, *args):
        return self.shell(['docker','compose','-p',self.project,'--env-file',str(self.real_env),'-f','compose.yml',*args])

    def destroy(self):
        self.compose('down','-v')  # exclusively the randomly named disposable test project
        self.shell(['docker','image','rm',self.old_tag,self.new_tag])

    def identity(self):
        ident = self.compose('ps','-q','postgres').strip()
        info = json.loads(self.shell(['docker','inspect',ident]))[0]
        return (ident,info['Image'],info['Config']['Image'],info['Mounts'],
                self.compose('exec','-T','postgres','psql','-U','postgres','-d','synthetic','-Atc','SELECT value FROM preserved').strip())

    def adapter(self, failure=None):
        test = self
        class RealCommands(Commands):
            def compose(self, env, *args, capture=False):
                self.calls.append(args)
                # Running database inspection remains real; map immutable test manifest to local tags.
                if args[0] == 'ps': return test.compose(*args)
                if args[0] == 'pull': return ''  # already pulled; not a container operation
                if args[0] == 'run':
                    test.real_env.write_text('POSTGRES_IMAGE='+test.new_tag+'\n')
                    compatibility = {'schema':release.SCHEMA,'configuredMigrations':['approved'],
                                     'migrations':['approved'],'hashes':{'approved':'changed' if failure=='compatibility' else 'hash'}}
                    if 'dist/owner/release-check.js' in args:
                        sql = "SELECT '"+json.dumps(compatibility)+"' WHERE EXISTS (SELECT 1 FROM preserved)"
                        return test.compose(*args[:args.index('migrate')+1], sql)
                    if failure == 'migration-timeout':
                        command = ['docker','compose','-p',test.project,'--env-file',str(test.real_env),'-f','compose.yml',*args[:args.index('migrate')+1], 'SELECT pg_sleep(30)']
                        runner = release.Commands(test.root)
                        runner.timeout = 1
                        return runner.run(command, capture=capture)
                    return test.compose(*args[:args.index('migrate')+1], 'SELECT 1')
                return super().compose(env,*args,capture=capture)
            def run(self,args,capture=False):
                if args[:2] == ['docker','inspect']:
                    info = json.loads(test.shell(args))
                    # release digest is synthetic; actual local image/tag/volume checked independently.
                    info[0]['Config']['Image'] = test.previous['postgres']
                    return json.dumps(info)
                if args[:2] in [['docker','ps'],['docker','rm']]: return test.shell(args)
                return super().run(args,capture)
        return RealCommands(test,failure)

    # Inherited mocked tests are not repeated here; these are actual Compose checks.
    def test_real_side_effect_free_successful_preflight(self):
        before = self.identity()
        self.real_env.write_text('POSTGRES_IMAGE='+self.new_tag+'\n')
        self.assertEqual(self.compose('run','--rm','--no-deps','-T','migrate','SELECT value FROM preserved').strip(), 'synthetic-preserved')
        self.assertEqual(before,self.identity())

    def test_real_compatibility_rejection_preserves_container_image_volume_and_data(self):
        before = self.identity()
        with self.assertRaisesRegex(release.ReleaseError,'MIGRATION_COMPATIBILITY_UNPROVEN'):
            release.deploy(self.root,self.settings,self.candidate,self.adapter('compatibility'))
        self.assertEqual(before,self.identity())

    def test_real_backup_failure_preserves_container_image_volume_and_data(self):
        before = self.identity()
        with self.assertRaisesRegex(release.ReleaseError,'BACKUP_FAILED_OPERATOR_REQUIRED'):
            release.deploy(self.root,self.settings,self.candidate,self.adapter('backup'))
        self.assertEqual(before,self.identity())
        self.assertEqual(json.loads((self.root/'release-state.json').read_text())['phase'],'backup')

    def test_real_migration_timeout_stops_one_shot_and_blocks_reentry(self):
        self.candidate['postgres'] = self.previous['postgres']
        commands = self.adapter('migration-timeout')
        with self.assertRaisesRegex(release.ReleaseError,'MIGRATION_FAILED_OPERATOR_REQUIRED'):
            release.deploy(self.root,self.settings,self.candidate,commands)
        self.assertEqual(self.shell(['docker','ps','-aq','--filter','name=^/fair-staging-release-migrate$']).strip(),'')
        state=json.loads((self.root/'release-state.json').read_text())
        self.assertEqual(state['phase'],'migration')
        self.assertEqual(state['status'],'uncertain')
        with self.assertRaisesRegex(release.ReleaseError,'UNRESOLVED_RELEASE'):
            release.deploy(self.root,self.settings,self.candidate,self.adapter())
        self.assertEqual(json.loads((self.root/'current.json').read_text()),self.previous)

# Do not inherit/run mocked ReleaseTests in the disposable Compose class.
for name in list(ReleaseTests.__dict__):
    if name.startswith('test_'):
        setattr(ComposeTests, name, None)

del ReleaseTests
