import { Agent } from '@atproto/api'
import {
  NodeOAuthClient,
  type NodeSavedSession,
  type NodeSavedState,
  type RuntimeLock,
} from '@atproto/oauth-client-node'
import { JoseKey } from '@atproto/jwk-jose'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AppDb } from './db.js'
import { acquireRelationships, sampleFeed, type ProgressReporter } from './feed-exposure.js'
import type { AccountClient, AccountProvider, FeedSource, RemoteState } from './types.js'
import type { Config } from './config.js'

const BSKY_APPVIEW_AUD = 'did:web:api.bsky.app%23bsky_appview'
const rpcScope = (method: string) => `rpc?lxm=${method}&aud=${BSKY_APPVIEW_AUD}`

export const READ_OAUTH_SCOPE = [
  'atproto',
  rpcScope('app.bsky.graph.getMutes'),
  rpcScope('app.bsky.actor.getProfile'),
  rpcScope('app.bsky.actor.getProfiles'),
  rpcScope('app.bsky.graph.getFollows'),
  rpcScope('app.bsky.feed.getTimeline'),
  rpcScope('app.bsky.feed.getFeed'),
  rpcScope('app.bsky.graph.getRelationships'),
].join(' ')

export const WRITE_OAUTH_SCOPE = [
  READ_OAUTH_SCOPE,
  rpcScope('app.bsky.graph.muteActor'),
  rpcScope('app.bsky.graph.unmuteActor'),
].join(' ')

export const OAUTH_SCOPE = READ_OAUTH_SCOPE

export function hasRpcPermission(scopes: string[], method: string) {
  return scopes.some(scope => {
    if (scope === `rpc:${method}` || scope.startsWith(`rpc:${method}?`)) return true
    if (!scope.startsWith('rpc?')) return false
    const parameters = new URLSearchParams(scope.slice('rpc?'.length))
    return parameters.getAll('lxm').some(lxm => lxm === '*' || lxm === method)
  })
}

export function requiredFeedMethods(source: FeedSource) {
  return source.type === 'timeline'
    ? ['app.bsky.feed.getTimeline'] as const
    : ['app.bsky.feed.getFeed'] as const
}

export function observationRequestPlan(remainingRequests: number, profileBatches: number) {
  const available = Number.isFinite(remainingRequests)
    ? Math.max(0, Math.floor(remainingRequests))
    : Number.POSITIVE_INFINITY
  const scheduledProfileBatches = Math.min(profileBatches, available)
  return {
    profileBatches: scheduledProfileBatches,
    mutePages: scheduledProfileBatches === profileBatches
      ? Math.min(50, Math.max(0, available - scheduledProfileBatches))
      : 0,
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function sqliteLock(db: AppDb): RuntimeLock {
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
      if (Date.now() >= deadline) throw new Error('account session is busy; retry shortly')
      await delay(50 + Math.floor(Math.random() * 100))
    }
    try { return await fn() }
    finally { db.sql.prepare('DELETE FROM oauth_locks WHERE key=? AND owner=?').run(key, owner) }
  }
}

export class OAuthAccounts implements AccountProvider {
  readonly oauth: NodeOAuthClient
  readonly db: AppDb

  private constructor(oauth: NodeOAuthClient, db: AppDb) {
    this.oauth = oauth
    this.db = db
  }

