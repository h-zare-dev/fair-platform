"""Read-only compatibility check for a production bundle transition."""
import hashlib
import json
import re
import sys
from pathlib import Path


def protected(path):
    return (path.startswith('apps/api/src/owner/migrations/')
            or 'migration' in Path(path).name and path.endswith('.ts')
            or path in {'apps/api/src/owner/infrastructure/database.ts',
                        'docker/production/runtime-grants.sql', 'docker/Dockerfile.postgres'})


def metadata(entries):
    return {row['path']: row['sha'] for row in entries if row['type'] == 'blob' and
            (protected(row['path']) or row['path'].startswith(('docker/production/', 'scripts/production/')))}


def verify(candidate, previous, old_sha):
    if not re.fullmatch('[0-9a-f]{40}', old_sha):
        raise ValueError('Invalid installed revision')
    if (previous / 'REVISION').is_file():
        if (previous / 'REVISION').read_text().strip() != old_sha:
            raise ValueError('Installed revision mismatch')
        old = json.loads((previous / 'bundle.json').read_text())
    else:
        old = json.loads((candidate / 'legacy.json').read_text())[old_sha]
    new = json.loads((candidate / 'bundle.json').read_text())
    if not old or {p:s for p,s in old.items() if protected(p)} != {p:s for p,s in new.items() if protected(p)}:
        raise ValueError('SCHEMA_OR_POSTGRES_CHANGED')
    close_time = None
    for path, expected in old.items():
        if path.startswith(('docker/production/', 'scripts/production/')):
            data = (previous / path).read_bytes()
            if path == 'docker/production/compose.shadow.yml':
                pattern = rb"^      FAIR_SHADOW_CLOSE_TIME: '((?:[01][0-9]|2[0-3]):[0-5][0-9])'$"
                times = re.findall(pattern, data, re.M)
                if len(times) == 1:
                    close_time = times[0].decode()
                    if close_time != '02:10':
                        data = re.sub(pattern, b"      FAIR_SHADOW_CLOSE_TIME: '02:10'", data, flags=re.M)
            if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != expected:
                raise ValueError('Modified installed file: ' + path)

    return close_time or ''


if __name__ == '__main__':
    print(verify(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]))
