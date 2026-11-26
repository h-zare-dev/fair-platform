#!/usr/bin/env python3
"""One-time, exclusive-create of credentials for a fresh Fair DB (no rotation)."""

import os
import secrets
import sys
from pathlib import Path


def provision(settings: Path, node_uid: int = 1000, pg_uid: int = 70) -> None:
    destination = settings / "secrets"
    expected = {
        "postgres_password", "admin_database_url", "runtime_database_url",
        "backup_pgpass", "seed_encryption_key", "shadow_webhook_secret",
        "runtime_role_password", "backup_role_password",
    }
    if settings.exists() and any((settings / name).exists() for name in expected):
        raise ValueError("PRODUCTION_CREDENTIALS_ALREADY_EXIST")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("PRODUCTION_SECRET_DIRECTORY_NOT_EMPTY")
    settings.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination.mkdir(mode=0o700, exist_ok=True)
    os.chmod(settings, 0o700)
    os.chmod(destination, 0o700)
    postgres = secrets.token_hex(32)
    runtime = secrets.token_hex(32)
    backup = secrets.token_hex(32)
    values = {
        "postgres_password": postgres,
        "admin_database_url": f"postgresql://fair_migrator:{postgres}@postgres:5432/fair_platform",
        "runtime_database_url": f"postgresql://fair_owner_runtime:{runtime}@postgres:5432/fair_platform",
        "backup_pgpass": f"postgres:5432:fair_platform:fair_backup:{backup}\n",
        "seed_encryption_key": secrets.token_hex(32),
        "shadow_webhook_secret": secrets.token_urlsafe(48),
    }
    for name, value in values.items():
        path = destination / name
        with path.open("x", encoding="utf-8") as output:
            output.write(value)
        os.chmod(path, 0o600)
        if name in {"admin_database_url", "runtime_database_url", "seed_encryption_key", "shadow_webhook_secret"}:
            if path.stat().st_uid != node_uid:
                os.chown(path, node_uid, -1)
        if name == "backup_pgpass":
            if path.stat().st_uid != pg_uid:
                os.chown(path, pg_uid, -1)
    for name, value in (("runtime_role_password", runtime), ("backup_role_password", backup)):
        path = settings / name
        with path.open("x", encoding="utf-8") as output:
            output.write(value)
        os.chmod(path, 0o600)


if __name__ == "__main__":
    try:
        if os.geteuid() != 0 or len(sys.argv) != 1:
            raise ValueError("PRODUCTION_ROOT_ONLY")
        os.umask(0o077)
        provision(Path("/etc/fair-production"))
        print("PRODUCTION_CREDENTIALS_CREATED")
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
