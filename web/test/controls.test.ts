import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import { ServiceControls, CapacityError } from '../src/controls.js'
import { AppDb } from '../src/db.js'

function setup(overrides: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'acl-controls-'))
  const config = loadConfig({
    ATPROTO_ACL_ORIGIN: 'http://127.0.0.1:8426', ATPROTO_ACL_FIXTURE_MODE: '1',
    ATPROTO_ACL_DATA_DIR: dataDir, ATPROTO_ACL_ADMISSION_MODE: 'invite', ...overrides,
  })
  const db = new AppDb(join(dataDir, 'app.db'))
  db.upsertUser({ did: 'did:plc:user', handle: 'user.test' })
  db.sql.prepare("INSERT INTO admissions(did,source,writes_enabled,created_at,updated_at) VALUES('did:plc:user','invite',1,datetime('now'),datetime('now'))").run()
  return { db, controls: new ServiceControls(db, config) }
}

test('durable write gate and per-account eligibility both fail closed', () => {
  const { db, controls } = setup()
  assert.doesNotThrow(() => controls.requireAccountWrite('did:plc:user'))
  db.sql.prepare("UPDATE admissions SET writes_enabled=0 WHERE did='did:plc:user'").run()
  assert.throws(() => controls.requireAccountWrite('did:plc:user'), /not enabled/)
  db.sql.prepare("UPDATE admissions SET writes_enabled=1 WHERE did='did:plc:user'").run()
  controls.set('writes', false, 'test', 'emergency stop')
  assert.throws(() => controls.reserveEffect('did:plc:user'), /paused/)
  db.sql.prepare('DELETE FROM service_controls').run()
  assert.throws(() => controls.requireWrite(), /unavailable/)
  db.close()
})

test('global and per-account acquisition starts are bounded', async () => {
  const { db, controls } = setup({ ATPROTO_ACL_ACQUISITION_STARTS_PER_DID_HOUR: '1' })
  const lease = await controls.beginAcquisition('did:plc:user')
  controls.finishAcquisition(lease)
  await assert.rejects(() => controls.beginAcquisition('did:plc:user'), CapacityError)
  db.close()
})

test('thirty-day cleanup removes only unapproved previews and measurements', () => {
  const { db } = setup()
  const old = '2026-08-01T00:00:00.000Z'
  const fresh = '2026-09-08T00:00:00.000Z'
  db.sql.prepare("INSERT INTO policies VALUES('policy','did:plc:user','Policy','version: 1',1,'hash',0,?,?)").run(old, old)
  const insertPreview = db.sql.prepare(`INSERT INTO previews VALUES(?,?,?,?,?,?,?,?,?,?)`)
  insertPreview.run('approved','did:plc:user','policy',1,'effective','{}','{}',1,old,fresh)
  insertPreview.run('expired','did:plc:user','policy',1,'effective','{}','{}',1,old,fresh)
  db.sql.prepare(`INSERT INTO approvals
    (id,did,preview_id,policy_id,policy_revision,effective_hash,kind,batch_hash,actions,status,created_at)
    VALUES('approval','did:plc:user','approved','policy',1,'effective','apply','batch','[]','approved',?)`).run(old)
  db.sql.prepare("INSERT INTO yield_reports VALUES('old-yield','did:plc:user','p','a','{}',?)").run(old)
  db.sql.prepare("INSERT INTO yield_reports VALUES('fresh-yield','did:plc:user','p','a','{}',?)").run(fresh)
  assert.deepEqual(db.pruneExpiredUserData(new Date('2026-09-09T00:00:00Z')), { previews: 1, measurements: 1 })
  assert.deepEqual((db.sql.prepare('SELECT id FROM previews ORDER BY id').all() as Array<{id:string}>).map(row => row.id), ['approved'])
  assert.deepEqual((db.sql.prepare('SELECT id FROM yield_reports').all() as Array<{id:string}>).map(row => row.id), ['fresh-yield'])
  db.close()
})
