import assert from 'node:assert/strict'
import { chmodSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionGetter, type Session } from '@atproto/oauth-client'
import { JoseKey } from '@atproto/jwk-jose'
import type { NodeSavedSession } from '@atproto/oauth-client-node'
import { AppDb } from '../src/db.js'
import { DurableOAuthSessionCustody, OAuthSessionCustodyError } from '../src/oauth-custody.js'

const did = 'did:plc:oauth-custody-test'
const issuer = 'https://issuer.test'
const audience = 'https://pds.test/'
const scope = 'atproto rpc?lxm=app.bsky.feed.getTimeline&aud=did:web:api.bsky.app%23bsky_appview'

async function saved(refresh: string, access: string, expiresAt: string): Promise<NodeSavedSession> {
  const key = await JoseKey.generate(['ES256'])
  return {
    dpopJwk: key.privateJwk!,
    authMethod: { method: 'none' },
    tokenSet: {
      iss: issuer, sub: did, aud: audience, scope,
      refresh_token: refresh, access_token: access, token_type: 'DPoP', expires_at: expiresAt,
    },
  }
}

function fixture(delegate?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'acl-oauth-custody-'))
  const path = join(dir, 'app.db')
  const db = new AppDb(path)
  return { path, db, custody: new DurableOAuthSessionCustody(db, delegate) }
}

function officialStore(custody: DurableOAuthSessionCustody) {
  return {
    set: async (sub: string, value: Session) => custody.sessionStore.set(sub, {
      authMethod: value.authMethod, tokenSet: value.tokenSet, dpopJwk: value.dpopKey.privateJwk!,
    }),
    get: async (sub: string) => {
      const value = await custody.sessionStore.get(sub)
      if (!value) return undefined
      return { authMethod: value.authMethod, tokenSet: value.tokenSet, dpopKey: await JoseKey.fromJWK(value.dpopJwk) }
    },
    del: async (sub: string) => custody.sessionStore.del(sub),
  }
}

const officialRuntime = (custody: DurableOAuthSessionCustody) => ({
  hasImplementationLock: true,
  usingLock: <T>(key: string, fn: () => Promise<T>) => custody.requestLock(key, fn),
})

test('complete saved session survives process restart with owner-only database permissions', async () => {
  const { path, db, custody } = fixture()
  const session = await saved('refresh-one', 'access-one', '2026-09-23T00:00:00Z')
  await custody.sessionStore.set(did, session)
  db.close()
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const reopened = new AppDb(path)
  const restored = await new DurableOAuthSessionCustody(reopened).sessionStore.get(did)
  assert.deepEqual(restored, JSON.parse(JSON.stringify(session)))
  reopened.close()
})

test('opening custody repairs an overly broad pre-existing data-directory mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acl-oauth-permissions-'))
  chmodSync(dir, 0o755)
  const db = new AppDb(join(dir, 'app.db'))
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  db.close()
})

test('refresh intent and successor session commit atomically, and next restore uses successor', async () => {
  const networkBodies: string[] = []
  const { path, db, custody } = fixture(async (_input, init) => {
    networkBodies.push(String(init?.body ?? ''))
    return new Response('{}', { status: 200 })
  })
  const old = await saved('refresh-old', 'access-old', '2026-09-22T00:00:00Z')
  const successor = await saved('refresh-new', 'access-new', '2026-09-23T00:00:00Z')
  await custody.sessionStore.set(did, old)
  await custody.fetch(`${issuer}/token`, { method: 'POST', body: 'grant_type=refresh_token&refresh_token=refresh-old' })
  await assert.rejects(custody.sessionStore.get(did), OAuthSessionCustodyError)
  await custody.sessionStore.set(did, successor)
  assert.equal(networkBodies.length, 1)
  db.close()
  const reopened = new AppDb(path)
  const restored = await new DurableOAuthSessionCustody(reopened).sessionStore.get(did)
  assert.equal(restored?.tokenSet.refresh_token, 'refresh-new')
  assert.equal(restored?.tokenSet.access_token, 'access-new')
  reopened.close()
})

test('interrupted or failed successor persistence leaves predecessor unusable', async () => {
  const { db, custody } = fixture(async () => new Response('{}', { status: 200 }))
  await custody.sessionStore.set(did, await saved('refresh-canary-secret', 'access-canary-secret', '2026-09-22T00:00:00Z'))
  await custody.fetch(`${issuer}/token`, {
    method: 'POST', body: 'grant_type=refresh_token&refresh_token=refresh-canary-secret',
  })
  await assert.rejects(custody.sessionStore.set(did, {
    ...(await saved('successor-secret', 'successor-access', '2026-09-23T00:00:00Z')),
    tokenSet: { ...(await saved('x', 'y', '2026-09-23T00:00:00Z')).tokenSet, sub: 'did:plc:wrong' },
  }), /subject mismatch/)
  await assert.rejects(custody.sessionStore.get(did), error => {
    assert.equal(String(error).includes('canary'), false)
    assert.match(String(error), /indeterminate/)
    return true
  })
  db.close()
})

