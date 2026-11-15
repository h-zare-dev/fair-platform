#!/usr/bin/env python3
"""Fail-closed, one-time recovery for Fair Platform pilot #57 tool-host failure.

The previous BLOCKED verdict and its immutable receipt are preserved.
No model, deploy, merge, credential read or GitHub mutation occurs here.
Use --execute only after the corrected Codex runtime is installed locally.
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

ISSUE = 57
BASE = "5d7101d6cd85392ab37adbc24056f39aba7d5b2a"
SPEC = "a88c1be212e72f518d8b317747ea586d19f09e37"
SPEC_PATH = "docs/tasks/PILOT-001-automatic-agent-chain.md"
EVIDENCE_ID = "TOOL_RUNTIME_UNAVAILABLE.bac88147bece"
BRANCH = "agent/57-" + SPEC[:12]
PREVIOUS_KEY = f"57:1:IMPLEMENTATION:{BASE}:-"
NEXT_KEY = f"57:2:IMPLEMENTATION:{BASE}:-"


class RecoveryBlocked(Exception):
    pass


def private_json(path: Path) -> dict:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise RecoveryBlocked("Expected a regular, user-owned private file")
    if info.st_mode & 0o077:
        raise RecoveryBlocked("Private file is accessible to another user")
    result = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise RecoveryBlocked("Invalid JSON object")
    return result


def validate_checkpoint(state: dict, receipt: dict) -> None:
    """Pure validation, also exercised by the regression suite."""
    transitions = state.get("transitions")
    last = transitions[-1] if isinstance(transitions, list) and transitions else {}
    verdicts = {
        "IMPLEMENTATION": {
            "verdict": "BLOCKED",
            "sha": BASE,
            "evidenceId": EVIDENCE_ID,
        }
    }
    expected_receipt = {
        "key": PREVIOUS_KEY,
        "gate": "IMPLEMENTATION",
        "taskId": ISSUE,
        "attempt": 1,
        "specSha": SPEC,
        "baseSha": BASE,
    }
    evidence = receipt.get("evidence")
    if not isinstance(evidence, dict):
        raise RecoveryBlocked("Receipt lacks gate evidence")
    expected_evidence = {
        "verdict": "BLOCKED",
        "sha": BASE,
        "evidenceId": EVIDENCE_ID,
        "defectCode": "TOOL_RUNTIME_UNAVAILABLE",
    }
    ok = (
        state.get("taskId") == ISSUE
        and state.get("phase") == "BLOCKED"
        and state.get("attempt") == 1
        and state.get("reworks") == 0
        and isinstance(state.get("maxReworks"), int)
        and state["maxReworks"] >= 1
        and state.get("baseSha") == BASE
        and state.get("specSha") == SPEC
        and state.get("specPath") == SPEC_PATH
        and state.get("headSha") is None
        and state.get("candidateSha") is None
        and state.get("prNumber") is None
        and state.get("inFlight") is None
        and state.get("pendingReport") is None
        and state.get("verdicts") == verdicts
        and last.get("phase") == "BLOCKED"
        and last.get("attempt") == 1
        and last.get("actor") == "IMPLEMENTATION"
        and last.get("errorCode") == "TOOL_RUNTIME_UNAVAILABLE"
        and last.get("evidenceId") == EVIDENCE_ID
        and all(receipt.get(k) == v for k, v in expected_receipt.items())
        and receipt.get("headSha") is None
        and receipt.get("candidateSha") is None
        and all(evidence.get(k) == v for k, v in expected_evidence.items())
        and not any(
            t.get("actor") == "owner-supervised-runtime-recovery"
            for t in transitions
            if isinstance(t, dict)
        )
    )
    if not ok:
        raise RecoveryBlocked("Checkpoint does not exactly match approved failure")


def git(repo: str, *args: str) -> str:
    return subprocess.check_output(
        ["/usr/bin/git", "-C", repo, *args],
        encoding="utf-8",
        stderr=subprocess.DEVNULL,
        timeout=30,
    ).strip()


def validate_worktree(config: dict) -> None:
    source = config["sourceRepo"]
    worktree = config["worktrees"]["IMPLEMENTATION"]
    if git(worktree, "rev-parse", "HEAD") != BASE:
        raise RecoveryBlocked("Implementation HEAD moved")
    if git(worktree, "branch", "--show-current") != BRANCH:
        raise RecoveryBlocked("Implementation branch changed")
    if git(worktree, "status", "--porcelain", "--untracked-files=all"):
        raise RecoveryBlocked("Implementation worktree is not clean")
    if Path(git(worktree, "rev-parse", "--show-toplevel")).resolve() != Path(worktree).resolve():
        raise RecoveryBlocked("Unexpected implementation worktree")
    remote_base = git(source, "ls-remote", "--heads", "origin", "development")
    if remote_base != f"{BASE}\trefs/heads/development":
        raise RecoveryBlocked("Approved development SHA has drifted")
    if git(source, "ls-remote", "--heads", "origin", BRANCH):
        raise RecoveryBlocked("Implementation branch already published")


def write_atomic(path: Path, value: dict) -> None:
    temporary = Path(str(path) + f".{os.getpid()}.runtime-retry.tmp")
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(value, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def recover(config_path: Path, execute: bool) -> None:
    config = private_json(config_path)
    if not (
        config.get("issue") == ISSUE
        and config.get("ownerLogin") == "h-zare-dev"
        and config.get("pilotMode") is True
        and config.get("labActivated") is False
    ):
        raise RecoveryBlocked("Not the authorized non-Lab pilot #57")
    state_path = Path(config["stateFile"])
    receipt_dir = Path(config["evidenceDir"])
    previous_receipt = receipt_dir / (
        hashlib.sha256(PREVIOUS_KEY.encode()).hexdigest() + ".json"
    )
    next_receipt = receipt_dir / (
        hashlib.sha256(NEXT_KEY.encode()).hexdigest() + ".json"
    )
    backup = Path(str(state_path) + ".before-runtime-recovery")
    lock_path = Path(str(state_path) + ".lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = private_json(state_path)
        receipt = private_json(previous_receipt)
        validate_checkpoint(state, receipt)
        if next_receipt.exists():
            raise RecoveryBlocked("A second-attempt receipt already exists")
        if backup.exists():
            raise RecoveryBlocked("Recovery backup already exists")
        validate_worktree(config)
        if not execute:
            print("RUNTIME_RECOVERY_PREFLIGHT_OK | issue=57 | next_attempt=2")
            return

        # Refuse to rewrite an existing audit backup, even after interruption.
        backup_fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(backup_fd, "w", encoding="utf-8") as out:
            json.dump(state, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())

        # An infrastructure retry is not a code-defect rework. The prior gate
        # verdict stays in the receipt, transition history and GitHub comment.
        state["attempt"] = 2
        state["phase"] = "IMPLEMENTING"
        state["verdicts"] = {}
        state["transitions"].append({
            "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "attempt": 2,
            "phase": "IMPLEMENTING",
            "actor": "owner-supervised-runtime-recovery",
            "evidenceId": EVIDENCE_ID,
            "errorCode": "TOOL_RUNTIME_RECOVERED",
        })
        write_atomic(state_path, state)
        print("RUNTIME_RECOVERY_READY | issue=57 | attempt=2")
        print("Previous receipt preserved; no model was started")
    finally:
        os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "config",
        nargs="?",
        default=str(Path.home() / ".config/fair-platform/pilot.json"),
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Perform the one-time state transition after all checks",
    )
    args = parser.parse_args()
    try:
        recover(Path(args.config), args.execute)
    except (
        OSError,
        ValueError,
        KeyError,
        RecoveryBlocked,
        subprocess.SubprocessError,
    ) as exc:
        print(f"RECOVERY_BLOCKED: {exc}", file=sys.stderr)
        sys.exit(1)
