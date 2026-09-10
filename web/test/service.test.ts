import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AppDb, sha as shaForTest } from '../src/db.js'
import { Engine } from '../src/engine.js'
import { AclService, feedAcquisitionFailureReason } from '../src/service.js'
import { Worker } from '../src/worker.js'
import { bsky38Policy } from '../src/policy-editor.js'
import { loadConfig } from '../src/config.js'
import { ServiceControls } from '../src/controls.js'
import { acquisition, FakeAccounts, observations, policy } from './fixtures.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'acl-web-'))
  const config = loadConfig({
    ATPROTO_ACL_ORIGIN: 'http://127.0.0.1:8426', ATPROTO_ACL_PORT: '8426',
    ATPROTO_ACL_DATA_DIR: dir, ATPROTO_ACL_PYTHON: process.env.ATPROTO_ACL_TEST_PYTHON ?? 'python3',
    ATPROTO_ACL_SESSION_SECRET: 'fixture-session-secret-at-least-32-bytes',
    ATPROTO_ACL_FIXTURE_MODE: '1', ATPROTO_ACL_WORKER: '0',
  })
  const db = new AppDb(join(dir, 'app.db'))
  const accounts = new FakeAccounts()
  accounts.add('did:plc:user1', 'user1.test')
  accounts.add('did:plc:user2', 'user2.test')
  for (const did of accounts.profiles.keys()) {
    db.upsertUser(accounts.profiles.get(did)!)
    db.sql.prepare("INSERT INTO admissions(did,source,writes_enabled,created_at,updated_at) VALUES(?, 'allowlist', 1, datetime('now'), datetime('now'))").run(did)
    for (const subject of ['did:plc:alice','did:plc:bob','did:plc:carol']) {
      accounts.remote.get(did)!.set(subject, { known: true, direct: false, muted: false })
    }
  }
  const controls = new ServiceControls(db, config)
  const service = new AclService(db, new Engine(config), accounts,
    did => acquisition(accounts, did, observations), undefined, controls)
  return { db, accounts, service, controls, worker: new Worker(db, service, undefined, controls) }
}

const feedPolicy = (did: string) => `version: 1
account: ${did}
providers:
  activity:
    type: fixture
    did: did:plc:activity
    measurements:
      posts_per_day: posts per day
sources:
  - type: feed_exposure
    surface: timeline
    limit: 500
    followed: review
  - type: feed_exposure
    surface: generator
    feed_uri: at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot
    limit: 500
    followed: review
rules:
  - name: heavy-posting
    disposition: quarantine
    when:
      source: activity
      property: posts_per_day
      op: gt
      value: 20
exempt: []
allow: []
keep_muted: []
`

test('feed acquisition errors retain safe actionable classifications', () => {
  assert.equal(feedAcquisitionFailureReason(Object.assign(new Error('forbidden'), { status: 403 })),
    'Reconnect your account to grant access to this feed.')
  assert.equal(feedAcquisitionFailureReason(Object.assign(new Error('slow down'), { status: 429 })),
    'The feed request was rate limited. Try again later.')
  assert.equal(feedAcquisitionFailureReason(new Error('ATProto request budget exhausted')),
    'Feed acquisition reached its request limit.')
  assert.equal(feedAcquisitionFailureReason(new Error('request timeout')),
    'Feed acquisition reached its time limit.')
  assert.equal(feedAcquisitionFailureReason(new Error('https://host/private?token=secret exploded')),
    'The feed source is temporarily unavailable.')
})

test('a missing policy interpreter returns only an opaque browser-safe diagnostic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acl-missing-python-'))
  const config = loadConfig({
    ATPROTO_ACL_ORIGIN: 'http://127.0.0.1:8426', ATPROTO_ACL_PORT: '8426',
    ATPROTO_ACL_DATA_DIR: dir, ATPROTO_ACL_PYTHON: '/opt/private/missing/python',
    ATPROTO_ACL_SESSION_SECRET: 'fixture-session-secret-at-least-32-bytes',
    ATPROTO_ACL_FIXTURE_MODE: '1', ATPROTO_ACL_WORKER: '0',
  })
  const logged: unknown[][] = []
  await assert.rejects(new Engine(config, undefined, (...items) => { logged.push(items) }).health(true), error => {
    assert.match(String(error), /policy service is temporarily unavailable/i)
    assert.match(String(error), /Diagnostic ID: [0-9a-f-]{36}/)
    assert.doesNotMatch(String(error), /ENOENT|\/opt\/private/)
    return true
  })
  assert.match(String(logged[0]?.[0]), /policy-service:[0-9a-f-]{36}/)
  assert.match(String(logged[0]?.[0]), /interpreter spawn failed/)
  assert.match(String(logged[0]?.[1]), /ENOENT|spawn/)
  assert.match(String(logged[0]?.[1]), /\/opt\/private\/missing\/python/)
})