test('cross-process account lock serializes concurrent refresh owners', async () => {
  const { path, db, custody } = fixture()
  const secondDb = new AppDb(path)
  const second = new DurableOAuthSessionCustody(secondDb)
  let active = 0
  let peak = 0
  const run = (owner: DurableOAuthSessionCustody) => owner.requestLock(`@atproto-oauth-client-${did}`, async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 120))
    active -= 1
  })
  await Promise.all([run(custody), run(second)])
  assert.equal(peak, 1)
  secondDb.close(); db.close()
})

test('official SessionGetter refreshes an expired access token once, stores before return, and reuses successor', async () => {
  let refreshes = 0
  const { db, custody } = fixture(async () => new Response('{}', { status: 200 }))
  const predecessor = await saved('refresh-old', 'access-old', '2020-01-01T00:00:00Z')
  const successor = await saved('refresh-new', 'access-new', '2099-01-01T00:00:00Z')
  await custody.sessionStore.set(did, predecessor)
  const server = {
    authMethod: { method: 'none' as const },
    refresh: async () => {
      refreshes += 1
      await custody.fetch(`${issuer}/token`, {
        method: 'POST', body: 'grant_type=refresh_token&refresh_token=refresh-old',
      })
      return successor.tokenSet
    },
    revoke: async () => {},
  }
  const serverFactory = { fromIssuer: async () => server }
  const first = new SessionGetter(officialStore(custody), serverFactory as any, officialRuntime(custody) as any)
  const refreshed = await first.getSession(did)
  assert.equal(refreshed.tokenSet.refresh_token, 'refresh-new')
  assert.equal(refreshed.tokenSet.scope, scope)
  assert.equal((await custody.sessionStore.get(did))?.tokenSet.refresh_token, 'refresh-new')
  const afterRestart = new SessionGetter(officialStore(custody), serverFactory as any, officialRuntime(custody) as any)
  const restored = await afterRestart.getSession(did)
  assert.equal(restored.tokenSet.access_token, 'access-new')
  assert.equal(refreshes, 1)
  db.close()
})

test('two official client instances serialize a concurrent refresh and both receive the durable successor', async () => {
  let refreshes = 0
  const response = async () => new Response('{}', { status: 200 })
  const { path, db, custody } = fixture(response)
  const secondDb = new AppDb(path)
  const secondCustody = new DurableOAuthSessionCustody(secondDb, response)
  const predecessor = await saved('refresh-shared', 'access-old', '2020-01-01T00:00:00Z')
  const successor = await saved('refresh-successor', 'access-new', '2099-01-01T00:00:00Z')
  await custody.sessionStore.set(did, predecessor)
  const serverFor = (owner: DurableOAuthSessionCustody) => ({
    authMethod: { method: 'none' as const },
    refresh: async (tokenSet: Session['tokenSet']) => {
      refreshes += 1
      await owner.fetch(`${issuer}/token`, {
        method: 'POST', body: `grant_type=refresh_token&refresh_token=${tokenSet.refresh_token}`,
      })
      await new Promise(resolve => setTimeout(resolve, 75))
      return successor.tokenSet
    },
    revoke: async () => {},
  })
  const first = new SessionGetter(officialStore(custody),
    { fromIssuer: async () => serverFor(custody) } as any, officialRuntime(custody) as any)
  const second = new SessionGetter(officialStore(secondCustody),
    { fromIssuer: async () => serverFor(secondCustody) } as any, officialRuntime(secondCustody) as any)
  const [one, two] = await Promise.all([first.getSession(did), second.getSession(did)])
  assert.equal(one.tokenSet.refresh_token, 'refresh-successor')
  assert.equal(two.tokenSet.refresh_token, 'refresh-successor')
  assert.equal(refreshes, 1)
  secondDb.close(); db.close()
})

test('revoked session deletion requests reauthorization without leaking credentials', async () => {
  const { db, custody } = fixture()
  await custody.sessionStore.set(did, await saved('refresh-secret', 'access-secret', '2099-01-01T00:00:00Z'))
  await custody.sessionStore.del(did)
  assert.equal(await custody.sessionStore.get(did), undefined)
  const receipt = JSON.stringify({ status: 'reauthorization_required', did })
  assert.equal(receipt.includes('refresh-secret'), false)
  assert.equal(receipt.includes('access-secret'), false)
  db.close()
})
