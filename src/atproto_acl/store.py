"""Account-bound persistence, identity migrations, and durable action journal."""
from __future__ import annotations

import fcntl
import json
import os
import sqlite3
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path

from .model import Observation, canonical, utcnow


class StateError(ValueError):
    pass


class Store:
    def __init__(self, path: str | Path, account: str, evidence_mode="live"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.conn = sqlite3.connect(self.path, isolation_level=None)
        os.chmod(self.path, 0o600)
        self.conn.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pins (name TEXT PRIMARY KEY, did TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT, old_did TEXT, new_did TEXT, at TEXT);
            CREATE TABLE IF NOT EXISTS overrides (did TEXT, kind TEXT, PRIMARY KEY(did,kind));
            CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS discovery (source TEXT, did TEXT, PRIMARY KEY(source,did));
            CREATE TABLE IF NOT EXISTS ledger (did TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, did TEXT, action TEXT, status TEXT, at TEXT, detail TEXT);
            CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, kind TEXT, body TEXT, at TEXT);
        """)
        for key, value in (("schema", "1"), ("account", account), ("evidence_mode", evidence_mode)):
            self.conn.execute("INSERT OR IGNORE INTO meta VALUES (?,?)", (key, value))
            if self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()[0] != value:
                self.conn.close()
                raise StateError(f"state {key} mismatch; explicit migration required")
        self.account = account
        self.evidence_mode = evidence_mode

    def close(self):
        self.conn.close()

    @contextmanager
    def lock(self):
        with open(str(self.path) + ".lock", "a") as handle:
            os.chmod(handle.name, 0o600)
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise StateError("another runtime holds the state lock") from exc
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def pin(self, name: str, did: str):
        row = self.conn.execute("SELECT did FROM pins WHERE name=?", (name,)).fetchone()
        if row and row[0] != did:
            raise StateError(f"identity rebinding required for {name}: {row[0]} -> {did}")
        self.conn.execute("INSERT OR IGNORE INTO pins VALUES (?,?)", (name, did))
        return did

    def rebind(self, name: str, old: str, new: str):
        row = self.conn.execute("SELECT did FROM pins WHERE name=?", (name,)).fetchone()
        if not row or row[0] != old or old == new:
            raise StateError("rebind requires the exact existing and different new DID")
        with self.transaction():
            self.conn.execute("UPDATE pins SET did=? WHERE name=?", (new, name))
            self.conn.execute("INSERT INTO migrations(name,old_did,new_did,at) VALUES (?,?,?,?)",
                              (name, old, new, utcnow()))

    def identities(self):
        return {"pins": dict(self.conn.execute("SELECT name,did FROM pins ORDER BY name")),
                "migrations": [dict(zip(("name", "old_did", "new_did", "at"), row)) for row in
                    self.conn.execute("SELECT name,old_did,new_did,at FROM migrations ORDER BY id")]}

    @contextmanager
    def transaction(self):
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        else:
            self.conn.execute("COMMIT")

    def add_evidence(self, evidence):
        with self.transaction():
            for obs in evidence:
                self.conn.execute("INSERT OR IGNORE INTO observations VALUES (?,?,?)",
                                  (obs.evidence_id, obs.subject, canonical(asdict(obs))))

    def evidence(self, subject):
        return tuple(Observation(**json.loads(row[0])) for row in self.conn.execute(
            "SELECT body FROM observations WHERE subject=? ORDER BY id", (subject,)))

    def cursor(self, key):
        row = self.conn.execute("SELECT value FROM cursors WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def set_cursor(self, key, value):
        self.conn.execute("INSERT OR REPLACE INTO cursors VALUES (?,?)", (key, canonical(value)))

    def discover(self, source, dids):
        self.conn.executemany("INSERT OR IGNORE INTO discovery VALUES (?,?)", ((source, did) for did in dids))

    def discovered(self, source):
        return tuple(r[0] for r in self.conn.execute("SELECT did FROM discovery WHERE source=? ORDER BY did", (source,)))

    def ledgers(self):
        return {r[0]: {"status": r[1], **json.loads(r[2])} for r in
                self.conn.execute("SELECT did,status,detail FROM ledger ORDER BY did")}

    def ledger(self, did, status, detail=None):
        self.conn.execute("INSERT OR REPLACE INTO ledger VALUES (?,?,?)", (did, status, canonical(detail or {})))

    def set_override(self, did, kind, enabled=True):
        if kind not in ("exempt", "allow", "keep_muted"):
            raise StateError("unknown override")
        if enabled:
            self.conn.execute("INSERT OR IGNORE INTO overrides VALUES (?,?)", (did, kind))
        else:
            self.conn.execute("DELETE FROM overrides WHERE did=? AND kind=?", (did, kind))
        self.audit("override", {"subject": did, "kind": kind, "enabled": enabled})

    def replace_overrides(self, values, revision=None, rule_hash=None):
        expected = {"exempt", "allow", "keep_muted"}
        if set(values) != expected:
            raise StateError("replacement override set is incomplete")
        normalized = {}
        for kind, dids in values.items():
            if not isinstance(dids, list) or any(not isinstance(did, str) or not did.startswith("did:") for did in dids):
                raise StateError("replacement overrides require DID lists")
            normalized[kind] = sorted(set(dids))
        with self.transaction():
            self.conn.execute("DELETE FROM overrides")
            self.conn.executemany(
                "INSERT INTO overrides(did,kind) VALUES (?,?)",
                ((did, kind) for kind in sorted(normalized) for did in normalized[kind]),
            )
            self.audit("override_projection", {
                "revision": revision, "account_rules_hash": rule_hash,
                "overrides": normalized,
            })
        return normalized

    def audit(self, kind, body):
        self.conn.execute("INSERT INTO audit(kind,body,at) VALUES (?,?,?)", (kind, canonical(body), utcnow()))

    def overrides(self):
        result = {k: set() for k in ("exempt", "allow", "keep_muted")}
        for did, kind in self.conn.execute("SELECT did,kind FROM overrides"):
            result[kind].add(did)
        return result

    def begin_action(self, did, action, detail):
        with self.transaction():
            attempt = self.conn.execute("INSERT INTO attempts(did,action,status,at,detail) VALUES (?,?,?,?,?)",
                (did, action, "pending", utcnow(), canonical(detail))).lastrowid
            self.ledger(did, "unresolved", {"attempt": attempt, "reason": "write outcome pending"})
        return attempt

    def finish_action(self, attempt, did, action, success):
        with self.transaction():
            status = "confirmed" if success else "unresolved"
            self.conn.execute("UPDATE attempts SET status=? WHERE id=?", (status, attempt))
            self.ledger(did, ("attributed" if action == "mute" else "released") if success else "unresolved",
                        {"attempt": attempt, "action": action})

    def attributed_receipt(self, did, ledger):
        """Historical decision for a confirmed mute, never ownership evidence."""
        if ledger.get("status") != "attributed" or "attempt" not in ledger:
            return None
        attempt = self.conn.execute(
            "SELECT detail FROM attempts WHERE id=? AND did=? AND action='mute' AND status='confirmed'",
            (ledger["attempt"], did)).fetchone()
        if not attempt:
            return None
        proposal = json.loads(attempt[0]).get("proposal")
        row = self.conn.execute("SELECT body FROM receipts WHERE id=?", (proposal,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_receipt(self, receipt):
        self.conn.execute("INSERT INTO receipts VALUES (?,?)", (receipt["id"], canonical(receipt)))

    def receipt(self, receipt_id):
        row = self.conn.execute("SELECT body FROM receipts WHERE id=?", (receipt_id,)).fetchone()
        if not row:
            raise StateError("unknown saved proposal")
        return json.loads(row[0])
