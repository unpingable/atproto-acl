#!/usr/bin/env python3
"""Online, checksummed backup of app and per-account engine databases."""
from __future__ import annotations

import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time


def backup_db(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with closing(sqlite3.connect(source)) as src, closing(sqlite3.connect(target)) as dst:
        src.backup(dst)
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError(f"integrity check failed for {source.name}")
    os.chmod(target, 0o600)


def seal_db(path: Path):
    """Make the snapshot a single immutable database file before hashing."""
    with closing(sqlite3.connect(path, isolation_level=None)) as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        mode = db.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
        if mode.lower() != "delete":
            raise RuntimeError(f"could not seal {path.name}: journal mode is {mode}")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError(f"integrity check failed for {path.name}")
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists():
            raise RuntimeError(f"could not seal {path.name}: mutable {sidecar.name} remains")


def begin_maintenance(app: Path, timeout: int):
    with closing(sqlite3.connect(app, isolation_level=None)) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(service_controls)")}
        if "maintenance_enabled" not in columns:
            raise RuntimeError("application schema does not support consistent online backup")
        db.execute("BEGIN IMMEDIATE")
        changed = db.execute(
            "UPDATE service_controls SET maintenance_enabled=1 WHERE singleton=1 AND maintenance_enabled=0"
        ).rowcount
        db.execute("COMMIT")
        if changed != 1:
            raise RuntimeError("service maintenance or another backup is already active")
    try:
        deadline = time.monotonic() + timeout
        while True:
            with closing(sqlite3.connect(app)) as db:
                active = db.execute(
                    "SELECT kind,count(*) FROM capacity_events "
                    "WHERE status IN ('running','attempting') AND kind IN ('acquisition','bridge','effect') GROUP BY kind"
                ).fetchall()
            if not active:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(f"timed out waiting for active operations: {active}")
            time.sleep(0.25)
    except BaseException:
        end_maintenance(app)
        raise


def end_maintenance(app: Path):
    with closing(sqlite3.connect(app)) as db, db:
        db.execute("UPDATE service_controls SET maintenance_enabled=0 WHERE singleton=1")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--maintenance-timeout", type=int, default=300)
    args = parser.parse_args()
    args.destination.mkdir(mode=0o700)
    files = []
    app = args.data_dir / "app.db"
    if not app.is_file():
        raise SystemExit("app.db not found")
    maintenance = False
    try:
        begin_maintenance(app, args.maintenance_timeout)
        maintenance = True
        backup_db(app, args.destination / "app.db")
        # A Connection context manager commits the transaction but does not close
        # the connection. Close it before hashing so a WAL checkpoint cannot
        # mutate app.db after its digest has been recorded.
        with closing(sqlite3.connect(args.destination / "app.db")) as snapshot, snapshot:
            snapshot.execute("UPDATE service_controls SET maintenance_enabled=0 WHERE singleton=1")
        seal_db(args.destination / "app.db")
        files.append(Path("app.db"))
        for source in sorted((args.data_dir / "engine").glob("*.db")):
            lock_path = Path(str(source) + ".lock")
            lock_path.touch(mode=0o600, exist_ok=True)
            with lock_path.open() as lock:
                fcntl.flock(lock, fcntl.LOCK_SH)
                relative = Path("engine") / source.name
                backup_db(source, args.destination / relative)
                seal_db(args.destination / relative)
                files.append(relative)
    finally:
        if maintenance:
            end_maintenance(app)
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
