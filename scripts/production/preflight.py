#!/usr/bin/env python3
"""Validate a manually approved, immutable Fair production release file."""

import re
import sys
from pathlib import Path


def validate(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise ValueError("PRODUCTION_RELEASE_ENV_MISSING")
    entries: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError("PRODUCTION_RELEASE_ENV_INVALID")
        key, value = line.split("=", 1)
        if key in entries or not re.fullmatch(r"[A-Z_]+", key):
            raise ValueError("PRODUCTION_RELEASE_ENV_INVALID")
        entries[key] = value

    sha = entries.get("RELEASE_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("PRODUCTION_RELEASE_SHA_INVALID")
    for key, image in (
        ("API_IMAGE", "owner-api"),
        ("WEB_IMAGE", "web"),
        ("CADDY_IMAGE", "caddy"),
        ("POSTGRES_IMAGE", "postgres"),
    ):
        expected = rf"ghcr\.io/h-zare-dev/fair-platform-{image}@sha256:[0-9a-f]{{64}}"
        if not re.fullmatch(expected, entries.get(key, "")):
            raise ValueError(f"PRODUCTION_{key}_NOT_IMMUTABLE")
    if entries.get("SECRETS_DIR") != "/etc/fair-production/secrets":
        raise ValueError("PRODUCTION_SECRET_DIRECTORY_INVALID")
    if not re.fullmatch(r"[a-zA-Z0-9_.+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", entries.get("ACME_EMAIL", "")):
        raise ValueError("PRODUCTION_ACME_EMAIL_INVALID")
    if entries.get("FAIR_REPORT_CALENDAR") not in {"jalali", "gregorian"}:
        raise ValueError("PRODUCTION_CALENDAR_INVALID")
    if entries.get("FAIR_REPORT_WEEK_START_DAY") not in {
        "SATURDAY", "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"
    }:
        raise ValueError("PRODUCTION_WEEK_START_INVALID")
    if set(entries) != {
        "RELEASE_SHA", "API_IMAGE", "WEB_IMAGE", "CADDY_IMAGE", "POSTGRES_IMAGE",
        "SECRETS_DIR", "ACME_EMAIL", "FAIR_REPORT_CALENDAR", "FAIR_REPORT_WEEK_START_DAY"
    }:
        raise ValueError("PRODUCTION_RELEASE_ENV_UNKNOWN_KEY")
    return entries


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("PRODUCTION_RELEASE_ENV_PATH_REQUIRED")
        validate(Path(sys.argv[1]))
        print("PRODUCTION_RELEASE_ENV_VALID")
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
