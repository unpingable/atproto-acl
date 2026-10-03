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

// Exercise the packaged bridge with the hosted structural-lineage contract too.
// Quenching a thread must leave the same actor's other thread alone and must
// never turn unknown lineage into an actor action or an approved write.
const root = 'at://did:plc:subject/app.bsky.feed.post/root'
const quenchService = new AclService(db, engine, accounts, () => ({
  subjects: ['did:plc:subject'], identities: { [did]: did },
  observations: [], coverage: [],
  discovery: [{ source: 'feed_exposure', surface: 'timeline', complete: true,
    exposure_complete: true, subjects: ['did:plc:subject'], exposures: [], items: [
      { position: 0, post_uri: 'at://did:plc:subject/app.bsky.feed.post/reply',
        post_cid: 'cid-reply', author_did: 'did:plc:subject', root_uri: root,
        lineage_uri: root, lineage_status: 'reply' },
      { position: 1, post_uri: 'at://did:plc:subject/app.bsky.feed.post/elsewhere',
        post_cid: 'cid-elsewhere', author_did: 'did:plc:subject',
        root_uri: 'at://did:plc:subject/app.bsky.feed.post/elsewhere',
        lineage_uri: 'at://did:plc:subject/app.bsky.feed.post/elsewhere', lineage_status: 'root' },
      { position: 2, post_uri: 'at://did:plc:subject/app.bsky.feed.post/unknown',
        post_cid: 'cid-unknown', author_did: 'did:plc:subject', lineage_status: 'unknown' },
    ] }],
  remote: { 'did:plc:subject': { known: true, direct: false, muted: false } },
}))
const quenchPolicy = policy
  .replace('  - type: explicit_dids\n    dids: [did:plc:subject]',
    '  - type: feed_exposure\n    surface: timeline\n    limit: 10\n    followed: review')
  .replace('keep_muted: []', `keep_muted: []\nattention:\n  suppress_lineages:\n    - ${root}`)
const quenchId = quenchService.savePolicy(did, 'Fresh artifact thread policy', quenchPolicy)
const quenchPreview = await quenchService.preview(did, quenchId, undefined, '2026-09-10T01:00:00Z')
assert.deepEqual(quenchPreview.receipt.lineage_rows?.map(row => row.outcome), ['suppress', 'allow', 'indeterminate'])
assert(quenchPreview.receipt.lineage_rows?.every(row => row.effect === 'local_feed_preview_only'))
assert(quenchPreview.receipt.rows.every(row => row.action !== 'mute'))
assert.equal((db.sql.prepare('SELECT count(*) count FROM approvals').get() as { count: number }).count, 0)
assert.equal((db.sql.prepare('SELECT count(*) count FROM jobs').get() as { count: number }).count, 0)

const brokenConfig = { ...config, dataDir: mkdtempSync(join(tmpdir(), 'atproto-acl-broken-')), python: '/missing/release/venv/bin/python' }
const brokenDb = new AppDb(join(brokenConfig.dataDir, 'app.db'))
const brokenEngine = new Engine(brokenConfig)
const brokenService = new AclService(brokenDb, brokenEngine, accounts)
const auth = Object.assign(accounts, {
  metadata: {}, jwks: {}, clearSession: async () => {},
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