test('a running measurement survives restart as explicitly interrupted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acl-measurement-recovery-'))
  const path = join(dir, 'app.db')
  const db = new AppDb(path)
  db.upsertUser({ did: 'did:plc:user1', handle: 'user1.test' })
  const running = {
    schema: 2, status: 'running', complete: false, account: { did: 'did:plc:user1' },
    sources: [{ surface: 'timeline', completed: 200, total: 500 }],
  }
  db.sql.prepare(`INSERT INTO yield_reports
    (id,did,policy_hash,acquisition_hash,report,created_at) VALUES(?,?,?,?,?,?)`).run(
    'yield_running', 'did:plc:user1', 'policy', '', JSON.stringify(running), '2026-09-09T12:00:00Z',
  )
  db.close()
  const recovered = new AppDb(path)
  recovered.recoverInterruptedMeasurements()
  const row = recovered.sql.prepare('SELECT report FROM yield_reports WHERE id=?').get('yield_running') as { report: string }
  const report = JSON.parse(row.report)
  assert.equal(report.status, 'interrupted')
  assert.equal(report.complete, false)
  assert.equal(report.sources[0].completed, 200)
  assert.match(report.interruption_reason, /restarted/)
  recovered.close()
})

test('feed acquisition unions surfaces and records conclusive relationships', async () => {
  const { db, accounts, service, controls } = setup()
  const did = 'did:plc:user1'
  accounts.following.get(did)!.add('did:plc:alice')
  const live = new AclService(db, service.engine, accounts)
  const acquisition = await live.acquire(did, feedPolicy(did))
  assert.equal(acquisition.discovery.length, 2)
  assert.deepEqual((acquisition.discovery as any[]).map(item => item.surface), ['timeline', 'generator'])
  assert.equal((acquisition.discovery[0] as any).items_sampled, 3)
  assert.equal(acquisition.remote['did:plc:alice']?.relationship, 'following')
  assert.equal(acquisition.remote['did:plc:bob']?.relationship, 'not_following')
  db.close()
})

test('a fully acquired configured feed sample is complete without claiming source exhaustion', async () => {
  const { db, accounts, service } = setup()
  const did = 'did:plc:user1'
  const boundedAccounts = {
    restore: async (actor: string) => {
      const client = await accounts.restore(actor)
      return {
        ...client,
        feed: async (source: any, limit: number) => ({
          ...(await client.feed(source, limit)),
          complete: false,
          reason: 'configured feed item limit reached',
        }),
      }
    },
  }
  const live = new AclService(db, service.engine, boundedAccounts)
  const acquired = await live.acquire(did, feedPolicy(did).replaceAll('limit: 500', 'limit: 3'))
  for (const source of acquired.discovery as any[]) {
    assert.equal(source.complete, true)
    assert.equal(source.source_exhausted, false)
    assert.equal(source.sample_bound_reached, true)
    assert.equal(source.items_sampled, 3)
    assert.equal(source.requested_items, 3)
    assert.equal(source.reason, '')
  }
  db.close()
})

