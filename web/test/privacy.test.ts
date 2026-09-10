import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { AppDb, sha } from '../src/db.js'
import { PrivacyManager } from '../src/privacy.js'

const secret = 'fixture-deletion-tombstone-secret-at-least-32-bytes'

function fixture(clock = new Date('2026-09-09T12:00:00Z')) {
  const root = mkdtempSync(join(tmpdir(), 'acl-privacy-'))
  const dataDir = join(root, 'ordinary-data')
  const protectedDir = join(root, 'deletion-ledger')
  const db = new AppDb(join(dataDir, 'app.db'))
  const now = { value: clock }
  const privacy = new PrivacyManager(db, {
    dataDir,
    tombstonePath: join(protectedDir, 'tombstones.db'),
    tombstoneSecret: secret,
    now: () => now.value,
  })
  privacy.reconcileRestore()
  return { root, dataDir, protectedDir, db, privacy, now }
}

function addUserData(db: AppDb, dataDir: string, did = 'did:plc:delete-me') {
  db.upsertUser({ did, handle: 'delete-me.test', displayName: 'Delete Me', pds: 'https://pds.test' })
  const at = '2026-09-09T12:00:00Z'
  db.sql.prepare('UPDATE users SET created_at=? WHERE did=?').run('2026-09-08T12:00:00Z', did)
  db.sql.prepare('INSERT INTO oauth_sessions VALUES(?,?,?)').run(did, '{"private":"credential"}', at)
  db.createSession(did)
  db.sql.prepare('INSERT INTO policies VALUES(?,?,?,?,?,?,?,?,?)').run('policy', did, 'Policy', 'version: 1', 1, 'hash', 1, at, at)
  db.sql.prepare('INSERT INTO previews VALUES(?,?,?,?,?,?,?,?,?,?)').run('preview', did, 'policy', 1, 'effective', '{}', '{}', 1, at, '2026-10-09T12:00:00Z')
  db.sql.prepare('INSERT INTO yield_reports VALUES(?,?,?,?,?,?)').run('yield', did, 'policy-hash', 'acquisition-hash', '{}', at)
  db.sql.prepare(`INSERT INTO approvals
    (id,did,preview_id,policy_id,policy_revision,effective_hash,kind,batch_hash,actions,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('approval', did, 'preview', 'policy', 1, 'effective', 'apply', 'batch', '[]', 'approved', at)
  db.sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run('job', did, 'approval', 'completed', 0, at, null, at, at)
  db.sql.prepare('INSERT INTO job_items VALUES(?,?,?,?,?,?,?,?,?)').run('item', 'job', 'did:plc:subject', 'mute', 'fingerprint', 'confirmed', 1, null, at)
  db.audit(did, 'private_history', { subject: 'did:plc:subject' })
  db.sql.prepare('INSERT INTO admissions VALUES(?,?,?,?,?)').run(did, 'invite', 0, at, at)
  db.sql.prepare('INSERT INTO invites VALUES(?,?,?,?,?,?)').run('invite', 'code-hash', '2026-10-09T12:00:00Z', at, did, at)
  db.sql.prepare('INSERT INTO oauth_attempts VALUES(?,?,?,?,?,?,?,?,?)').run('state-hash', 'correlation', 'reconnect', null, did, 'started', '2026-10-09T12:00:00Z', at, at)
  db.sql.prepare('INSERT INTO capacity_events VALUES(?,?,?,?,?,?)').run('capacity', did, 'acquisition', 'completed', at, at)
  const engineDir = join(dataDir, 'engine')
  mkdirSync(engineDir, { recursive: true })
  const enginePath = join(engineDir, sha(did).slice(0, 32) + '.db')
  const engine = new DatabaseSync(enginePath)
  engine.exec('CREATE TABLE ledger(did TEXT PRIMARY KEY,status TEXT NOT NULL,detail TEXT NOT NULL)')
  engine.prepare('INSERT INTO ledger VALUES(?,?,?)').run('did:plc:subject', 'attributed', '{}')
  engine.close()
  writeFileSync(enginePath + '.lock', '')
  return enginePath
}

test('deletion refuses active effects and cancels work that has not started', () => {
  const { db, privacy } = fixture()
  addUserData(db, join(dirnameForDb(db), 'unused'))
  // Use records without relying on the engine fixture for this standing check.
  db.sql.prepare("UPDATE jobs SET status='running' WHERE id='job'").run()
  const at = '2026-09-09T12:00:00Z'
  db.sql.prepare(`INSERT INTO approvals
    (id,did,preview_id,policy_id,policy_revision,effective_hash,kind,batch_hash,actions,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('approval-queued', 'did:plc:delete-me', 'preview', 'policy', 1, 'effective', 'apply', 'batch-2', '[]', 'approved', at)
  db.sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run('job-queued', 'did:plc:delete-me', 'approval-queued', 'queued', 0, at, null, at, at)
  const standing = privacy.requestDeletion('did:plc:delete-me', 'leave_mutes')
  assert.equal(standing.activeJobs, 1)
  assert.equal((db.sql.prepare("SELECT status FROM jobs WHERE id='job-queued'").get() as any).status, 'cancelled')
  assert.equal(privacy.deletionRequested('did:plc:delete-me'), true)
  assert.throws(() => privacy.completeDeletion('did:plc:delete-me'), /still finishing/)
  privacy.close(); db.close()
})

// AppDb deliberately does not expose its path. This helper is unused by erasure
// assertions; it keeps the active-job fixture independent of a real engine file.
function dirnameForDb(_db: AppDb) { return mkdtempSync(join(tmpdir(), 'acl-engine-unused-')) }

test('release-first deletion refuses while historically attributed mutes remain', () => {
  const { dataDir, db, privacy } = fixture()
  addUserData(db, dataDir)
  assert.equal(privacy.standing('did:plc:delete-me').historicallyAttributedMutes, 1)
  privacy.requestDeletion('did:plc:delete-me', 'after_releases')
  assert.throws(() => privacy.completeDeletion('did:plc:delete-me'), /review or retain/)
  assert.ok(db.sql.prepare('SELECT 1 FROM users WHERE did=?').get('did:plc:delete-me'))
  privacy.close(); db.close()
})

test('leave-mutes deletion removes all per-user application and derived engine state', () => {
  const { dataDir, protectedDir, db, privacy } = fixture()
  const did = 'did:plc:delete-me'
  const enginePath = addUserData(db, dataDir, did)
  privacy.requestDeletion(did, 'leave_mutes')
  privacy.completeDeletion(did)
  const checks: Array<[string, string, string?]> = [
    ['users', 'did'], ['web_sessions', 'did'], ['oauth_sessions', 'did'], ['policies', 'did'],
    ['previews', 'did'], ['yield_reports', 'did'], ['approvals', 'did'], ['jobs', 'did'],
    ['job_items', 'job_id', 'job'], ['audit', 'did'], ['account_deletions', 'did'],
    ['admissions', 'did'], ['invites', 'redeemed_did'], ['oauth_attempts', 'expected_did'], ['capacity_events', 'did'],
  ]
  for (const [table, column, value = did] of checks) {
    const row = db.sql.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column}=?`).get(value) as any
    assert.equal(Number(row.count), 0, table)
  }
  assert.equal(existsSync(enginePath), false)
  assert.equal(existsSync(enginePath + '.lock'), false)
  privacy.close(); db.close()
  const bytes = readFileSync(join(protectedDir, 'tombstones.db'))
  assert.equal(bytes.includes(Buffer.from(did)), false, 'the deletion store must not contain the plaintext DID')
})

test('every retained backup generation reapplies deletion before readiness', () => {
  const live = fixture()
  const did = 'did:plc:delete-me'
  const liveEngine = addUserData(live.db, live.dataDir, did)
  live.db.sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const backups = [1, 20, 30].map(day => ({
    app: join(live.root, `backup-day-${day}.db`),
    engine: join(live.root, `backup-day-${day}-engine.db`),
  }))
  for (const backup of backups) {
    copyFileSync(join(live.dataDir, 'app.db'), backup.app)
    copyFileSync(liveEngine, backup.engine)
  }
  live.privacy.requestDeletion(did, 'leave_mutes')
  live.privacy.completeDeletion(did)
  live.privacy.close(); live.db.close()

  for (const [index, backup] of backups.entries()) {
    const restoredData = join(live.root, `restored-${index}`)
    mkdirSync(join(restoredData, 'engine'), { recursive: true })
    const restoredPath = join(restoredData, 'app.db')
    const restoredEngine = join(restoredData, 'engine', sha(did).slice(0, 32) + '.db')
    copyFileSync(backup.app, restoredPath)
    copyFileSync(backup.engine, restoredEngine)
    const restored = new AppDb(restoredPath)
    const clock = new Date(`2026-10-${String(index + 7).padStart(2, '0')}T12:00:00Z`)
    const manager = new PrivacyManager(restored, {
      dataDir: restoredData,
      tombstonePath: join(live.protectedDir, 'tombstones.db'),
      tombstoneSecret: secret,
      now: () => clock,
    })
    assert.throws(() => manager.assertReady(), /has not completed/)
    manager.reconcileRestore()
    manager.assertReady()
    assert.equal(restored.sql.prepare('SELECT 1 FROM users WHERE did=?').get(did), undefined)
    assert.equal(restored.sql.prepare('SELECT 1 FROM oauth_sessions WHERE did=?').get(did), undefined)
    assert.equal(existsSync(restoredEngine), false)
    manager.close(); restored.close()
  }
})

test('tombstones expire only after the 31-day restore window', () => {
  const state = fixture()
  const did = 'did:plc:delete-me'
  addUserData(state.db, state.dataDir, did)
  state.privacy.requestDeletion(did, 'leave_mutes')
  state.privacy.completeDeletion(did)
  state.privacy.close(); state.db.close()

  const restoredPath = join(state.root, 'late-restore.db')
  const restored = new AppDb(restoredPath)
  restored.upsertUser({ did, handle: 'restored.test' })
  state.now.value = new Date('2026-10-10T12:00:01Z')
  const manager = new PrivacyManager(restored, {
    dataDir: join(state.root, 'late-data'),
    tombstonePath: join(state.protectedDir, 'tombstones.db'),
    tombstoneSecret: secret,
    now: () => state.now.value,
  })
  manager.reconcileRestore()
  assert.ok(restored.sql.prepare('SELECT 1 FROM users WHERE did=?').get(did), 'expired tombstone is removed after all capable backups have aged out')
  manager.close(); restored.close()
})

test('a deliberate sign-up after deletion survives while older backups remain suppressed', () => {
  const state = fixture()
  const did = 'did:plc:delete-me'
  addUserData(state.db, state.dataDir, did)
  state.privacy.requestDeletion(did, 'leave_mutes')
  state.privacy.completeDeletion(did)
  state.privacy.close(); state.db.close()

  state.now.value = new Date('2026-09-10T12:00:00Z')
  const returnedData = join(state.root, 'returned-data')
  const returned = new AppDb(join(returnedData, 'app.db'))
  returned.upsertUser({ did, handle: 'returned.test' })
  returned.sql.prepare('UPDATE users SET created_at=? WHERE did=?').run(state.now.value.toISOString(), did)
  const manager = new PrivacyManager(returned, {
    dataDir: returnedData,
    tombstonePath: join(state.protectedDir, 'tombstones.db'),
    tombstoneSecret: secret,
    now: () => state.now.value,
  })
  manager.reconcileRestore()
  manager.assertReady()
  assert.ok(returned.sql.prepare('SELECT 1 FROM users WHERE did=?').get(did))
  manager.close(); returned.close()
})
