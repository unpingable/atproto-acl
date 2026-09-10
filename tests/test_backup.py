import importlib.util
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest


SPEC = importlib.util.spec_from_file_location(
    "atproto_acl_backup", Path(__file__).parents[1] / "deploy" / "backup.py"
)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


def app_db(tmp_path):
    path = tmp_path / "app.db"
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE service_controls (
                singleton INTEGER PRIMARY KEY,
                maintenance_enabled INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO service_controls VALUES(1, 0);
            CREATE TABLE capacity_events (
                id TEXT PRIMARY KEY, did TEXT, kind TEXT, status TEXT,
                created_at TEXT, finished_at TEXT
            );
        """)
    return path


def maintenance(path):
    with sqlite3.connect(path) as db:
        return db.execute(
            "SELECT maintenance_enabled FROM service_controls WHERE singleton=1"
        ).fetchone()[0]


def test_backup_maintenance_lease_blocks_new_work_and_can_be_released(tmp_path):
    path = app_db(tmp_path)
    backup.begin_maintenance(path, 1)
    assert maintenance(path) == 1
    backup.end_maintenance(path)
    assert maintenance(path) == 0


def test_backup_timeout_releases_maintenance_lease(tmp_path):
    path = app_db(tmp_path)
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO capacity_events VALUES('effect',NULL,'effect','attempting','now',NULL)")
    with pytest.raises(RuntimeError, match="active operations"):
        backup.begin_maintenance(path, 0)
    assert maintenance(path) == 0


def run_backup(root: Path, data_dir: Path, destination: Path):
    return subprocess.run(
        [sys.executable, str(root / "deploy" / "backup.py"), str(data_dir), str(destination)],
        capture_output=True,
        text=True,
    )


def run_restore_check(root: Path, destination: Path):
    return subprocess.run(
        [sys.executable, str(root / "deploy" / "restore-check.py"), str(destination)],
        capture_output=True,
        text=True,
    )


def assert_no_sqlite_sidecars(destination: Path):
    assert not list(destination.rglob("*.db-wal"))
    assert not list(destination.rglob("*.db-shm"))


def test_wal_backup_subprocess_passes_restore_check(tmp_path):
    root = Path(__file__).parents[1]
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    path = app_db(data_dir)
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"

    destination = tmp_path / "generation"
    created = run_backup(root, data_dir, destination)
    assert created.returncode == 0, created.stderr
    assert_no_sqlite_sidecars(destination)
    checked = run_restore_check(root, destination)
    assert checked.returncode == 0, checked.stderr
    assert checked.stdout == "verified 1 databases\n"


def test_wal_backup_subprocess_seals_app_and_multiple_engine_databases(tmp_path):
    root = Path(__file__).parents[1]
    data_dir = tmp_path / "data"
    engine_dir = data_dir / "engine"
    engine_dir.mkdir(parents=True)
    app = app_db(data_dir)
    paths = [app, engine_dir / "one.db", engine_dir / "two.db"]
    for path in paths:
        with sqlite3.connect(path) as db:
            assert db.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
            db.execute("CREATE TABLE IF NOT EXISTS sample(value TEXT)")
            db.execute("INSERT INTO sample VALUES(?)", (path.name,))

    destination = tmp_path / "generation"
    created = run_backup(root, data_dir, destination)
    assert created.returncode == 0, created.stderr
    assert maintenance(app) == 0
    assert_no_sqlite_sidecars(destination)

    checked = run_restore_check(root, destination)
    assert checked.returncode == 0, checked.stderr
    assert checked.stdout == "verified 3 databases\n"

    # Reopening every snapshot after the producing process exits must not
    # mutate bytes already committed to the manifest.
    for snapshot in sorted(destination.rglob("*.db")):
        with sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True) as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    checked_again = run_restore_check(root, destination)
    assert checked_again.returncode == 0, checked_again.stderr
