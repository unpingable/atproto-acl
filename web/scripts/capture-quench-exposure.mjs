#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { Agent } from '@atproto/api'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { JoseKey } from '@atproto/jwk-jose'
import { sampleFeed } from '../dist/feed-exposure.js'
import { QUENCH_CAPTURE_SCHEMA, assertBodyFreeCapture, sanitizeFeedSample } from '../dist/quench-observation.js'
import { assertFreshCaptureSession, withoutOAuthRefresh } from '../dist/read-only-oauth.js'

const required = name => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const bound = Number(process.env.QUENCH_CAPTURE_BOUND ?? '500')
if (!Number.isSafeInteger(bound) || bound < 1 || bound > 500) throw new Error('capture bound must be 1..500')

const did = required('QUENCH_CAPTURE_DID')
const dbPath = required('QUENCH_CAPTURE_APP_DB')
const keyPath = required('QUENCH_CAPTURE_OAUTH_KEY_FILE')
const origin = new URL(required('QUENCH_CAPTURE_ORIGIN')).origin
const discoverUri = process.env.QUENCH_CAPTURE_DISCOVER_URI ??
  'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot'

const db = new DatabaseSync(dbPath, { readOnly: true })
const row = db.prepare('SELECT value FROM oauth_sessions WHERE did=?').get(did)
db.close()
if (!row?.value) throw new Error('the controlled DID has no existing OAuth session')
let savedSession = JSON.parse(String(row.value))
assertFreshCaptureSession(savedSession)
const imported = JSON.parse(await readFile(keyPath, 'utf8'))
const key = await JoseKey.fromImportable(imported, 'atproto-acl-2026-01')
const rpc = method => `rpc?lxm=${method}&aud=did:web:api.bsky.app%23bsky_appview`
const readScope = [
  'atproto', rpc('app.bsky.graph.getMutes'), rpc('app.bsky.actor.getProfile'),
  rpc('app.bsky.actor.getProfiles'), rpc('app.bsky.graph.getFollows'),
  rpc('app.bsky.feed.getTimeline'), rpc('app.bsky.feed.getFeed'),
  rpc('app.bsky.graph.getRelationships'),
].join(' ')
const oauth = new NodeOAuthClient({
  fetch: withoutOAuthRefresh(fetch),
  clientMetadata: {
    client_id: `${origin}/oauth-client-metadata.json`, client_name: 'atproto-acl', client_uri: `${origin}/`,
    redirect_uris: [`${origin}/oauth/callback`], grant_types: ['authorization_code', 'refresh_token'],
    scope: `${readScope} ${rpc('app.bsky.graph.muteActor')} ${rpc('app.bsky.graph.unmuteActor')}`,
    response_types: ['code'], application_type: 'web', token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256', dpop_bound_access_tokens: true, jwks_uri: `${origin}/oauth-jwks.json`,
  },
  keyset: [key],
  stateStore: { set: async () => {}, get: async () => undefined, del: async () => {} },
  sessionStore: {
    set: async (sessionDid, value) => { if (sessionDid === did) savedSession = value },
    get: async sessionDid => sessionDid === did ? savedSession : undefined,
    del: async sessionDid => { if (sessionDid === did) savedSession = undefined },
  },
  requestLock: async (_name, fn) => fn(),
})
const session = await oauth.restore(did, false)
const token = await session.getTokenInfo(false)
const scopes = new Set(String(token.scope ?? '').split(/\s+/))
for (const method of ['app.bsky.feed.getTimeline', 'app.bsky.feed.getFeed']) {
  if (![...scopes].some(scope => scope === `rpc:${method}` || new URLSearchParams(scope.replace(/^rpc\?/, '')).getAll('lxm').includes(method))) {
    throw new Error(`existing session lacks ${method}`)
  }
}
const agent = new Agent(session)
const started = new Date().toISOString()
const acquire = async (source, observedAt) => sampleFeed(source, bound, async (requested, params) => {
  try {
    if (requested.type === 'timeline') return (await agent.app.bsky.feed.getTimeline(params)).data
    return (await agent.app.bsky.feed.getFeed({ feed: requested.uri, ...params })).data
  } catch (error) {
    const detail = {
      phase: requested.type === 'timeline' ? 'home' : 'discover',
      name: String(error?.name ?? 'Error').slice(0, 80),
      status: Number.isSafeInteger(error?.status) ? error.status : null,
      code: typeof error?.error === 'string' ? error.error.slice(0, 80) : null,
    }
    process.stderr.write(`quench capture read refusal ${JSON.stringify(detail)}\n`)
    throw error
  }
}, observedAt)
const homeAt = new Date().toISOString()
const home = await acquire({ type: 'timeline' }, homeAt)
const discoverAt = new Date().toISOString()
const discover = await acquire({ type: 'feed', uri: discoverUri }, discoverAt)
const capture = {
  schema: QUENCH_CAPTURE_SCHEMA,
  capture_started_at: started,
  capture_ended_at: new Date().toISOString(),
  auth_mechanism: 'existing_atproto_oauth_read_session',
  writes_performed: false,
  requested_bounds: { home: bound, discover: bound },
  observations: [
    ...sanitizeFeedSample('home', home, homeAt),
    ...sanitizeFeedSample('discover', discover, discoverAt),
  ],
}
assertBodyFreeCapture(capture)
process.stdout.write(`${JSON.stringify(capture)}\n`)
