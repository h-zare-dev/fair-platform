#!/usr/bin/env python3
"""Export an operator-only SHADOW archive from the legacy webhook store."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

EVENT_FIELDS = ("action", "enqueued_at", "send_at", "tries", "username")
USER_FIELDS = (
    "id", "username", "status", "created_at", "expire", "edit_at", "data_limit",
    "used_traffic", "lifetime_used_traffic", "data_limit_reset_strategy",
    "on_hold_expire_duration",
)


def fields(value, keys):
    if value is None:
        return None
    if not isinstance(value, dict):
        return {}
    projected = {key: value[key] for key in keys if key in value}
    if any(isinstance(item, (dict, list)) for item in projected.values()):
        raise ValueError("INVALID_LEGACY_FIELD")
    return projected


def project_event(event):
    clean = fields(event, EVENT_FIELDS)
    user = event.get("user")
    if "user" in event:
        clean["user"] = fields(user, USER_FIELDS)
    if isinstance(user, dict):
        if "admin" in user:
            clean["user"]["admin"] = fields(user["admin"], ("id", "username"))
        if "next_plan" in user:
            # The normalizer only uses presence to hold the event for review.
            clean["user"]["next_plan"] = None if user["next_plan"] is None else True
    if "by" in event:
        clean["by"] = fields(event["by"], ("id", "username"))
    return clean


def write_archive(records, destination, days, cutoff):
    with TemporaryDirectory(prefix=".source-replay-", dir=destination) as pending:
        archive = Path(pending) / "source-replay.jsonl.gz"
        actions = Counter()
        batches = rows = children = mismatches = null_actors = 0
        with archive.open("wb") as output, gzip.GzipFile(
            filename="", fileobj=output, mode="wb", mtime=0
        ) as compressed:
            for line in records:
                record = json.loads(line)
                payload = record["payload"]
                if not isinstance(payload, list) or not payload or any(
                    not isinstance(event, dict) for event in payload
                ):
                    raise ValueError("INVALID_LEGACY_BATCH")
                count = record["stored_rows"]
                batches += 1
                children += len(payload)
                if batches > 100_000 or children > 400_000:
                    raise ValueError("ARCHIVE_LIMIT_EXCEEDED")
                rows += count
                mismatches += count != len(payload)
                for event in payload:
                    actions[event.get("action", "(missing)")] += 1
                    actor = event.get("by")
                    null_actors += isinstance(actor, dict) and "id" in actor and actor["id"] is None
                projected = {
                    "received_at": record["received_at"],
                    "legacy_stored_rows": count,
                    "payload": [project_event(event) for event in payload],
                }
                compressed.write((json.dumps(projected, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
        if not batches:
            raise ValueError("EMPTY_LEGACY_ARCHIVE")
        with archive.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        manifest = {
            "manifest_version": 1,
            "source": "legacy-pasarjew-postgresql",
            "identity": "source-webhook",
            "window_days": days,
            "cutoff_utc": cutoff,
            "distinct_payload_groups": batches,
            "legacy_stored_rows": rows,
            "replay_event_children": children,
            "groups_with_repetition_mismatch": mismatches,
            "actor_object_null_id_events": null_actors,
            "action_counts": dict(actions),
            "sha256_gzip": digest,
        }
        metadata = Path(pending) / "source-replay.manifest.json"
        metadata.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        target = destination / f"pasarjew-source-{days}d-{digest}.jsonl.gz"
        # Publish only after the database stream exits successfully. Deterministic
        # gzip bytes allow retrying the same export without another SHADOW run.
        metadata.replace(target.with_name(target.name.replace(".jsonl.gz", ".manifest.json")))
        archive.replace(target)
        return target, batches, children


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, required=True)
    parser.add_argument("--cutoff", type=datetime.fromisoformat, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--container", default="db-timescaledb-1")
    parser.add_argument("--database", default="pasarjew")
    parser.add_argument("--user", default="pasarguard")
    args = parser.parse_args()
    if args.cutoff.utcoffset() != timezone.utc.utcoffset(None) or (
        args.days not in (1, 7, 30) and not 90 <= args.days <= 186
    ):
        parser.error("Use 1, 7, 30 or 90–186 days and an explicit UTC cutoff.")
    cutoff = args.cutoff.astimezone(timezone.utc).isoformat()
    query = f"""
        SELECT jsonb_build_object('received_at', MIN(created_at),
          'stored_rows', COUNT(*), 'payload', raw_payload)::text
        FROM public.webhook_events
        WHERE created_at >= TIMESTAMPTZ '{cutoff}' - INTERVAL '{args.days} days'
          AND created_at < TIMESTAMPTZ '{cutoff}'
        GROUP BY raw_payload ORDER BY MIN(created_at), MIN(id)
    """
    os.umask(0o077)
    destination = args.output_dir.resolve()
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.stat().st_mode & 0o077 or any(
        (parent / ".git").exists() for parent in (destination, *destination.parents)
    ):
        parser.error("Choose a private output directory outside the Git worktree.")
    command = [
        "docker", "exec", "-i", "-e",
        "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=180000 -c timezone=UTC",
        args.container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
        "-U", args.user, "-d", args.database, "-c", query,
    ]
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          text=True, encoding="utf-8") as process:
        def records():
            yield from process.stdout
            if process.wait() != 0:
                raise RuntimeError("LEGACY_DATABASE_READ_FAILED")
        try:
            target, batches, children = write_archive(records(), destination, args.days, cutoff)
        finally:
            if process.poll() is None:
                process.kill()
    print(json.dumps({"file": str(target), "batches": batches, "events": children}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        sys.exit("SOURCE_REPLAY_EXPORT_FAILED")
