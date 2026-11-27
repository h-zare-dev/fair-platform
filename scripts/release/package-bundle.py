"""Build the production-only payload from tracked files on the Actions runner."""
import json
import runpy
import subprocess
import sys
from pathlib import Path

out = Path(sys.argv[1])
def entries_at(ref):
    for line in subprocess.check_output(['git', 'ls-tree', '-r', ref], text=True).splitlines():
        info, path = line.split('\t', 1)
        mode, kind, sha = info.split()
        yield dict(path=path, type=kind, sha=sha, mode=mode)


entries = list(entries_at('HEAD'))
for row in entries:
    path = row['path']
    if path.startswith(('docker/production/', 'scripts/production/')):
        target = out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(Path(path).read_bytes())
        target.chmod(int(row['mode'], 8) & 0o777)
metadata = runpy.run_path('scripts/production/bundle-check.py')['metadata']
(out / 'bundle.json').write_text(json.dumps(metadata(entries), sort_keys=True))
(out / 'REVISION').write_bytes(subprocess.check_output(['git', 'rev-parse', 'HEAD']))
# Existing development installations predate the deployment image. Include
# their original file hashes so the host never needs Git or a source checkout.
legacy = {}
anchor = 'ab8e44a436bbbc314603f14f12689cd3afaccf3c'
for commit in subprocess.check_output(['git','rev-list','--first-parent',anchor],text=True).splitlines():
    manifest = metadata(entries_at(commit))
    if 'scripts/production/bootstrap.sh' not in manifest:
        break
    legacy[commit] = manifest
(out / 'legacy.json').write_text(json.dumps(legacy, separators=(',', ':')))
