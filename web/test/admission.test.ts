import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AdmissionManager, oauthFailureCategory, parseAdmissionMode } from '../src/admission.js'
import { AppDb, sha } from '../src/db.js'

const secret = 'fixture-oauth-state-secret-at-least-32-bytes'
const at = new Date('2026-09-09T12:00:00Z')

function setup(mode: 'allowlist' | 'invite' | 'open' = 'invite', allowedDids = new Set<string>()) {
  const db = new AppDb(join(mkdtempSync(join(tmpdir(), 'acl-admission-')), 'app.db'))
  AdmissionManager.install(db)
  const admissions = new AdmissionManager(db, { mode, stateSecret: secret, allowedDids })
  return { db, admissions }
}

test('validates the configured admission mode', () => {
  assert.equal(parseAdmissionMode(undefined), 'allowlist')
  assert.equal(parseAdmissionMode('invite'), 'invite')
  assert.throws(() => parseAdmissionMode('surprise'), /allowlist, invite, or open/)
})

test('OAuth failure diagnostics collapse errors to secret-free categories', () => {
  const secretBearing = new Error('invalid state v1.not-for-an-audit and code=also-private')
  assert.equal(oauthFailureCategory(secretBearing), 'invalid_or_expired_state')
  assert.equal(oauthFailureCategory(new Error('fetch failed for provider')), 'provider_unavailable')
  assert.equal(oauthFailureCategory('opaque failure'), 'oauth_callback_failed')
  assert.equal(JSON.stringify(oauthFailureCategory(secretBearing)).includes('not-for-an-audit'), false)
})

test('stores only invite and OAuth state hashes and binds one invite to one DID', () => {
  const { db, admissions } = setup()
  const invite = admissions.createInvite(at)
  assert.equal(invite.expiresAt, '2026-09-23T12:00:00.000Z')
  const first = admissions.begin({ inviteCode: invite.code }, at)
  const second = admissions.begin({ inviteCode: invite.code }, at)
  const storedInvite = db.sql.prepare('SELECT code_hash FROM invites').get() as { code_hash: string }
  const storedAttempt = db.sql.prepare('SELECT state_hash FROM oauth_attempts WHERE correlation_id=?')
    .get(first.correlationId) as { state_hash: string }
  assert.equal(storedInvite.code_hash, sha(invite.code))
  assert.equal(storedAttempt.state_hash, sha(first.state))
  assert.equal(JSON.stringify(storedAttempt).includes(first.state), false)

  assert.deepEqual(admissions.complete(first.state, 'did:plc:invited', at), {
    did: 'did:plc:invited', source: 'invite', writesEnabled: false,
  })
  assert.throws(() => admissions.complete(second.state, 'did:plc:other', at), /already used/)
  assert.throws(() => admissions.complete(second.state, 'did:plc:other', at), /already used/)
  const row = db.sql.prepare('SELECT redeemed_did FROM invites').get() as { redeemed_did: string }
  assert.equal(row.redeemed_did, 'did:plc:invited')
  db.close()
})

test('invite attempts expire and cannot be replayed', () => {
  const { db, admissions } = setup()
  const invite = admissions.createInvite(at)
  const attempt = admissions.begin({ inviteCode: invite.code }, at)
  const late = new Date(at.getTime() + 11 * 60 * 1000)
  assert.throws(() => admissions.complete(attempt.state, 'did:plc:user', late), /expired/)
  const fresh = admissions.begin({ inviteCode: invite.code }, late)
  admissions.complete(fresh.state, 'did:plc:user', late)
  assert.throws(() => admissions.complete(fresh.state, 'did:plc:user', late), /already used/)
  db.close()
})

test('signed application state rejects modification', () => {
  const { db, admissions } = setup('open')
  const attempt = admissions.begin({}, at)
  const pieces = attempt.state.split('.')
  pieces[2] = (pieces[2]!.startsWith('A') ? 'B' : 'A') + pieces[2]!.slice(1)
  const altered = pieces.join('.')
  assert.throws(() => admissions.complete(altered, 'did:plc:user', at), /invalid/)
  assert.equal(admissions.complete(attempt.state, 'did:plc:user', at).source, 'open')
  db.close()
})

test('an admission freeze blocks new accounts while preserving existing sign-ins', () => {
  const { db, admissions } = setup('open')
  const existing = admissions.begin({}, at)
  admissions.complete(existing.state, 'did:plc:existing', at)
  const pending = admissions.begin({}, at)
  db.sql.prepare("UPDATE service_controls SET admissions_enabled=0 WHERE singleton=1").run()
  assert.throws(() => admissions.complete(pending.state, 'did:plc:new', at), /not accepting new accounts/)
  // A returning account may finish an already-started authorization during a freeze.
  const returning = admissions.complete(admissions.begin({ kind: 'reconnect', expectedDid: 'did:plc:existing' }, at).state,
    'did:plc:existing', at)
  assert.equal(returning.source, 'reconnect')
  assert.throws(() => admissions.begin({}, at), /not accepting new sign-ins/)
  db.close()
})

test('reconnect is bound to the expected DID', () => {
  const { db, admissions } = setup('allowlist', new Set(['did:plc:user']))
  const first = admissions.begin({}, at)
  admissions.complete(first.state, 'did:plc:user', at)
  const reconnect = admissions.begin({ kind: 'reconnect', expectedDid: 'did:plc:user' }, at)
  assert.throws(() => admissions.complete(reconnect.state, 'did:plc:other', at), /different account/)
  db.close()
})

test('allowlist and open admission choose their intended initial write standing', () => {
  const allowed = setup('allowlist', new Set(['did:plc:allowed']))
  const ok = allowed.admissions.begin({}, at)
  assert.equal(allowed.admissions.complete(ok.state, 'did:plc:allowed', at).writesEnabled, true)
  const refused = allowed.admissions.begin({}, at)
  assert.throws(() => allowed.admissions.complete(refused.state, 'did:plc:nope', at), /access restricted/)
  allowed.db.close()

  const open = setup('open')
  const result = open.admissions.complete(open.admissions.begin({}, at).state, 'did:plc:new', at)
  assert.equal(result.writesEnabled, false)
  open.db.close()
})