test('followed matches require their own exact approval and execute from the saved sample', async () => {
  const { db, accounts, service, worker } = setup()
  const did = 'did:plc:user1'
  accounts.following.get(did)!.add('did:plc:alice')
  const subjects = ['did:plc:alice', 'did:plc:bob', 'did:plc:carol']
  const state = accounts.remote.get(did)!
  ;(service as any).fixtureAcquisition = () => ({
    subjects,
    identities: { [did]: did },
    observations: subjects.map(subject => ({
      provider: 'did:plc:activity', subject, property: 'posts_per_day', value: 24,
      observed_at: '2026-09-08T12:00:00Z', expires_at: '2026-09-10T12:00:00Z',
    })),
    coverage: subjects.map(subject => ({ provider: 'did:plc:activity', subject, complete: true,
      checked_at: '2026-09-08T12:01:00Z', reason: '' })),
    discovery: [{ source: 'feed_exposure', surface: 'timeline', subjects, complete: true }],
    remote: Object.fromEntries(subjects.map(subject => [subject, {
      ...(state.get(subject) ?? { known: true, direct: false, muted: false }),
      relationship: subject === 'did:plc:alice' ? 'following' : subject === 'did:plc:bob' ? 'not_following' : 'unknown',
    }])),
  })
  const policyId = service.savePolicy(did, 'feed', feedPolicy(did))
  const preview = await service.preview(did, policyId, undefined, '2026-09-08T12:02:00Z')
  const rows = Object.fromEntries(preview.receipt.rows.map(row => [row.subject, row]))
  assert.equal(rows['did:plc:alice'].action, 'follow_review_candidate')
  assert.equal(rows['did:plc:bob'].action, 'mute')
  assert.equal(rows['did:plc:carol'].action, 'none')
  const measured = await service.measureFeedYield(did, feedPolicy(did))
  assert.equal(measured.report.account.did, did)
  assert.equal(measured.report.sources.length, 1)
  assert.equal(measured.report.status, 'completed')
  assert.equal(measured.report.sources[0]?.distinct_authors, 3)
  assert.equal(measured.report.sources[0]?.added_distinct_authors, 3)
  assert.equal(measured.report.overall.distinct_authors, 3)
  assert.equal(measured.report.overall.matching_accounts, measured.report.affected.length)
  assert.equal(measured.report.affected.some((item: any) => item.subject === did), false)
  assert.throws(() => service.owned('yield_reports', measured.id, 'did:plc:user2'), /not found/)
  assert.throws(() => service.approve(did, preview.id, 'apply', ['did:plc:alice']), /unavailable action/)
  const ordinary = service.approve(did, preview.id, 'apply', ['did:plc:bob'])
  const followed = service.approve(did, preview.id, 'apply_followed', ['did:plc:alice'])
  await worker.runNext()
  await worker.runNext()
  assert.equal((service.owned('jobs', ordinary, did) as any).status, 'completed')
  assert.equal((service.owned('jobs', followed, did) as any).status, 'completed')
  assert.equal(state.get('did:plc:alice')?.direct, true)
  assert.equal(state.get('did:plc:bob')?.direct, true)
  db.close()
})

test('preview composes allow over quarantine and retains indeterminate evidence', async () => {
  const { db, service } = setup()
  const id = service.savePolicy('did:plc:user1', 'test', policy('did:plc:user1'))
  const preview = await service.preview('did:plc:user1', id, undefined, '2026-09-08T12:02:00Z')
  const rows = Object.fromEntries(preview.receipt.rows.map(row => [row.subject, row]))
  assert.equal(rows['did:plc:alice'].action, 'mute')
  assert.equal(rows['did:plc:bob'].desired, 'no_quarantine_justification')
  assert.equal(rows['did:plc:bob'].basis, 'allow_rule')
  assert.equal(rows['did:plc:carol'].desired, 'indeterminate')
  assert.equal(preview.receipt.complete, false)
  db.close()
})