  static async create(config: Config, db: AppDb) {
    if (!config.oauthKeyFile) throw new Error('ATPROTO_ACL_OAUTH_KEY_FILE is required')
    const imported = JSON.parse(await readFile(config.oauthKeyFile, 'utf8')) as Parameters<typeof JoseKey.fromImportable>[0]
    const key = await JoseKey.fromImportable(imported, 'atproto-acl-2026-01')
    const clientId = config.origin + '/oauth-client-metadata.json'
    const oauth = new NodeOAuthClient({
      clientMetadata: {
        client_id: clientId,
        client_name: 'atproto-acl',
        client_uri: config.origin + '/',
        redirect_uris: [config.origin + '/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        // Metadata declares the maximum capability. Each initial authorization
        // explicitly requests READ_OAUTH_SCOPE; write authority is requested
        // only during an operator-enabled reconnect.
        scope: WRITE_OAUTH_SCOPE,
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'ES256',
        dpop_bound_access_tokens: true,
        jwks_uri: config.origin + '/oauth-jwks.json',
      },
      keyset: [key],
      stateStore: {
        set: async (k: string, value: NodeSavedState) => {
          db.sql.prepare('DELETE FROM oauth_state WHERE expires_at<=?').run(new Date().toISOString())
          db.sql.prepare('INSERT OR REPLACE INTO oauth_state VALUES(?,?,?)')
            .run(k, JSON.stringify(value), new Date(Date.now() + 60 * 60 * 1000).toISOString())
        },
        get: async (k: string) => {
          const row = db.sql.prepare('SELECT value FROM oauth_state WHERE key=? AND expires_at>?')
            .get(k, new Date().toISOString()) as { value: string } | undefined
          return row ? JSON.parse(row.value) as NodeSavedState : undefined
        },
        del: async (k: string) => { db.sql.prepare('DELETE FROM oauth_state WHERE key=?').run(k) },
      },
      sessionStore: {
        set: async (did: string, value: NodeSavedSession) => {
          db.sql.prepare('INSERT OR REPLACE INTO oauth_sessions VALUES(?,?,?)')
            .run(did, JSON.stringify(value), new Date().toISOString())
        },
        get: async (did: string) => {
          const row = db.sql.prepare('SELECT value FROM oauth_sessions WHERE did=?')
            .get(did) as { value: string } | undefined
          return row ? JSON.parse(row.value) as NodeSavedSession : undefined
        },
        del: async (did: string) => { db.sql.prepare('DELETE FROM oauth_sessions WHERE did=?').run(did) },
      },
      requestLock: sqliteLock(db),
    })
    return new OAuthAccounts(oauth, db)
  }

  async authorize(handle: string, state: string, writeAccess = false) {
    return this.oauth.authorize(handle, { state, scope: writeAccess ? WRITE_OAUTH_SCOPE : READ_OAUTH_SCOPE })
  }

  async callback(params: URLSearchParams) {
    return this.oauth.callback(params)
  }

  async restore(did: string): Promise<AccountClient> {
    const session = await this.oauth.restore(did)
    const agent = new Agent(session)
    const token = await session.getTokenInfo()
    return new OAuthAccount(this.oauth, agent, did, token.aud, String(token.scope).split(/\s+/))
  }
}

class OAuthAccount implements AccountClient {
  private requests = 0
  private requestLimit = Number.POSITIVE_INFINITY

  constructor(
    private oauth: NodeOAuthClient,
    private agent: Agent,
    readonly did: string,
    private pds: string,
    private scopes: string[],
  ) {}

  requestCount() { return this.requests }
  resetRequestCount(limit = Number.POSITIVE_INFINITY) { this.requests = 0; this.requestLimit = limit }

