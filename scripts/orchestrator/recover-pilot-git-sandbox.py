#!/usr/bin/env python3
"""Recover exactly pilot #57 attempt 2 after Codex couldn't commit a linked worktree.

Save the three uncommitted, approved files to a private archive, leave the
previous receipt and audit trail intact, and prepare an independent attempt 3.
NEVER start a model, deploy, merge, publish or edit GitHub from this script.
Without --execute, only perform read-only preflight validation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile

ISSUE = 57
BASE = "5d7101d6cd85392ab37adbc24056f39aba7d5b2a"
SPEC = "a88c1be212e72f518d8b317747ea586d19f09e37"
SPEC_PATH = "docs/tasks/PILOT-001-automatic-agent-chain.md"
BRANCH = "agent/57-" + SPEC[:12]
KEY1 = f"57:1:IMPLEMENTATION:{BASE}:-"
KEY2 = f"57:2:IMPLEMENTATION:{BASE}:-"
OLD_EVIDENCE = "TOOL_RUNTIME_UNAVAILABLE.bac88147bece"
ALLOWED_FILES = (
    "scripts/pilot/phase-label.ts",
    "scripts/pilot/tsconfig.json",
    "tests/unit/pilot-phase-label.test.ts",
)


class RecoveryBlocked(Exception):
    pass


def git(directory: str, *args: str) -> str:
    return subprocess.check_output(
        ["/usr/bin/git", "-C", directory, *args],
        timeout=30,
        encoding="utf-8",
        stderr=subprocess.DEVNULL,
    ).strip()


def private_json(path: Path) -> dict:
    meta = path.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o077:
        raise RecoveryBlocked("Expected private, owner-controlled JSON file")
    result = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise RecoveryBlocked("Invalid checkpoint JSON")
    return result


def validate_checkpoint(state: dict, receipt: dict) -> None:
    """Read-only, pure state validation; tested with adversarial fixtures."""
    transitions = state.get("transitions")
    last = transitions[-1] if isinstance(transitions, list) and transitions else {}
    expected_key = {
        "gate": "IMPLEMENTATION",
        "key": KEY2,
    }
    if not (
        state.get("taskId") == ISSUE
        and state.get("phase") == "IMPLEMENTING"
        and state.get("attempt") == 2
        and state.get("reworks") == 0
        and state.get("baseSha") == BASE
        and state.get("specSha") == SPEC
        and state.get("specPath") == SPEC_PATH
        and state.get("headSha") is None
        and state.get("candidateSha") is None
        and state.get("prNumber") is None
        and state.get("pendingReport") is None
        and isinstance(state.get("maxReworks"), int)
        and state["maxReworks"] >= 1
        and state.get("verdicts") == {}
        and isinstance(state.get("inFlight"), dict)
        and all(state["inFlight"].get(k) == v for k, v in expected_key.items())
        and last.get("phase") == "IMPLEMENTING"
        and last.get("actor") == "owner-supervised-runtime-recovery"
        and last.get("errorCode") == "TOOL_RUNTIME_RECOVERED"
        and last.get("attempt") == 2
        and receipt.get("key") == KEY1
        and receipt.get("gate") == "IMPLEMENTATION"
        and receipt.get("taskId") == ISSUE
        and receipt.get("attempt") == 1
        and receipt.get("specSha") == SPEC
        and receipt.get("baseSha") == BASE
        and receipt.get("headSha") is None
        and receipt.get("candidateSha") is None
        and receipt.get("evidence")
        == {
            "verdict": "BLOCKED",
            "sha": BASE,
            "evidenceId": OLD_EVIDENCE,
            "defectCode": "TOOL_RUNTIME_UNAVAILABLE",
        }
        and not any(
            t.get("actor") == "owner-supervised-git-sandbox-recovery"
            for t in transitions
            if isinstance(t, dict)
        )
    ):
        raise RecoveryBlocked("Attempt 2 checkpoint does not match known in-flight failure")


def validate_worktree(config: dict) -> Path:
    worktree = Path(config["worktrees"]["IMPLEMENTATION"])
    source = config["sourceRepo"]
    if (
        git(str(worktree), "rev-parse", "HEAD") != BASE
        or git(str(worktree), "branch", "--show-current") != BRANCH
        or Path(git(str(worktree), "rev-parse", "--show-toplevel")).resolve()
        != worktree.resolve()
    ):
        raise RecoveryBlocked("Implementation worktree is not on approved branch/base")
    if git(source, "ls-remote", "--heads", "origin", "development") != (
        f"{BASE}\trefs/heads/development"
    ):
        raise RecoveryBlocked("Approved development SHA drifted")
    if git(source, "ls-remote", "--heads", "origin", BRANCH):
        raise RecoveryBlocked("Pilot implementation branch already exists remotely")

    status = git(str(worktree), "status", "--porcelain=v1", "--untracked-files=all")
    actual = set(status.splitlines())
    expected = {"?? " + path for path in ALLOWED_FILES}
    if actual != expected or len(status.splitlines()) != len(expected):
        raise RecoveryBlocked("Uncommitted changes differ from the three approved pilot files")
    for rel in ALLOWED_FILES:
        info = (worktree / rel).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 50_000:
            raise RecoveryBlocked("Pilot source output must be a bounded regular file")
    return worktree


def atomic_json(path: Path, obj: dict) -> None:
    tmp = Path(str(path) + f".{os.getpid()}.sandbox-recovery.tmp")
    fd = os.open(tmp, os.O_EXCL | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(obj, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        parent_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        tmp.unlink(missing_ok=True)


def archive_files(backup: Path, worktree: Path) -> str:
    fd = os.open(backup, os.O_EXCL | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "wb") as raw:
            with tarfile.open(mode="w:gz", fileobj=raw) as archive:
                for rel in ALLOWED_FILES:
                    archive.add(worktree / rel, arcname=rel, recursive=False)
            raw.flush()
            os.fsync(raw.fileno())
        with tarfile.open(backup, "r:gz") as verify:
            actual = sorted(member.name for member in verify.getmembers())
            if actual != sorted(ALLOWED_FILES):
                raise RecoveryBlocked("Backup verification failed")
        return hashlib.sha256(backup.read_bytes()).hexdigest()
    except Exception:
        backup.unlink(missing_ok=True)
        raise


def recover(config_path: Path, execute: bool) -> None:
    config = private_json(config_path)
    if not (
        config.get("issue") == ISSUE
        and config.get("ownerLogin") == "h-zare-dev"
        and config.get("pilotMode") is True
        and config.get("labActivated") is False
    ):
        raise RecoveryBlocked("Only the approved, non-Lab pilot #57 may be recovered")
    state_path = Path(config["stateFile"])
    evidence_dir = Path(config["evidenceDir"])
    receipt1 = evidence_dir / (
        hashlib.sha256(KEY1.encode()).hexdigest() + ".json"
    )
    receipt2 = evidence_dir / (
        hashlib.sha256(KEY2.encode()).hexdigest() + ".json"
    )
    backup = state_path.with_name(state_path.name + ".attempt2-source-backup.tar.gz")
    checkpoint = state_path.with_name(state_path.name + ".before-git-sandbox-recovery")
    lock_fd = os.open(str(state_path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = private_json(state_path)
        prior = private_json(receipt1)
        validate_checkpoint(state, prior)
        if receipt2.exists():
            raise RecoveryBlocked("Attempt 2 already has a receipt; refuse to repeat")
        if backup.exists() or checkpoint.exists():
            raise RecoveryBlocked("Recovery backup/checkpoint already exists")
        worktree = validate_worktree(config)
        if not execute:
            print("GIT_SANDBOX_RECOVERY_PREFLIGHT_OK | issue=57 | next_attempt=3")
            return
        # Preserve the exact uncommitted files before modifying the worktree.
        digest = archive_files(backup, worktree)
        fd = os.open(checkpoint, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(state, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        for rel in ALLOWED_FILES:
            (worktree / rel).unlink()
        if git(str(worktree), "status", "--porcelain", "--untracked-files=all"):
            raise RecoveryBlocked("Worktree not clean after backed-up output was removed")
        state["inFlight"] = None
        state["attempt"] = 3
        state["phase"] = "IMPLEMENTING"
        state["transitions"].append({
            "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "attempt": 3,
            "phase": "IMPLEMENTING",
            "actor": "owner-supervised-git-sandbox-recovery",
            "errorCode": "CODEX_GATE_EXIT_UNVERIFIED",
            "evidenceId": "attempt2-saved-" + digest[:16],
        })
        atomic_json(state_path, state)
        print("GIT_SANDBOX_RECOVERY_READY | issue=57 | attempt=3")
        print("Attempt 2 sources preserved in private backup:", backup)
        print("No model or GitHub action was started by recovery")
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "config",
        nargs="?",
        default=str(Path.home() / ".config/fair-platform/pilot.json"),
    )
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        recover(Path(args.config), args.execute)
    except (OSError, ValueError, KeyError, RecoveryBlocked, subprocess.SubprocessError) as exc:
        print("RECOVERY_BLOCKED: " + str(exc), file=sys.stderr)
        sys.exit(1)