test('exact approval is idempotent, executes, and separately reviews release', async () => {
  const { db, accounts, service, controls } = setup()
  const did = 'did:plc:user1'
  accounts.remote.get(did)!.set('did:plc:alice', {
    known: true, direct: false, muted: false, handle: 'alice.test', display_name: 'Alice',
  })
  const policyId = service.savePolicy(did, 'test', policy(did))
  const preview = await service.preview(did, policyId, undefined, '2026-09-08T12:02:00Z')
  const job = service.approve(did, preview.id, 'apply', ['did:plc:alice'])
  assert.equal(service.approve(did, preview.id, 'apply', ['did:plc:alice']), job)
  const details = service.jobDetails(did, job)
  assert.equal(details.items[0]?.subject_did, 'did:plc:alice')
  assert.equal(details.items[0]?.action_label, 'Mute')
  assert.equal(details.items[0]?.handle, 'alice.test')
  assert.equal(details.items[0]?.display_name, 'Alice')
  assert.equal(details.items[0]?.subject_label, 'Alice')
  assert.equal(details.job.policy_name, 'test')
  assert.equal(details.job.approval_kind, 'apply')
  assert.equal(details.job.preview_id, preview.id)
  assert.equal(details.job.preview_url, `/previews/${preview.id}`)
  assert.equal(typeof details.job.approved_at, 'string')
  const approval = db.sql.prepare('SELECT actions FROM approvals WHERE id=?')
    .get(String((service.owned('jobs', job, did) as any).approval_id)) as { actions: string }
  assert.deepEqual(JSON.parse(approval.actions), [{
    subject: 'did:plc:alice', action: 'mute',
    fingerprint: preview.receipt.rows.find(row => row.subject === 'did:plc:alice')!.fingerprint,
    handle: 'alice.test', display_name: 'Alice', avatar: null,
  }])
  db.sql.prepare('UPDATE approvals SET actions=? WHERE id=?').run(
    JSON.stringify(JSON.parse(approval.actions).map(({ handle: _handle, display_name: _display, ...action }: any) => action)),
    String((service.owned('jobs', job, did) as any).approval_id),
  )
  const legacyDetails = service.jobDetails(did, job)
  assert.equal(legacyDetails.items[0]?.handle, 'alice.test')
  assert.equal(legacyDetails.items[0]?.display_name, 'Alice')
  assert.throws(() => service.jobDetails('did:plc:user2', job), /not found/)
  accounts.readbackLag.set('did:plc:alice', 2)
  const retryDelays: number[] = []
  const worker = new Worker(db, service, async delay => { retryDelays.push(delay) }, controls)
  assert.equal(await worker.runNext(), true)
  assert.deepEqual(retryDelays, [1_000, 2_000])
  assert.equal(accounts.muteCalls.get('did:plc:alice'), 1)
  assert.equal(accounts.remote.get(did)!.get('did:plc:alice')!.direct, true)
  assert.equal((service.owned('jobs', job, did) as any).status, 'completed')

  service.savePolicy(did, 'test', policy(did, 999), policyId)
  const release = await service.preview(did, policyId, undefined, '2026-09-08T12:03:00Z')
  const row = release.receipt.rows.find(item => item.subject === 'did:plc:alice')!
  assert.equal(row.action, 'release_candidate')
  const releaseJob = service.approve(did, release.id, 'release', ['did:plc:alice'])
  await worker.runNext()
  assert.equal(accounts.remote.get(did)!.get('did:plc:alice')!.direct, false)
  assert.equal((service.owned('jobs', releaseJob, did) as any).status, 'completed')
  db.close()
})

test('preview-only accounts cannot create an approval or job', async () => {
  const { db, service } = setup()
  const did = 'did:plc:user1'
  const policyId = service.savePolicy(did, 'test', policy(did))
  const preview = await service.preview(did, policyId, undefined, '2026-09-08T12:02:00Z')
  db.sql.prepare('UPDATE admissions SET writes_enabled=0 WHERE did=?').run(did)
  assert.throws(() => service.approve(did, preview.id, 'apply', ['did:plc:alice']), /not enabled/)
  assert.equal((db.sql.prepare('SELECT count(*) count FROM approvals WHERE did=?').get(did) as { count: number }).count, 0)
  assert.equal((db.sql.prepare('SELECT count(*) count FROM jobs WHERE did=?').get(did) as { count: number }).count, 0)
  db.close()
})

test('resources are account isolated and stale preview cannot be approved', async () => {
  const { db, service } = setup()
  const policyId = service.savePolicy('did:plc:user1', 'test', policy('did:plc:user1'))
  assert.throws(() => service.owned('policies', policyId, 'did:plc:user2'), /not found/)
  const preview = await service.preview('did:plc:user1', policyId, undefined, '2026-09-08T12:02:00Z')
  assert.throws(() => service.owned('previews', preview.id, 'did:plc:user2'), /not found/)
  service.savePolicy('did:plc:user1', 'changed', policy('did:plc:user1', 30), policyId)
  assert.throws(() => service.approve('did:plc:user1', preview.id, 'apply', ['did:plc:alice']), /policy changed/)
  db.close()
})

