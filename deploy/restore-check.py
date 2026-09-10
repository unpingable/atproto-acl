#!/usr/bin/env python3
"""Verify a backup without touching live state."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("backup", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.backup / "manifest.json").read_text())
    if manifest.get("schema") != 1 or not isinstance(manifest.get("files"), dict):
        raise SystemExit("invalid backup manifest")
    for name, expected in manifest["files"].items():
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit("unsafe backup path")
        path = args.backup / relative
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise SystemExit(f"checksum mismatch: {name}")
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise SystemExit(f"integrity check failed: {name}")
    print(f"verified {len(manifest['files'])} databases")


if __name__ == "__main__":
    main()
