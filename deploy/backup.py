#!/usr/bin/env python3
"""Online, checksummed backup of app and per-account engine databases."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def backup_db(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with sqlite3.connect(source) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError(f"integrity check failed for {source.name}")
    os.chmod(target, 0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    args.destination.mkdir(mode=0o700)
    files = []
    app = args.data_dir / "app.db"
    if not app.is_file():
        raise SystemExit("app.db not found")
    backup_db(app, args.destination / "app.db")
    files.append(Path("app.db"))
    for source in sorted((args.data_dir / "engine").glob("*.db")):
        lock_path = Path(str(source) + ".lock")
        lock_path.touch(mode=0o600, exist_ok=True)
        with lock_path.open() as lock:
            fcntl.flock(lock, fcntl.LOCK_SH)
            relative = Path("engine") / source.name
            backup_db(source, args.destination / relative)
            files.append(relative)
    manifest = {
        "schema": 1,
        "files": {
            str(path): hashlib.sha256((args.destination / path).read_bytes()).hexdigest()
            for path in files
        },
    }
    manifest_path = args.destination / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.chmod(manifest_path, 0o600)


if __name__ == "__main__":
    main()
