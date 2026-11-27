#!/usr/bin/env python3
"""Stage a reviewed production update as immutable digests without touching live pins."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from preflight import validate


IMAGES = (
    ('API_IMAGE', 'owner-api'),
    ('WEB_IMAGE', 'web'),
    ('CADDY_IMAGE', 'caddy'),
)
SOURCE = 'https://github.com/h-zare-dev/fair-platform'


def immutable_image(name: str, sha: str) -> str:
    image = f'ghcr.io/h-zare-dev/fair-platform-{name}'
    tag = f'{image}:{sha}'
    subprocess.run(['docker', 'pull', tag], check=True, stdout=subprocess.DEVNULL)
    result = subprocess.run(['docker', 'image', 'inspect', tag], check=True,
                            capture_output=True, text=True)
    images = json.loads(result.stdout)
    if len(images) != 1:
        raise ValueError('PRODUCTION_UPDATE_IMAGE_INSPECT_INVALID')
    metadata = images[0]
    labels = metadata.get('Config', {}).get('Labels') or {}
    if labels.get('org.opencontainers.image.source') != SOURCE:
        raise ValueError('PRODUCTION_UPDATE_IMAGE_SOURCE_INVALID')
    if labels.get('org.opencontainers.image.revision') != sha:
        raise ValueError('PRODUCTION_UPDATE_IMAGE_REVISION_INVALID')
    matches = [digest for digest in metadata.get('RepoDigests', [])
               if re.fullmatch(re.escape(image) + r'@sha256:[0-9a-f]{64}', digest)]
    if len(matches) != 1:
        raise ValueError('PRODUCTION_UPDATE_IMAGE_DIGEST_INVALID')
    return matches[0]


def stage(current_path: Path, output_path: Path, sha: str) -> None:
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('PRODUCTION_UPDATE_SHA_INVALID')
    current = validate(current_path)
    if current['RELEASE_SHA'] == sha:
        raise ValueError('PRODUCTION_UPDATE_ALREADY_CURRENT')
    if output_path.exists() or output_path.is_symlink():
        raise ValueError('PRODUCTION_UPDATE_OUTPUT_EXISTS')
    new = dict(current)
    new['RELEASE_SHA'] = sha
    # Database engine stays on its already-reviewed immutable digest. A
    # PostgreSQL image change needs a separate maintenance/restore plan.
    for key, name in IMAGES:
        new[key] = immutable_image(name, sha)
    contents = ''.join(f'{key}={value}\n' for key, value in new.items())
    fd, temporary = tempfile.mkstemp(prefix='.candidate.', dir=output_path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(contents)
            file.flush()
            os.fsync(file.fileno())
        validate(Path(temporary))
        os.link(temporary, output_path)  # no clobber, even under a race
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    try:
        if os.geteuid() != 0 or len(sys.argv) != 4:
            raise ValueError('USAGE_ROOT: pin-update.py CURRENT_ENV OUTPUT_ENV REVIEWED_SHA')
        stage(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
        print('PRODUCTION_UPDATE_DIGESTS_PINNED')
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
