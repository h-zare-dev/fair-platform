#!/usr/bin/env python3
"""Run the previously reviewed private legacy exporter with a new UTC window."""

import argparse
import ast
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def source_for_window(source: str, days: int, cutoff: datetime) -> str:
    tree = ast.parse(source)
    cutoffs = [
        node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(name, ast.Name) and name.id == "CUTOFF" for name in node.targets)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    ]
    guards = [
        node
        for comparison in ast.walk(tree)
        if isinstance(comparison, ast.Compare)
        and isinstance(comparison.left, ast.Name)
        and comparison.left.id == "days"
        for node in comparison.comparators
        if isinstance(node, (ast.List, ast.Tuple, ast.Set))
        and all(isinstance(value, ast.Constant) and type(value.value) is int for value in node.elts)
        and {value.value for value in node.elts} == {1, 7, 30}
    ]
    if len(cutoffs) != 1 or not guards:
        raise ValueError("LEGACY_EXPORTER_CONTRACT_NOT_RECOGNIZED")

    def offset(line: int, column: int) -> int:
        return sum(map(len, lines[: line - 1])) + column

    contents = source.encode("utf-8")
    lines = contents.splitlines(keepends=True)
    replacements = [
        (cutoffs[0], repr(cutoff.astimezone(timezone.utc).isoformat(sep=" "))),
        *((node, repr((1, 7, 30, days))) for node in guards),
    ]
    for node, value in sorted(replacements, key=lambda item: (
        item[0].lineno, item[0].col_offset), reverse=True):
        start = offset(node.lineno, node.col_offset)
        stop = offset(node.end_lineno, node.end_col_offset)
        contents = contents[:start] + value.encode("utf-8") + contents[stop:]
    result = contents.decode("utf-8")
    ast.parse(result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--days", required=True, type=int)
    parser.add_argument("--cutoff", required=True, type=datetime.fromisoformat)
    args = parser.parse_args()
    if not 90 <= args.days <= 186 or args.cutoff.utcoffset() != timezone.utc.utcoffset(None):
        parser.error("Use 90–186 days and an explicit UTC cutoff.")
    source = args.source.resolve(strict=True)
    try:
        content = source_for_window(source.read_text(encoding="utf-8"), args.days, args.cutoff)
    except (SyntaxError, ValueError):
        parser.error("The private exporter does not match the reviewed window/cutoff contract.")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="fair-legacy-export-", dir=source.parent) as directory:
        copy = Path(directory) / source.name
        copy.write_text(content, encoding="utf-8")
        return subprocess.run([sys.executable, str(copy), str(args.days)], cwd=source.parent,
                              check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
