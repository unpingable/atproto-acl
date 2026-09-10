import importlib.util
from pathlib import Path
import sqlite3

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
