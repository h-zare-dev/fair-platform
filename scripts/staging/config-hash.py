#!/usr/bin/env python3
import hashlib
from pathlib import Path
root = Path(__file__).resolve().parents[2] / 'docker' / 'staging'
digest = hashlib.sha256()
for name in ['compose.yml', 'Caddyfile']:
    digest.update(name.encode() + b'\0' + (root / name).read_bytes())
print(digest.hexdigest())
