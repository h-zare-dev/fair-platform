#!/usr/bin/env python3
"""Validate/write the mutable public endpoint, apart from immutable image pins."""

import ipaddress
import os
from pathlib import Path
import re
import sys
import tempfile


def validate_host(value: str) -> str:
    """Accept only a canonical ASCII DNS name, localhost or an IPv4 literal."""
    if not value or len(value) > 253 or value != value.lower():
        raise ValueError('PRODUCTION_OWNER_HOST_INVALID')
    if value == 'localhost':
        return value
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        pass
    else:
        if address.is_unspecified or address.is_multicast:
            raise ValueError('PRODUCTION_OWNER_HOST_INVALID')
        return value
    labels = value.split('.')
    if len(labels) < 2 or any(
        not 1 <= len(label) <= 63
        or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', label)
        for label in labels
    ) or labels[-1].isdigit():
        raise ValueError('PRODUCTION_OWNER_HOST_INVALID')
    return value


def read(path: Path) -> str:
    if not path.is_file() or path.is_symlink():
        raise ValueError('PRODUCTION_SITE_ENV_MISSING_OR_UNSAFE')
    lines = path.read_text(encoding='utf-8').splitlines()
    if len(lines) != 1 or not lines[0].startswith('OWNER_HOST='):
        raise ValueError('PRODUCTION_SITE_ENV_INVALID')
    return validate_host(lines[0].removeprefix('OWNER_HOST='))


def write(path: Path, host: str) -> None:
    validate_host(host)
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError('PRODUCTION_SITE_ENV_UNSAFE')
    fd, name = tempfile.mkstemp(prefix='.site.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(f'OWNER_HOST={host}\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == 'host':
            print(validate_host(sys.argv[2]))
        elif len(sys.argv) == 3 and sys.argv[1] == 'read':
            print(read(Path(sys.argv[2])))
        elif len(sys.argv) == 4 and sys.argv[1] == 'write':
            write(Path(sys.argv[2]), sys.argv[3])
            print('PRODUCTION_OWNER_HOST_CONFIGURED')
        else:
            raise ValueError('USAGE: site-config.py host HOST | read FILE | write FILE HOST')
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
