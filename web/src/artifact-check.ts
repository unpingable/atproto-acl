import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDb } from './db.js'
import { Engine } from './engine.js'
import { loadConfig } from './config.js'
import { AclService } from './service.js'
import { createApp } from './server.js'

const did = 'did:plc:fresh-artifact-account'
const policy = `version: 1
account: ${did}
providers:
  fixture:
    type: fixture
    did: did:plc:fixture
    measurements:
      score: score
sources:
  - type: explicit_dids
    dids: [did:plc:subject]
rules:
  - name: artifact-check
    disposition: quarantine
    when:
      source: fixture
      property: score
      op: gt
      value: 0
exempt: []
allow: []
keep_muted: []
`

const dataDir = mkdtempSync(join(tmpdir(), 'atproto-acl-artifact-'))
const config = loadConfig({
  ...process.env,
  ATPROTO_ACL_ORIGIN: 'http://127.0.0.1:8426',
  ATPROTO_ACL_DATA_DIR: dataDir,
  ATPROTO_ACL_FIXTURE_MODE: '1',
  ATPROTO_ACL_WORKER: '0',
  ATPROTO_ACL_SESSION_SECRET: 'artifact-check-session-secret-at-least-32-bytes',
})
const db = new AppDb(join(dataDir, 'app.db'))
db.upsertUser({ did, handle: 'fresh-artifact.test' })
const engine = new Engine(config)
const health = await engine.health(true)
assert.equal(health.bridge_schema, 1)
const accounts = { restore: async () => { throw new Error('artifact check must remain offline') } }
const service = new AclService(db, engine, accounts, () => ({
  subjects: ['did:plc:subject'], identities: { [did]: did },
  observations: [{
    provider: 'did:plc:fixture', subject: 'did:plc:subject', property: 'score', value: 1,
    observed_at: '2026-09-10T00:00:00Z', expires_at: '2026-09-11T00:00:00Z',
  }],
  coverage: [{
    provider: 'did:plc:fixture', subject: 'did:plc:subject', complete: true,
    checked_at: '2026-09-10T00:00:00Z',
  }],
  discovery: [{ source: 'explicit_dids', subjects: ['did:plc:subject'], complete: true }],
  remote: { 'did:plc:subject': { known: true, direct: false, muted: false } },
}))
await engine.validate(policy, did)
const policyId = service.savePolicy(did, 'Fresh artifact policy', policy)
const preview = await service.preview(did, policyId, undefined, '2026-09-10T01:00:00Z')
assert.equal(preview.receipt.rows.find(row => row.subject === 'did:plc:subject')?.action, 'mute')
assert.deepEqual(await engine.overrides(did), { exempt: [], allow: [], keep_muted: [] })

const brokenConfig = { ...config, dataDir: mkdtempSync(join(tmpdir(), 'atproto-acl-broken-')), python: '/missing/release/venv/bin/python' }
const brokenDb = new AppDb(join(brokenConfig.dataDir, 'app.db'))
const brokenEngine = new Engine(brokenConfig)
const brokenService = new AclService(brokenDb, brokenEngine, accounts)
const auth = Object.assign(accounts, {
  metadata: {}, jwks: {},
  authorize: async () => new URL('http://127.0.0.1/'),
  callback: async () => { throw new Error('offline') },
})
const server = await createApp(brokenConfig, brokenDb, brokenService, auth)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const address = server.address()
  assert(address && typeof address === 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`)
  const body = await response.text()
  assert.equal(response.status, 503)
  assert.match(body, /policy service is temporarily unavailable/i)
  assert.match(body, /Diagnostic ID: [0-9a-f-]{36}/)
  assert.doesNotMatch(body, /ENOENT|\/missing\/release|venv\/bin\/python/)
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  brokenDb.close()
}