  private call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.requests >= this.requestLimit) throw new Error('ATProto request budget exhausted')
    this.requests += 1
    return operation()
  }

  private require(method: string) {
    if (!hasRpcPermission(this.scopes, method)) {
      throw new Error(`connected account did not grant ${method}; reconnect to grant it`)
    }
  }

  async profile() {
    this.require('app.bsky.actor.getProfile')
    const response = await this.call(() => this.agent.getProfile({ actor: this.did }))
    return {
      did: response.data.did,
      handle: response.data.handle,
      displayName: response.data.displayName,
      pds: this.pds,
      scopes: this.scopes,
    }
  }

  async resolve(actors: string[]) {
    this.require('app.bsky.actor.getProfile')
    const result: Record<string, string> = {}
    for (const actor of actors) {
      if (actor.startsWith('did:')) { result[actor] = actor; continue }
      const response = await this.call(() => this.agent.getProfile({ actor }))
      if (response.data.handle.toLowerCase() !== actor.replace(/^@/, '').toLowerCase()) {
        throw new Error('account handle binding changed; review the policy identity')
      }
      result[actor] = response.data.did
    }
    return result
  }

  async follows(limit: number) {
    this.require('app.bsky.graph.getFollows')
    const dids = new Set<string>()
    let cursor: string | undefined
    const seen = new Set<string>()
    while (dids.size < limit) {
      const response = await this.call(() => this.agent.app.bsky.graph.getFollows({
        actor: this.did, limit: Math.min(100, limit - dids.size), cursor,
      }))
      for (const profile of response.data.follows) dids.add(profile.did)
      cursor = response.data.cursor
      if (!cursor) return { dids: [...dids], complete: true }
      if (seen.has(cursor)) throw new Error('account source returned a repeated cursor')
      seen.add(cursor)
    }
    return { dids: [...dids], complete: false, reason: 'configured account-source limit reached' }
  }

  async timeline(limit: number) {
    this.require('app.bsky.feed.getTimeline')
    const dids = new Set<string>()
    let cursor: string | undefined
    const seen = new Set<string>()
    while (dids.size < limit) {
      const response = await this.call(() => this.agent.app.bsky.feed.getTimeline({
        limit: Math.min(100, limit), cursor,
      }))
      for (const item of response.data.feed) dids.add(item.post.author.did)
      cursor = response.data.cursor
      if (!cursor) return { dids: [...dids], complete: true }
      if (seen.has(cursor)) throw new Error('account source returned a repeated cursor')
      seen.add(cursor)
    }
    return { dids: [...dids].slice(0, limit), complete: false, reason: 'configured account-source limit reached' }
  }

  async feed(source: FeedSource, limit: number, onProgress?: ProgressReporter) {
    for (const method of requiredFeedMethods(source)) this.require(method)
    return sampleFeed(source, limit, async (requested, params) => {
      if (requested.type === 'timeline') {
        const response = await this.call(() => this.agent.app.bsky.feed.getTimeline(params))
        return response.data
      }
      const response = await this.call(() => this.agent.app.bsky.feed.getFeed({ feed: requested.uri, ...params }))
      return response.data
    }, undefined, onProgress)
  }

  async relationships(subjects: string[], onProgress?: ProgressReporter) {
    this.require('app.bsky.graph.getRelationships')
    return acquireRelationships(this.did, subjects, async (actor, others) => {
      const response = await this.call(() => this.agent.app.bsky.graph.getRelationships({ actor, others }))
      return response.data
    }, { onProgress })
  }

  async observe(subjects: string[], onProgress?: ProgressReporter) {
    this.require('app.bsky.graph.getMutes')
    this.require('app.bsky.actor.getProfiles')
    const direct = new Set<string>()
    let cursor: string | undefined
    const seen = new Set<string>()
    let directComplete = false
    let pages = 0
    const result: Record<string, RemoteState> = {}
    const batches = Array.from(
      { length: Math.ceil(subjects.length / 25) },
      (_, index) => subjects.slice(index * 25, (index + 1) * 25),
    )
    // Spend the caller's remaining fixed budget on deterministic profile
    // batches first. Only the surplus may enumerate the mute list, so the two
    // concurrent tasks cannot race for the final request slots.
    const available = this.requestLimit - this.requests
    const plan = observationRequestPlan(available, batches.length)
    const scheduledBatches = batches.slice(0, plan.profileBatches)
    const mutePageLimit = plan.mutePages
    const directTask = (async () => {
      while (pages < mutePageLimit) {
        const response = await this.call(() => this.agent.app.bsky.graph.getMutes({ limit: 100, cursor }))
        for (const profile of response.data.mutes) direct.add(profile.did)
        cursor = response.data.cursor
        pages += 1
        await onProgress?.({ phase: 'mutes', completed: direct.size, requests: pages })
        if (!cursor) { directComplete = true; break }
        if (seen.has(cursor)) throw new Error('mute state returned a repeated cursor')
        seen.add(cursor)
      }
    })()
    let nextBatch = 0
    let completedProfiles = 0
    let profileRequests = 0
    const profileWorker = async () => {
      while (true) {
        const batch = scheduledBatches[nextBatch++]
        if (!batch) return
        const response = await this.call(() => this.agent.app.bsky.actor.getProfiles({ actors: batch }))
        profileRequests += 1
        for (const profile of response.data.profiles) {
          const viewer = profile.viewer
          result[profile.did] = {
            known: false,
            handle: profile.handle,
            display_name: profile.displayName,
            avatar: profile.avatar,
            muted: Boolean(viewer?.muted),
            only_reposts: Boolean(viewer?.mutedOnlyReposts),
            only_quotes: Boolean(viewer?.mutedOnlyQuoteposts),
            list: viewer?.mutedByList?.uri,
            blocked: Boolean(viewer?.blocking || viewer?.blockingByList),
          }
        }
        completedProfiles += batch.length
        await onProgress?.({
          phase: 'profiles', completed: completedProfiles, total: subjects.length, requests: profileRequests,
        })
      }
    }
    await Promise.all([
      directTask,
      ...Array.from({ length: Math.min(3, scheduledBatches.length) }, () => profileWorker()),
    ])
    for (const state of Object.values(result)) state.known = directComplete
    if (directComplete) {
      for (const [subject, state] of Object.entries(result)) state.direct = direct.has(subject)
    }
    return Object.fromEntries(subjects.map(did => [did, result[did] ?? { known: false }]))
  }

  async mute(did: string) { this.require('app.bsky.graph.muteActor'); await this.call(() => this.agent.app.bsky.graph.muteActor({ actor: did })) }
  async unmute(did: string) { this.require('app.bsky.graph.unmuteActor'); await this.call(() => this.agent.app.bsky.graph.unmuteActor({ actor: did })) }
  async disconnect() { await this.oauth.revoke(this.did) }
}
