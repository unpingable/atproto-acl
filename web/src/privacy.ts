import { createHmac, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AppDb } from './db.js'
import { sha } from './db.js'

const DAY = 24 * 60 * 60 * 1000
const TOMBSTONE_DAYS = 31

type DeleteMode = 'leave_mutes' | 'after_releases'

export type DeletionStanding = {
  activeJobs: number
  queuedJobs: number
  historicallyAttributedMutes: number
}

type PrivacyOptions = {
  dataDir: string
  tombstonePath: string
  tombstoneSecret: string
  now?: () => Date
}

/**
 * Owns the deliberately separate deletion ledger and complete per-user erasure.
 * The tombstone database must not be included in ordinary application backups.
 */
export class PrivacyManager {
  private readonly tombstones: DatabaseSync
  private readonly dataDir: string
  private readonly secret: string
  private readonly clock: () => Date
  private reconciled = false

  constructor(private readonly app: AppDb, options: PrivacyOptions) {
    this.dataDir = resolve(options.dataDir)
    const tombstonePath = resolve(options.tombstonePath)
    this.secret = options.tombstoneSecret
    this.clock = options.now ?? (() => new Date())
    if (this.secret.length < 32) throw new Error('deletion tombstone secret must contain at least 32 characters')
    const relation = relative(this.dataDir, tombstonePath)
    if (relation === '' || (!relation.startsWith('..') && relation !== '..')) {
      throw new Error('deletion tombstones must be stored outside the ordinary application data directory')
    }
    mkdirSync(dirname(tombstonePath), { recursive: true, mode: 0o700 })
    this.tombstones = new DatabaseSync(tombstonePath)
    chmodSync(tombstonePath, 0o600)
    this.tombstones.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS deletion_tombstones (
        keyed_did TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `)
    this.app.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_deletions (
        did TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        requested_at TEXT NOT NULL
      );
    `)
  }

  private keyedDid(did: string) {
    return createHmac('sha256', this.secret).update(did).digest('hex')
  }

  private statePath(did: string) {
    return resolve(this.dataDir, 'engine', sha(did).slice(0, 32) + '.db')
  }

  private removeEngineState(did: string) {
    const path = this.statePath(did)
    for (const suffix of ['', '-wal', '-shm', '.lock']) rmSync(path + suffix, { force: true })
  }

  private attributedMuteCount(did: string) {
    const path = this.statePath(did)
    if (!existsSync(path)) return 0
    let state: DatabaseSync | undefined
    try {
      state = new DatabaseSync(path, { readOnly: true })
      const row = state.prepare("SELECT count(*) AS count FROM ledger WHERE status='attributed'").get() as { count: number | bigint }
      return Number(row.count)
    } catch {
      throw new Error('mute ownership records are unavailable; deletion cannot infer that release review is complete')
    } finally {
      state?.close()
    }
  }

  standing(did: string): DeletionStanding {
    const row = this.app.sql.prepare(`SELECT
      sum(CASE WHEN status='running' THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN status IN ('queued','awaiting_reconnect','paused_by_operator') THEN 1 ELSE 0 END) AS queued
      FROM jobs WHERE did=?`).get(did) as { active: number | null; queued: number | null }
    return {
      activeJobs: Number(row.active ?? 0),
      queuedJobs: Number(row.queued ?? 0),
      historicallyAttributedMutes: this.attributedMuteCount(did),
    }
  }

  deletionRequested(did: string) {
    return Boolean(this.app.sql.prepare('SELECT 1 FROM account_deletions WHERE did=?').get(did))
  }

  /**
   * Establishes the worker-visible refusal before account data can be erased.
   * A currently running effect prevents erasure until its standing is durable.
   */
  requestDeletion(did: string, mode: DeleteMode): DeletionStanding {
    if (!['leave_mutes', 'after_releases'].includes(mode)) throw new Error('unsupported deletion mode')
    this.app.transaction(() => {
      const exists = this.app.sql.prepare('SELECT 1 FROM users WHERE did=?').get(did)
      if (!exists) throw new Error('resource not found')
      const at = this.clock().toISOString()
      this.app.sql.prepare(`INSERT INTO account_deletions(did,mode,requested_at) VALUES(?,?,?)
        ON CONFLICT(did) DO UPDATE SET mode=excluded.mode,requested_at=excluded.requested_at`).run(did, mode, at)
      this.app.sql.prepare(`UPDATE jobs SET cancel_requested=1,
        status=CASE WHEN status IN ('queued','awaiting_reconnect','paused_by_operator') THEN 'cancelled' ELSE status END,
        error_code=CASE WHEN status IN ('queued','awaiting_reconnect','paused_by_operator') THEN 'account_deletion' ELSE error_code END,
        updated_at=? WHERE did=? AND status IN ('queued','awaiting_reconnect','paused_by_operator','running')`).run(at, did)
    })
    return this.standing(did)
  }

