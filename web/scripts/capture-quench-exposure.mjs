#!/usr/bin/env node
import { AppDb } from '../dist/db.js'
import { OAuthAccounts } from '../dist/oauth.js'
import {
  QUENCH_CAPTURE_SCHEMA,
  assertBodyFreeCapture,
  assertExactCaptureSamples,
  sanitizeFeedSample,
} from '../dist/quench-observation.js'

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

const db = new AppDb(dbPath)
const accounts = await OAuthAccounts.create({ origin, oauthKeyFile: keyPath }, db)
let account
try {
  account = await accounts.restore(did)
} catch (error) {
  const expected = ['OAuthSessionCustodyError', 'TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError']
    .includes(String(error?.name ?? ''))
  if (!expected) throw error
  process.stderr.write('quench capture authorization unavailable {"status":"reauthorization_required"}\n')
  db.close()
  process.exit(2)
}
account.resetRequestCount(12)
const started = new Date().toISOString()
const acquire = async (source, observedAt) => {
  try {
    return await account.feed(source, bound)
  } catch (error) {
    const detail = {
      phase: source.type === 'timeline' ? 'home' : 'discover',
      name: String(error?.name ?? 'Error').slice(0, 80),
      status: Number.isSafeInteger(error?.status) ? error.status : null,
      code: typeof error?.error === 'string' ? error.error.slice(0, 80) : null,
    }
    process.stderr.write(`quench capture read refusal ${JSON.stringify(detail)}\n`)
    throw error
  }
}
const homeAt = new Date().toISOString()
const home = await acquire({ type: 'timeline' }, homeAt)
const discoverAt = new Date().toISOString()
const discover = await acquire({ type: 'feed', uri: discoverUri }, discoverAt)
assertExactCaptureSamples(home, discover, bound)
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
db.close()