test('effect followed by transport failure remains uncertain across recovery', async () => {
  const { db, accounts, service, worker } = setup()
  const did = 'did:plc:user1'
  const acquired = acquisition(accounts, did, observations)
  ;(acquired.coverage as any[]).find(item =>
    item.subject === 'did:plc:carol' && item.provider === 'did:plc:trusted').complete = true
  ;(service as any).fixtureAcquisition = () => acquired
  const policyId = service.savePolicy(did, 'test', policy(did))
  const preview = await service.preview(did, policyId, undefined, '2026-09-08T12:02:00Z')
  const job = service.approve(did, preview.id, 'apply', ['did:plc:alice', 'did:plc:carol'])
  accounts.failAfterEffect.add('did:plc:alice')
  await worker.runNext()
  assert.equal((service.owned('jobs', job, did) as any).status, 'needs_review')
  assert.equal(accounts.remote.get(did)!.get('did:plc:alice')!.direct, true)
  assert.equal(accounts.remote.get(did)!.get('did:plc:carol')!.direct, true)
  const items = db.sql.prepare('SELECT subject,status FROM job_items WHERE job_id=? ORDER BY subject')
    .all(job) as Array<{ subject: string; status: string }>
  assert.deepEqual(items.map(item => ({ ...item })), [
    { subject: 'did:plc:alice', status: 'uncertain' },
    { subject: 'did:plc:carol', status: 'confirmed' },
  ])
  worker.recover()
  assert.equal((service.owned('jobs', job, did) as any).status, 'needs_review')
  const muteCalls = accounts.muteCalls.length
  await service.recheckUncertain(did, job, 'did:plc:alice')
  assert.equal(accounts.muteCalls.length, muteCalls)
  const rechecked = db.sql.prepare('SELECT status,error_code FROM job_items WHERE job_id=? AND subject=?')
    .get(job, 'did:plc:alice') as { status: string; error_code: string }
  assert.deepEqual({ ...rechecked }, { status: 'uncertain', error_code: 'current_state_matches_ownership_uncertain' })
  await assert.rejects(() => service.recheckUncertain('did:plc:user2', job, 'did:plc:alice'), /not found/)
  db.close()
})

test('operator write stop pauses an approved job before any remote effect', async () => {
  const { db, accounts, service, worker, controls } = setup()
  const did = 'did:plc:user1'
  const policyId = service.savePolicy(did, 'test', policy(did))
  const preview = await service.preview(did, policyId, undefined, '2026-09-08T12:02:00Z')
  const job = service.approve(did, preview.id, 'apply', ['did:plc:alice'])
  controls.set('writes', false, 'operator', 'controlled test')
  assert.equal(await worker.runNext(), false)
  assert.equal((service.owned('jobs', job, did) as any).status, 'paused_by_operator')
  assert.equal(accounts.muteCalls.get('did:plc:alice'), undefined)
  controls.set('writes', true, 'operator', 'controlled test complete')
  assert.equal(await worker.runNext(), false)
  assert.equal((service.owned('jobs', job, did) as any).status, 'paused_by_operator')
  db.close()
})

