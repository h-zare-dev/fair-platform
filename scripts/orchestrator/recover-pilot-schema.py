#!/usr/bin/env python3
"""One-time, fail-closed retry of pilot #57 after Codex rejected its JSON schema.

Never retry a gate that has touched tracked files, produced evidence, or
published a branch. No token, config, worktree, or GitHub content is modified.
"""
import fcntl
import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

EXPECTED_BASE = "5d7101d6cd85392ab37adbc24056f39aba7d5b2a"
EXPECTED_SPEC = "a88c1be212e72f518d8b317747ea586d19f09e37"
EXPECTED_PATH = "docs/tasks/PILOT-001-automatic-agent-chain.md"


def git(folder, *args):
    return subprocess.check_output(
        ["/usr/bin/git", "-C", str(folder), *args],
        text=True,
        timeout=20,
        stderr=subprocess.DEVNULL,
    ).strip()


def recover(config_path):
    config_file = Path(config_path)
    config_mode = config_file.stat()
    if config_mode.st_uid != os.getuid() or config_mode.st_mode & 0o077:
        raise RuntimeError("Pilot config must be private and user-owned")
    config = json.loads(config_file.read_text())
    if not (
        config.get("issue") == 57
        and config.get("pilotMode") is True
        and config.get("labActivated") is False
    ):
        raise RuntimeError("Only the Owner-approved non-Lab pilot #57 is eligible")
    state_path = Path(config["stateFile"])
    if not state_path.is_file():
        raise RuntimeError("No pilot checkpoint found")
    lock_path = Path(str(state_path) + ".lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(state_path.read_text())
        latest = (state.get("transitions") or [{}])[-1]
        inflight = state.get("inFlight") or {}
        expected_key = f"57:1:IMPLEMENTATION:{EXPECTED_BASE}:-"
        phase = state.get("phase")
        valid_phase = (
            phase == "IMPLEMENTING" and latest.get("phase") == "IMPLEMENTING"
        ) or (
            phase == "BLOCKED" and latest.get("errorCode") == "UNRESOLVED_INFLIGHT"
        )
        if not (
            valid_phase
            and state.get("taskId") == 57
            and state.get("attempt") == 1
            and state.get("reworks") == 0
            and state.get("baseSha") == EXPECTED_BASE
            and state.get("specSha") == EXPECTED_SPEC
            and state.get("specPath") == EXPECTED_PATH
            and inflight.get("gate") == "IMPLEMENTATION"
            and inflight.get("key") == expected_key
            and not state.get("headSha")
            and not state.get("candidateSha")
            and not state.get("prNumber")
            and not state.get("pendingReport")
            and not state.get("verdicts")
        ):
            raise RuntimeError("Checkpoint is not the known schema-400 failure")
        worktree = config["worktrees"]["IMPLEMENTATION"]
        branch = "agent/57-" + EXPECTED_SPEC[:12]
        if (
            git(worktree, "rev-parse", "HEAD") != EXPECTED_BASE
            or git(worktree, "branch", "--show-current") != branch
            or git(worktree, "status", "--porcelain") != ""
        ):
            raise RuntimeError("Worktree is not clean on the approved base")
        receipt = Path(config["evidenceDir"]) / (
            hashlib.sha256(expected_key.encode()).hexdigest() + ".json"
        )
        if receipt.exists():
            raise RuntimeError("Gate evidence exists: refusing to retry")
        if git(config["sourceRepo"], "ls-remote", "--heads", "origin", branch):
            raise RuntimeError("Implementation branch has been published")
        backup = Path(str(state_path) + ".before-schema-recovery")
        backup_fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(backup_fd, "w") as output:
            output.write(json.dumps(state, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        state.pop("inFlight")
        state["phase"] = "IMPLEMENTING"
        state["transitions"].append({
            "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "attempt": 1,
            "phase": "IMPLEMENTING",
            "actor": "owner-verified-schema-retry",
            "errorCode": "CODEX_SCHEMA_400_RECOVERED",
        })
        temp = Path(str(state_path) + f".{os.getpid()}.retry.tmp")
        temp_fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(temp_fd, "w") as output:
                output.write(json.dumps(state, indent=2) + "\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp, state_path)
            parent_fd = os.open(state_path.parent, os.O_RDONLY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
        finally:
            temp.unlink(missing_ok=True)
        print("SCHEMA_RETRY_READY | issue=57 | attempt=1 | no previous gate result")
        print("State backup:", backup)
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    path = (
        sys.argv[1]
        if len(sys.argv) == 2
        else str(Path.home() / ".config/fair-platform/pilot.json")
    )
    if len(sys.argv) > 2:
        sys.exit("Usage: python3 recover-pilot-schema.py [pilot-config.json]")
    try:
        recover(path)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as exc:
        sys.exit("RECOVERY_BLOCKED: " + str(exc))