  /** Completes deletion only after every in-flight effect has reached durable standing. */
  completeDeletion(did: string) {
    const requested = this.app.sql.prepare('SELECT mode FROM account_deletions WHERE did=?').get(did) as { mode: DeleteMode } | undefined
    if (!requested) throw new Error('account deletion has not been requested')
    const standing = this.standing(did)
    if (standing.activeJobs) throw new Error('account actions are still finishing; retry deletion after they stop')
    if (requested.mode === 'after_releases' && standing.historicallyAttributedMutes) {
      throw new Error('review or retain the remaining release candidates before deleting data')
    }
    this.writeTombstone(did)
    this.purgeDid(did)
  }

  private writeTombstone(did: string) {
    const deleted = this.clock()
    const expires = new Date(deleted.getTime() + TOMBSTONE_DAYS * DAY)
    this.tombstones.prepare(`INSERT INTO deletion_tombstones(keyed_did,deleted_at,expires_at) VALUES(?,?,?)
      ON CONFLICT(keyed_did) DO UPDATE SET deleted_at=excluded.deleted_at,expires_at=excluded.expires_at`)
      .run(this.keyedDid(did), deleted.toISOString(), expires.toISOString())
  }

  private purgeDid(did: string) {
    this.app.transaction(() => {
      // Tables without a user foreign key must be removed explicitly. The rest
      // are deleted by the users ON DELETE CASCADE boundary.
      this.app.sql.prepare('DELETE FROM oauth_sessions WHERE did=?').run(did)
      this.app.sql.prepare('DELETE FROM audit WHERE did=?').run(did)
      this.app.sql.prepare('DELETE FROM capacity_events WHERE did=?').run(did)
      this.app.sql.prepare('DELETE FROM oauth_attempts WHERE expected_did=?').run(did)
      this.app.sql.prepare('DELETE FROM invites WHERE redeemed_did=?').run(did)
      this.app.sql.prepare('DELETE FROM admissions WHERE did=?').run(did)
      this.app.sql.prepare('DELETE FROM account_deletions WHERE did=?').run(did)
      this.app.sql.prepare('DELETE FROM users WHERE did=?').run(did)
    })
    this.removeEngineState(did)
  }

  /**
   * Must run after opening a restored application database and before binding
   * the HTTP listener. Every retained deletion is reapplied to restored data.
   */
  reconcileRestore() {
    this.reconciled = false
    this.expireTombstones()
    const candidates = new Set<string>()
    const candidateQueries = [
      'SELECT DISTINCT did FROM users WHERE did IS NOT NULL',
      'SELECT DISTINCT did FROM oauth_sessions WHERE did IS NOT NULL',
      'SELECT DISTINCT did FROM audit WHERE did IS NOT NULL',
      'SELECT DISTINCT did FROM account_deletions WHERE did IS NOT NULL',
      'SELECT DISTINCT did FROM admissions WHERE did IS NOT NULL',
      'SELECT DISTINCT redeemed_did AS did FROM invites WHERE redeemed_did IS NOT NULL',
      'SELECT DISTINCT expected_did AS did FROM oauth_attempts WHERE expected_did IS NOT NULL',
      'SELECT DISTINCT did FROM capacity_events WHERE did IS NOT NULL',
    ]
    for (const query of candidateQueries) {
      const rows = this.app.sql.prepare(query).all() as Array<{ did: string }>
      for (const row of rows) candidates.add(row.did)
    }
    const retained = (this.tombstones.prepare('SELECT keyed_did,deleted_at FROM deletion_tombstones WHERE expires_at>?')
      .all(this.clock().toISOString()) as Array<{ keyed_did: string; deleted_at: string }>)
      .map(row => ({ key: Buffer.from(row.keyed_did), deletedAt: row.deleted_at }))
    for (const did of candidates) {
      const keyed = Buffer.from(this.keyedDid(did))
      const deletion = retained.find(value => value.key.length === keyed.length && timingSafeEqual(value.key, keyed))
      if (!deletion) continue
      const user = this.app.sql.prepare('SELECT created_at FROM users WHERE did=?').get(did) as { created_at: string } | undefined
      // A user may deliberately sign up again after deleting. The tombstone
      // still purges older backup generations but must not erase new consent.
      if (user && user.created_at > deletion.deletedAt) continue
      this.purgeDid(did)
    }
    this.reconciled = true
  }

  assertReady() {
    if (!this.reconciled) throw new Error('deletion restore reconciliation has not completed')
  }

  expireTombstones() {
    this.tombstones.prepare('DELETE FROM deletion_tombstones WHERE expires_at<=?').run(this.clock().toISOString())
  }

  close() { this.tombstones.close() }
}
