import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { AppDb } from '../src/db.js'
import { Engine } from '../src/engine.js'
import { createApp } from '../src/server.js'
import { AclService } from '../src/service.js'
import { Worker } from '../src/worker.js'
import { ServiceControls } from '../src/controls.js'
import { READ_OAUTH_SCOPE, WRITE_OAUTH_SCOPE } from '../src/oauth.js'
import { acquisition, FakeAccounts, observations } from './fixtures.js'

const now = Date.now()
const observedAt = new Date(now - 60 * 60 * 1000).toISOString()
const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString()
const snapshotAt = new Date(now - 24 * 60 * 60 * 1000).toISOString()

const dir = mkdtempSync(join(tmpdir(), 'acl-browser-'))
const config = loadConfig({
  ATPROTO_ACL_ORIGIN: 'http://127.0.0.1:18426', ATPROTO_ACL_PORT: '18426',
  ATPROTO_ACL_DATA_DIR: dir, ATPROTO_ACL_PYTHON: process.env.ATPROTO_ACL_TEST_PYTHON ?? 'python3',
  ATPROTO_ACL_SESSION_SECRET: 'fixture-browser-session-secret-32-bytes',
  ATPROTO_ACL_FIXTURE_MODE: '1', ATPROTO_ACL_WORKER: '1',
  ATPROTO_ACL_ADMISSION_MODE: 'open',
})
const db = new AppDb(join(dir, 'app.db'))
const accounts = new FakeAccounts()
accounts.add('did:plc:user1', 'user1.test')
accounts.add('did:plc:user2', 'user2.test')
accounts.add('did:plc:user3', 'user3.test')
accounts.add('did:plc:user4', 'user4.test')
accounts.add('did:plc:user5', 'user5.test')
for (const did of ['did:plc:user1', 'did:plc:user2', 'did:plc:user3', 'did:plc:user4']) {
  db.sql.prepare("INSERT INTO admissions(did,source,writes_enabled,created_at,updated_at) VALUES(?,'allowlist',1,datetime('now'),datetime('now'))").run(did)
}
for (const did of accounts.profiles.keys()) {
  if (did === 'did:plc:user3') continue
  const subjects = did === 'did:plc:user4'
    ? ['did:plc:alice', 'did:plc:bob', ...Array.from({ length: 135 }, (_, index) => `did:plc:account-${String(index + 1).padStart(3, '0')}`)]
    : ['did:plc:alice','did:plc:bob','did:plc:carol']
  for (const subject of subjects) {
    const name = subject.slice('did:plc:'.length)
    accounts.remote.get(did)!.set(subject, {
      known: true, direct: false, muted: false, handle: `${name}.example`,
      display_name: name[0]!.toUpperCase() + name.slice(1),
    })
  }
}
const guidedAcquisition = (did: string, body: string) => {
  const subjects = [...accounts.remote.get(did)!.keys()]
  const provider = 'did:plc:oubsyca6hhgqhmbbk27lvs7c'
  const exposures = (surface: 'timeline' | 'generator') => subjects.map((subject, position) => ({
    surface, mechanism: 'top_level', subject_did: subject,
    subject_handle: accounts.remote.get(did)!.get(subject)?.handle,
    post_uri: `at://${subject}/app.bsky.feed.post/fixture-${surface}-${position}`,
    post_cid: `cid-${surface}-${position}`, path: 'post.author', position,
    acquired_at: observedAt,
  }))
  return {
    subjects,
    identities: { [did]: did },
    observations: subjects.flatMap(subject => subject.endsWith('alice') ? [{
      provider, subject, property: 'monthly-posts-over-twenty-per-day', value: true,
      observed_at: observedAt, expires_at: expiresAt,
    }] : subject.endsWith('bob') ? [
      { provider, subject, property: 'made-over-thirty-posts-yesterday', value: true, observed_at: observedAt, expires_at: expiresAt },
      { provider, subject, property: 'made-over-thirty-replies-yesterday', value: true, observed_at: observedAt, expires_at: expiresAt },
    ] : []),
    coverage: subjects.map(subject => ({ provider, subject, complete: true, checked_at: observedAt })),
    discovery: body.includes('type: feed_exposure') ? [
      { source: 'feed_exposure', type: 'feed_exposure', surface: 'timeline', complete: true,
        exposure_complete: true, items_sampled: subjects.length, subjects, exposures: exposures('timeline') },
      { source: 'feed_exposure', type: 'feed_exposure', surface: 'generator', complete: true,
        exposure_complete: true, items_sampled: subjects.length, subjects, exposures: exposures('generator') },
    ] : [{ source: body.includes('type: follows') ? 'follows' : body.includes('type: labeled_stream') ? 'labeled_stream' :
      body.includes('type: explicit_dids') ? 'explicit_dids' : 'timeline', subjects, complete: true }],
    remote: Object.fromEntries(subjects.map(subject => [subject, {
      ...accounts.remote.get(did)!.get(subject)!,
      relationship: subject.endsWith('bob') ? 'following' : 'not_following',
    }])),
  }
}
const bsky38Acquisition = () => {
  const members = Array.from({ length: 38 }, (_, index) => ({
    did: `did:plc:bsky38-${index + 1}`, rank: index + 1, voteCount: 1000 - index,
    handle: `leader-${index + 1}.example`, displayName: `Leader ${index + 1}`,
  }))
  const provider = 'did:web:bsky38.com'
  return {
    subjects: members.map(item => item.did), identities: {},
    observations: members.map(item => ({
      provider, subject: item.did, property: 'member', value: true,
      observed_at: snapshotAt, expires_at: expiresAt,
      evidence_id: `fixture-bsky38-${item.did}`, raw_json: JSON.stringify(item),
      retrieved_at: snapshotAt, provenance: 'https://bsky38.com/',
    })),
    coverage: members.map(item => ({ provider, subject: item.did, complete: true, checked_at: snapshotAt })),
    discovery: [{ source: 'external_snapshot', source_url: 'https://bsky38.com/',
      retrieved_at: snapshotAt, subjects: members.map(item => item.did), members, complete: true }],
    remote: Object.fromEntries(members.map(item => [item.did, {
      known: true, direct: false, muted: false, handle: item.handle, display_name: item.displayName,
    }])),
  }
}
const controls = new ServiceControls(db, config)
const service = new AclService(db, new Engine(config), accounts,
  (did, body) => body.includes('did:web:bsky38.com') ? bsky38Acquisition() :
    body.includes('did:plc:oubsyca6hhgqhmbbk27lvs7c') ? guidedAcquisition(did, body) : acquisition(accounts, did, observations),
  undefined, controls)
const auth = Object.assign(accounts, {
  metadata: { client_id: config.origin + '/oauth-client-metadata.json', fixture: true },
  jwks: { keys: [] },
  authorize: async (handle: string, state: string, writeAccess = false) => new URL(`/oauth/callback?code=${encodeURIComponent(handle)}&state=${encodeURIComponent(state)}&access=${writeAccess ? 'write' : 'read'}`, config.origin),
  callback: async (params: URLSearchParams) => {
    const profile = [...accounts.profiles.values()].find(item => item.handle === params.get('code'))
    if (!profile) throw new Error('fixture account not found')
    accounts.revoked.delete(profile.did)
    profile.scopes = (params.get('access') === 'write' ? WRITE_OAUTH_SCOPE : READ_OAUTH_SCOPE).split(' ')
    return { session: { did: profile.did }, state: params.get('state') }
  },
})
const server = await createApp(config, db, service, auth)
const worker = new Worker(db, service, undefined, controls)
worker.loop(25)
server.listen(config.port, '127.0.0.1')
const stop = () => { worker.stop(); server.close(() => db.close()) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