test('worker interruption marks in-flight item uncertain and does not replay it', () => {
  const { db, worker } = setup()
  const at = new Date().toISOString()
  db.sql.prepare(`INSERT INTO approvals
    (id,did,preview_id,policy_id,policy_revision,effective_hash,kind,batch_hash,actions,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    'a','did:plc:user1','p','policy',1,'effective','apply','batch','[]','approved',at)
  db.sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(
    'j','did:plc:user1','a','running',0,at,null,at,at)
  db.sql.prepare('INSERT INTO job_items VALUES(?,?,?,?,?,?,?,?,?)').run(
    'i','j','did:plc:alice','mute','fingerprint','attempting',1,null,at)
  worker.recover()
  const item = db.sql.prepare('SELECT status FROM job_items WHERE id=?').get('i') as { status: string }
  assert.equal(item.status, 'uncertain')
  assert.equal((serviceOwned(db, 'j') as any).status, 'needs_review')
  db.close()
})

test('unexpected claimed-job failure reaches a terminal state', async () => {
  const { db, service, worker } = setup()
  const did = 'did:plc:user1'
  const policyId = service.savePolicy(did, 'test', policy(did))
  const preview = await service.preview(did, policyId, undefined, '2026-09-08T12:02:00Z')
  const job = service.approve(did, preview.id, 'apply', ['did:plc:alice'])
  worker.run = async () => { throw new Error('unexpected fixture failure') }
  await worker.runNext()
  assert.equal((service.owned('jobs', job, did) as any).status, 'failed')
  assert.equal((service.owned('jobs', job, did) as any).error_code, 'worker_error')
  db.close()
})

test('pre-existing mute is preserved and exemption removes automation jurisdiction', async () => {
  const { db, accounts, service } = setup()
  const did = 'did:plc:user1'
  accounts.remote.get(did)!.set('did:plc:alice', { known: true, direct: true, muted: true })
  const policyId = service.savePolicy(did, 'test', policy(did))
  let preview = await service.preview(did, policyId, undefined, '2026-09-08T12:02:00Z')
  let alice = preview.receipt.rows.find(row => row.subject === 'did:plc:alice')!
  assert.equal(alice.action, 'none')
  assert.match(alice.reason, /preserve existing/)
  await service.engine.override(did, 'did:plc:alice', 'exempt', true)
  preview = await service.preview(did, policyId, undefined, '2026-09-08T12:03:00Z')
  alice = preview.receipt.rows.find(row => row.subject === 'did:plc:alice')!
  assert.equal(alice.action, 'none')
  assert.match(alice.reason, /no jurisdiction/)
  db.close()
})

test('web sessions expire and CSRF tokens are bound to the session', () => {
  const { db } = setup()
  const created = db.createSession('did:plc:user1')
  const session = db.session(created.token)!
  assert.equal(db.checkCsrf(session, created.csrf), true)
  assert.equal(db.checkCsrf(session, 'csrf_wrong'), false)
  db.sql.prepare('UPDATE web_sessions SET expires_at=? WHERE token_hash=?')
    .run('2000-01-01T00:00:00Z', shaForTest(created.token))
  assert.equal(db.session(created.token), undefined)
  db.close()
})

test('Bsky38 snapshot is bounded and source failure cannot become an empty clearance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acl-bsky38-'))
  const config = loadConfig({
    ATPROTO_ACL_ORIGIN: 'http://127.0.0.1:8426', ATPROTO_ACL_PORT: '8426',
    ATPROTO_ACL_DATA_DIR: dir, ATPROTO_ACL_PYTHON: process.env.ATPROTO_ACL_TEST_PYTHON ?? 'python3',
    ATPROTO_ACL_SESSION_SECRET: 'fixture-session-secret-at-least-32-bytes',
    ATPROTO_ACL_FIXTURE_MODE: '1', ATPROTO_ACL_WORKER: '0',
  })
  const db = new AppDb(join(dir, 'app.db'))
  const accounts = new FakeAccounts()
  const did = 'did:plc:user1'
  accounts.add(did, 'user1.test')
  db.upsertUser(accounts.profiles.get(did)!)
  const members = Array.from({ length: 38 }, (_, index) => ({
    did: `did:plc:leader-${index + 1}`, rank: index + 1, voteCount: 1000 - index,
    handle: `leader-${index + 1}.example`, displayName: `Leader ${index + 1}`,
  }))
  let currentMembers = members
  const service = new AclService(db, new Engine(config), accounts, undefined, async () => currentMembers)
  const policyId = service.savePolicy(did, 'quiet', bsky38Policy(did))
  const preview = await service.preview(did, policyId)
  assert.equal(preview.receipt.rows.filter(row => row.action === 'mute').length, 38)
  assert.equal((preview.receipt.discovery?.[0] as any).members[0].rank, 1)
  assert.match(String((preview.receipt.discovery?.[0] as any).retrieval_digest), /^[0-9a-f]{64}$/)
  assert.equal((preview.receipt.discovery?.[0] as any).authentication, 'none')

  const job = service.approve(did, preview.id, 'apply', ['did:plc:leader-1'])
  currentMembers = [
    { did: 'did:plc:replacement', rank: 1, voteCount: 2000, handle: 'replacement.example', displayName: 'Replacement' },
    ...members.slice(1),
  ]
  const controls = new ServiceControls(db, config)
  db.sql.prepare("INSERT INTO admissions(did,source,writes_enabled,created_at,updated_at) VALUES(?, 'allowlist', 1, datetime('now'), datetime('now'))").run(did)
  await new Worker(db, service, undefined, controls).runNext()
  assert.equal((service.owned('jobs', job, did) as any).status, 'completed_with_skips')
  assert.equal(accounts.remote.get(did)!.has('did:plc:leader-1'), false)
  assert.equal(accounts.remote.get(did)!.has('did:plc:replacement'), false)

  const unavailable = new AclService(db, new Engine(config), accounts, undefined, async () => { throw new Error('down') })
  const failedPolicy = unavailable.savePolicy(did, 'unavailable', bsky38Policy(did))
  const failed = await unavailable.preview(did, failedPolicy)
  assert.equal(failed.receipt.complete, false)
  assert.equal(failed.receipt.rows.filter(row => row.action === 'mute').length, 0)
  assert.equal(failed.receipt.discovery?.[0]?.complete, false)
  db.close()
})

function serviceOwned(db: AppDb, id: string) {
  return db.sql.prepare('SELECT * FROM jobs WHERE id=?').get(id)
}
