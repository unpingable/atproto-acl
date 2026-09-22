import { createHash, randomUUID } from 'node:crypto'
import type { NodeSavedSession, NodeSavedSessionStore, RuntimeLock } from '@atproto/oauth-client-node'
import type { AppDb } from './db.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export class OAuthSessionCustodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthSessionCustodyError'
  }
}

function refreshTokenHash(value: unknown) {
  const session = value as { tokenSet?: { refresh_token?: unknown } }
  return typeof session?.tokenSet?.refresh_token === 'string'
    ? hash(session.tokenSet.refresh_token)
    : undefined
}

function validateSession(did: string, value: NodeSavedSession) {
  if (value?.tokenSet?.sub !== did) throw new OAuthSessionCustodyError('OAuth session subject mismatch; reconnect required')
  if (!value.tokenSet.access_token || !value.tokenSet.refresh_token) {
    throw new OAuthSessionCustodyError('OAuth session is incomplete; reconnect required')
  }
  const jwk = value.dpopJwk as unknown as { d?: unknown }
  if (!jwk || typeof jwk !== 'object' || typeof jwk.d !== 'string') {
    throw new OAuthSessionCustodyError('OAuth session lacks private DPoP custody; reconnect required')
  }
}

export function sqliteOAuthLock(db: AppDb): RuntimeLock {
  return async <T>(key: string, fn: () => T | PromiseLike<T>): Promise<T> => {
    const owner = randomUUID()
    const deadline = Date.now() + 15_000
    while (true) {
      const acquired = db.transaction(() => {
        db.sql.prepare('DELETE FROM oauth_locks WHERE expires_at<=?').run(new Date().toISOString())
        return db.sql.prepare('INSERT OR IGNORE INTO oauth_locks VALUES(?,?,?)')
          .run(key, owner, new Date(Date.now() + 45_000).toISOString()).changes === 1
      })
      if (acquired) break
      if (Date.now() >= deadline) throw new OAuthSessionCustodyError('account session is busy; retry shortly')
      await delay(50 + Math.floor(Math.random() * 100))
    }
    try { return await fn() }
    finally { db.sql.prepare('DELETE FROM oauth_locks WHERE key=? AND owner=?').run(key, owner) }
  }
}

export class DurableOAuthSessionCustody {
  readonly sessionStore: NodeSavedSessionStore
  readonly requestLock: RuntimeLock

  constructor(private db: AppDb, private delegateFetch: typeof fetch = fetch) {
    this.requestLock = sqliteOAuthLock(db)
    this.sessionStore = {
      set: async (did, value) => this.set(did, value),
      get: async did => this.get(did),
      del: async did => this.del(did),
    }
  }

  private set(did: string, value: NodeSavedSession) {
    validateSession(did, value)
    const serialized = JSON.stringify(value)
    this.db.transaction(() => {
      const intent = this.db.sql.prepare('SELECT prior_refresh_hash FROM oauth_refresh_intents WHERE did=?')
        .get(did) as { prior_refresh_hash: string } | undefined
      if (intent) {
        const current = this.db.sql.prepare('SELECT value FROM oauth_sessions WHERE did=?')
          .get(did) as { value: string } | undefined
        let priorHash: string | undefined
        try { priorHash = current ? refreshTokenHash(JSON.parse(current.value)) : undefined }
        catch { /* invalid retained state fails the comparison below */ }
        if (!priorHash || priorHash !== intent.prior_refresh_hash) {
          throw new OAuthSessionCustodyError('OAuth refresh predecessor changed; reconnect required')
        }
      }
      this.db.sql.prepare('INSERT OR REPLACE INTO oauth_sessions VALUES(?,?,?)')
        .run(did, serialized, new Date().toISOString())
      this.db.sql.prepare('DELETE FROM oauth_refresh_intents WHERE did=?').run(did)
    })
  }

  private get(did: string) {
    const intent = this.db.sql.prepare('SELECT 1 FROM oauth_refresh_intents WHERE did=?').get(did)
    if (intent) {
      throw new OAuthSessionCustodyError('OAuth refresh outcome is indeterminate; reconnect required')
    }
    const row = this.db.sql.prepare('SELECT value FROM oauth_sessions WHERE did=?')
      .get(did) as { value: string } | undefined
    if (!row) return undefined
    let value: NodeSavedSession
    try { value = JSON.parse(row.value) as NodeSavedSession }
    catch { throw new OAuthSessionCustodyError('OAuth session is unreadable; reconnect required') }
    validateSession(did, value)
    return value
  }

  private del(did: string) {
    this.db.transaction(() => {
      this.db.sql.prepare('DELETE FROM oauth_sessions WHERE did=?').run(did)
      this.db.sql.prepare('DELETE FROM oauth_refresh_intents WHERE did=?').run(did)
    })
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const body = init?.body
    if (typeof body === 'string') {
      const form = new URLSearchParams(body)
      if (form.get('grant_type') === 'refresh_token') {
        const refreshToken = form.get('refresh_token')
        if (!refreshToken) throw new OAuthSessionCustodyError('OAuth refresh request lacks a token')
        const priorHash = hash(refreshToken)
        const matches = (this.db.sql.prepare('SELECT did,value FROM oauth_sessions').all() as Array<{
          did: string; value: string
        }>).filter(row => {
          try { return refreshTokenHash(JSON.parse(row.value)) === priorHash }
          catch { return false }
        })
        if (matches.length !== 1) throw new OAuthSessionCustodyError('OAuth refresh session is unavailable; reconnect required')
        const did = matches[0]!.did
        this.db.transaction(() => {
          const active = this.db.sql.prepare('SELECT 1 FROM oauth_refresh_intents WHERE did=?').get(did)
          if (active) throw new OAuthSessionCustodyError('OAuth refresh outcome is already indeterminate; reconnect required')
          this.db.sql.prepare('INSERT INTO oauth_refresh_intents VALUES(?,?,?,?)')
            .run(did, priorHash, randomUUID(), new Date().toISOString())
        })
      }
    }
    return this.delegateFetch(input, init)
  }
}
