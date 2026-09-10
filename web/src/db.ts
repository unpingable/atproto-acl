import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ADMISSION_SCHEMA } from './admission.js'

function now() { return new Date().toISOString() }
export function id(prefix: string) { return prefix + '_' + randomBytes(18).toString('base64url') }
export function sha(value: string) { return createHash('sha256').update(value).digest('hex') }

export class AppDb {
  readonly sql: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.sql = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.sql.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (
        did TEXT PRIMARY KEY, handle TEXT NOT NULL, display_name TEXT, pds TEXT,
        connected INTEGER NOT NULL DEFAULT 1, permissions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        token_hash TEXT PRIMARY KEY, did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_state (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_sessions (
        did TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_locks (
        key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY, did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
        name TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL, source_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS policies_user ON policies(did, updated_at DESC);
      CREATE TABLE IF NOT EXISTS account_exceptions (
        did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
        subject TEXT NOT NULL, kind TEXT NOT NULL, handle TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, PRIMARY KEY(did, subject, kind)
      );
      CREATE TABLE IF NOT EXISTS previews (
        id TEXT PRIMARY KEY, did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
        policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL, effective_hash TEXT NOT NULL,
        receipt TEXT NOT NULL, acquisition TEXT NOT NULL, complete INTEGER NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS previews_user ON previews(did, created_at DESC);
      CREATE TABLE IF NOT EXISTS yield_reports (
        id TEXT PRIMARY KEY, did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
        policy_hash TEXT NOT NULL, acquisition_hash TEXT NOT NULL,
        report TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS yield_reports_user ON yield_reports(did, created_at DESC);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
        preview_id TEXT NOT NULL, policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL,
        effective_hash TEXT NOT NULL, kind TEXT NOT NULL, batch_hash TEXT NOT NULL,
        actions TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(did, preview_id, kind, batch_hash)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
        approval_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, available_at);
      CREATE TABLE IF NOT EXISTS job_items (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        subject TEXT NOT NULL, action TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL, attempt INTEGER, error_code TEXT, updated_at TEXT NOT NULL,
        UNIQUE(job_id, subject, action)
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, did TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_controls (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        writes_enabled INTEGER NOT NULL DEFAULT 1,
        admissions_enabled INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 1,
        reason TEXT, updated_by TEXT NOT NULL DEFAULT 'bootstrap', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capacity_events (
        id TEXT PRIMARY KEY, did TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS capacity_events_kind_time ON capacity_events(kind,created_at);
      CREATE TABLE IF NOT EXISTS account_deletions (
        did TEXT PRIMARY KEY, mode TEXT NOT NULL, requested_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO service_controls(singleton,updated_at) VALUES(1,datetime('now'));
    `)
    this.sql.exec(ADMISSION_SCHEMA)
  }

  // Call only when the web process assumes ownership after startup. Auxiliary
  // operator and action-worker connections must not interrupt live reads.
  recoverInterruptedMeasurements() {
    const measurements = this.sql.prepare('SELECT id,report FROM yield_reports').all() as Array<{ id: string; report: string }>
    for (const row of measurements) {
      try {
        const report = JSON.parse(row.report)
        if (report.status !== 'running') continue
        report.status = 'interrupted'
        report.complete = false
        report.updated_at = now()
        report.interruption_reason = 'The service restarted before this measurement completed.'
        this.sql.prepare('UPDATE yield_reports SET report=? WHERE id=?').run(JSON.stringify(report), row.id)
      } catch { /* an invalid stored report remains inspectable as stored evidence */ }
    }
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.sql.exec('COMMIT'); return result }
    catch (err) { this.sql.exec('ROLLBACK'); throw err }
  }

  createSession(did: string) {
    const token = id('s')
    const csrf = id('csrf')
    const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    this.sql.prepare('INSERT INTO web_sessions VALUES (?,?,?,?,?)')
      .run(sha(token), did, sha(csrf), expires, now())
    return { token, csrf, expires }
  }

  session(token: string | undefined) {
    if (!token) return undefined
    const row = this.sql.prepare(`
      SELECT s.did, s.csrf_hash, s.expires_at, u.handle, u.display_name, u.pds, u.connected, u.permissions
      FROM web_sessions s JOIN users u ON u.did=s.did
      WHERE s.token_hash=? AND s.expires_at>?`).get(sha(token), now()) as Record<string, unknown> | undefined
    return row
  }

  deleteSession(token: string | undefined) {
    if (!token) return 0
    return this.sql.prepare('DELETE FROM web_sessions WHERE token_hash=?').run(sha(token)).changes
  }

  checkCsrf(session: Record<string, unknown>, token: string | undefined) {
    if (!token) return false
    const actual = Buffer.from(sha(token))
    const expected = Buffer.from(String(session.csrf_hash))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  upsertUser(profile: { did: string; handle: string; displayName?: string; pds?: string; scopes?: string[] }) {
    const at = now()
    this.sql.prepare(`
      INSERT INTO users(did,handle,display_name,pds,connected,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?)
      ON CONFLICT(did) DO UPDATE SET handle=excluded.handle,display_name=excluded.display_name,
        pds=excluded.pds,connected=1,updated_at=excluded.updated_at`)
      .run(profile.did, profile.handle, profile.displayName ?? null, profile.pds ?? null, at, at)
    this.sql.prepare('UPDATE users SET permissions=? WHERE did=?')
      .run(JSON.stringify(profile.scopes ?? []), profile.did)
  }

  audit(did: string | null, kind: string, detail: unknown) {
    this.sql.prepare('INSERT INTO audit(did,kind,detail,at) VALUES(?,?,?,?)')
      .run(did, kind, JSON.stringify(detail), now())
  }

  pruneExpiredUserData(at = new Date()) {
    const cutoff = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    return this.transaction(() => {
      const previews = this.sql.prepare(`DELETE FROM previews WHERE created_at<? AND NOT EXISTS
        (SELECT 1 FROM approvals a WHERE a.preview_id=previews.id AND a.did=previews.did)`).run(cutoff).changes
      const measurements = this.sql.prepare('DELETE FROM yield_reports WHERE created_at<?').run(cutoff).changes
      return { previews, measurements }
    })
  }

  close() { this.sql.close() }
}

export function asJson<T>(row: Record<string, unknown>, key: string): T {
  return JSON.parse(String(row[key])) as T
}
