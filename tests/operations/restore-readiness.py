"""Deterministic PostgreSQL 17 initialization/restore regressions, real Docker/age/rclone.
Only uniquely named networkless tmpfs containers and synthetic encrypted fixtures.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[2]
DOCKER = shutil.which('docker')


def run(args, **kwargs):
    kwargs.setdefault('stdout',subprocess.PIPE)
    kwargs.setdefault('stderr',subprocess.PIPE)
    return subprocess.run(args, timeout=90, check=True, **kwargs)


def until(check, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check(): return
        time.sleep(0.1)  # Poll an observed condition, never assume elapsed time means ready.
    raise AssertionError('DISPOSABLE_CONDITION_TIMEOUT')


class RestoreReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='fair-restore-regression-')
        cls.root = Path(cls.temp.name)
        cls.addClassCleanup(cls.temp.cleanup)
        image = os.environ.get('UI_POSTGRES_IMAGE', 'fair-fp003b-postgres:test')
        cls.image = run([DOCKER,'image','inspect','--format','{{.Id}}',image],text=True).stdout.strip()
        cls.identity = cls.root/'identity'
        run(['age-keygen','-o',str(cls.identity)])
        recipient = run(['age-keygen','-y',str(cls.identity)],text=True).stdout.strip()
        cls.config = cls.root/'rclone.conf'
        cls.config.write_text('[synthetic]\ntype = local\n')
        cls.config.chmod(0o600)
        cls.backup = cls.root/'valid.dump.age'
        source = 'fair-restore-source-'+str(os.getpid())
        run([DOCKER,'run','-d','--name',source,'--network','none','--tmpfs','/var/lib/postgresql/data',
             '-e','POSTGRES_HOST_AUTH_METHOD=trust',cls.image])
        try:
            until(lambda: subprocess.run([DOCKER,'exec',source,'psql','-h','127.0.0.1','-U','postgres',
                    '-Atc','SELECT 1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5).returncode==0)
            run([DOCKER,'exec',source,'psql','-h','127.0.0.1','-U','postgres','-v','ON_ERROR_STOP=1','-c',
                 'CREATE TABLE fair_owner(id integer); INSERT INTO fair_owner VALUES (1); '
                 'CREATE TABLE pasarguard_events(id bigint); INSERT INTO pasarguard_events VALUES (1),(2); '
                 'CREATE TABLE pasarguard_ingestion_issues(id bigint); INSERT INTO pasarguard_ingestion_issues VALUES (1);'])
            with cls.backup.open('wb') as encrypted:
                dump = subprocess.Popen([DOCKER,'exec',source,'pg_dump','-h','127.0.0.1','-U','postgres','-Fc'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                try:
                    run(['age','-r',recipient],stdin=dump.stdout,stdout=encrypted)
                finally:
                    dump.stdout.close()
                    _, _ = dump.communicate(timeout=30)
                if dump.returncode: raise AssertionError('SYNTHETIC_DUMP_FAILED')
        finally:
            run([DOCKER,'rm','-f',source])
        cls.bin = cls.root/'bin'
        cls.bin.mkdir()
        wrapper = cls.bin/'docker'
        wrapper.write_text('''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
root=Path(os.environ['RESTORE_TEST_ROOT'])
args=sys.argv[1:]
if args[0]=='run':
    name=args[args.index('--name')+1]
    marker=root/'container'
    temporary=root/'container.tmp'
    temporary.write_text(name)
    temporary.replace(marker)
    args[1:1]=['--mount','type=bind,source='+str(root/'hold.sh')+',target=/docker-entrypoint-initdb.d/hold.sh,readonly']
if 'pg_restore' in args:
    (root/'restore-started').touch()
    (root/'restore-order.json').write_text(json.dumps({'sqlReady':(root/'final-sql-ready').exists(),'tcp':'127.0.0.1' in args}))
    if os.environ.get('RESTORE_TEST_MODE')=='interrupt':
        command=args.index('pg_restore')
        args[command:command]=['sh','-c','touch /tmp/fair-test-restore-blocked; while [ ! -f /tmp/fair-test-release-restore ]; do sleep 0.1; done; exec \"$@\"','sh']
    if os.environ.get('RESTORE_TEST_MODE')=='fail':
        # Real container-side restore against a nonexistent database must fail.
        args[args.index('-d')+1]='missing_synthetic_database'
result=subprocess.run([os.environ['RESTORE_TEST_DOCKER'],*args])
if 'pg_isready' in args:
    marker=root/'readiness-probe.json'
    temporary=root/'readiness-probe.tmp'
    temporary.write_text(json.dumps({'tcp':'127.0.0.1' in args,'code':result.returncode}))
    temporary.replace(marker)
if 'psql' in args and args[-1]=='SELECT 1' and result.returncode==0:
    (root/'final-sql-ready').touch()
sys.exit(result.returncode)
''')
        wrapper.chmod(0o755)

    def setUp(self):
        self.case = self.root/self._testMethodName
        self.case.mkdir()
        self.work = self.case/'work'
        self.work.mkdir()
        # Entrypoint is held while its UNIX-only initialization server runs.
        (self.case/'hold.sh').write_text('''#!/bin/sh
set -eu
touch /tmp/fair-test-temporary-ready
while [ ! -f /tmp/fair-test-release-final ]; do sleep 0.1; done
''')
        (self.case/'hold.sh').chmod(0o755)
        self.evidence = self.case/'evidence.json'
        self.env = {**os.environ,'PATH':str(self.bin)+os.pathsep+os.environ['PATH'],
                    'TMPDIR':str(self.work),'RESTORE_TEST_ROOT':str(self.case),
                    'RESTORE_TEST_DOCKER':DOCKER,'RESTORE_POSTGRES_IMAGE':self.image,
                    'BACKUP_OBJECT':'synthetic:'+str(self.backup),'RCLONE_CONFIG':str(self.config),
                    'BACKUP_IDENTITY_FILE':str(self.identity),'RESTORE_EVIDENCE_FILE':str(self.evidence)}
        self.process = None
        self.addCleanup(self.emergency_cleanup)

    def start(self):
        self.started_at=time.monotonic()
        self.process=subprocess.Popen(['bash',str(REPO/'scripts/staging/restore-verify.sh')],
                env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        def running():
            if self.process.poll() is not None:
                stdout,stderr=self.process.communicate()
                raise AssertionError('RESTORE_EXITED_BEFORE_INITIALIZATION '+str(self.process.returncode)+' '+(stdout+stderr).decode())
        def named():
            running()
            return (self.case/'container').exists()
        until(named)
        self.container=(self.case/'container').read_text()
        def temporary_ready():
            running()
            return subprocess.run([DOCKER,'exec',self.container,'test','-f','/tmp/fair-test-temporary-ready'],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5).returncode==0
        until(temporary_ready)
        info=json.loads(run([DOCKER,'inspect',self.container],text=True).stdout)[0]
        self.assertEqual(info['HostConfig']['NetworkMode'],'none')
        self.assertFalse(info['HostConfig']['PortBindings'])
        self.assertEqual(info['HostConfig']['Tmpfs'],{'/var/lib/postgresql/data':''})
        self.assertFalse(any(m['Type']=='volume' for m in info['Mounts']))

    def release_final(self):
        run([DOCKER,'exec',self.container,'touch','/tmp/fair-test-release-final'])

    def finish(self, success):
        stdout, stderr=self.process.communicate(timeout=90)
        self.assertEqual(self.process.returncode==0,success,(stdout+stderr).decode())
        self.assertEqual(self.evidence.exists(),success)
        if success:
            self.assertTrue(json.loads(self.evidence.read_text())['verifiedAt'])
            self.assertTrue((self.case/'final-sql-ready').exists())
            self.assertLess(time.monotonic()-self.started_at,60)
        if (self.case/'restore-order.json').exists():
            self.assertEqual(json.loads((self.case/'restore-order.json').read_text()),{'sqlReady':True,'tcp':True})
        self.assertEqual(list(self.work.iterdir()),[])
        self.assertNotEqual(subprocess.run([DOCKER,'inspect',self.container],stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,timeout=5).returncode,0)

    def emergency_cleanup(self):
        if self.process and self.process.poll() is None:
            os.killpg(self.process.pid,signal.SIGKILL)
            self.process.communicate(timeout=5)
        path=self.case/'container'
        if path.exists(): subprocess.run([DOCKER,'rm','-f',path.read_text()],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)

    def test_temporary_server_cannot_release_restore(self):
        self.start()
        self.assertEqual(run([DOCKER,'exec',self.container,'pg_isready','-U','postgres']).returncode,0)
        self.assertNotEqual(subprocess.run([DOCKER,'exec',self.container,'pg_isready','-h','127.0.0.1','-U','postgres'],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5).returncode,0)
        # Observe the actual production probe rejecting the held initialization server.
        until(lambda: (self.case/'readiness-probe.json').exists())
        probe=json.loads((self.case/'readiness-probe.json').read_text())
        self.assertTrue(probe['tcp'])
        self.assertNotEqual(probe['code'],0)
        self.assertIsNone(self.process.poll())
        self.assertFalse((self.case/'restore-started').exists())
        self.assertFalse(self.evidence.exists())
        self.release_final()
        self.finish(True)

    def test_repeated_fresh_final_servers_restore_valid_encrypted_backup(self):
        for cycle in range(5):
            if cycle:
                self.case=self.root/('fresh-cycle-'+str(cycle)); self.case.mkdir()
                self.work=self.case/'work';self.work.mkdir()
                shutil.copy(self.root/self._testMethodName/'hold.sh',self.case/'hold.sh')
                self.evidence=self.case/'evidence.json'
                self.env.update(TMPDIR=str(self.work),RESTORE_TEST_ROOT=str(self.case),RESTORE_EVIDENCE_FILE=str(self.evidence))
            self.start();self.release_final();self.finish(True)

    def test_corrupted_ciphertext_cannot_generate_success_evidence(self):
        bad=self.case/'corrupt.age';bad.write_text('synthetic-corrupted-ciphertext')
        self.env['BACKUP_OBJECT']='synthetic:'+str(bad)
        self.start();self.release_final();self.finish(False)

    def test_failed_real_restore_cannot_generate_success_evidence(self):
        self.env['RESTORE_TEST_MODE']='fail'
        self.start();self.release_final();self.finish(False)

    def test_interrupted_container_restore_cleans_up_without_evidence(self):
        self.env['RESTORE_TEST_MODE']='interrupt'
        self.start();self.release_final()
        until(lambda: subprocess.run([DOCKER,'exec',self.container,'test','-f','/tmp/fair-test-restore-blocked'],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5).returncode==0)
        os.killpg(self.process.pid,signal.SIGTERM)
        self.finish(False)

    def test_interrupted_readiness_cleans_container_files_and_evidence(self):
        self.start()
        self.process.send_signal(signal.SIGTERM)
        self.finish(False)


if __name__=='__main__': unittest.main(verbosity=2)
