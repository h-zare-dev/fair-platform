import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import termios
import unittest


class TerminalTests(unittest.TestCase):
    def check_terminal(self, typed, expected):
        master, slave = pty.openpty()
        before = termios.tcgetattr(slave)
        module = (Path(__file__).resolve().parents[2]/'apps/api/dist/owner/infrastructure/terminal.js').as_uri()
        script = f"import {{hiddenPassword}} from '{module}'; try {{ const value=await hiddenPassword(); console.log('CAPTURE_OK',value.length); }} catch {{console.log('CAPTURE_CANCELLED');}}"
        process = subprocess.Popen(['node','--input-type=module','-e',script],stdin=slave,stdout=slave,stderr=slave)
        try:
            self.assertTrue(select.select([master],[],[],5)[0])
            output = os.read(master,4096)
            self.assertIn(b'hidden input',output)
            if typed is None: process.send_signal(signal.SIGTERM)
            else: os.write(master,typed)
            process.wait(timeout=5)
            while select.select([master],[],[],0.1)[0]:
                output += os.read(master,4096)
            self.assertIn(expected,output)
            self.assertNotIn(b'synthetic-terminal-password',output)
            self.assertEqual(termios.tcgetattr(slave),before)
        finally:
            if process.poll() is None: process.kill();process.wait()
            os.close(master);os.close(slave)

    def test_hidden_input_never_echoes_and_restores_terminal(self):
        self.check_terminal(b'synthetic-terminal-password\r',b'CAPTURE_OK')

    def test_sigterm_restores_terminal(self):
        self.check_terminal(None,b'CAPTURE_CANCELLED')

    def test_control_c_cancels_and_restores_terminal(self):
        self.check_terminal(b'synthetic-terminal-password\x03',b'CAPTURE_CANCELLED')

if __name__=='__main__': unittest.main()
