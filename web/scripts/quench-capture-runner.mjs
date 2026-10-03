import { QUENCH_CAPTURE_SCHEMA, assessBoundedPrefixSamples, assertBodyFreeCapture, sanitizeFeedSample } from '../dist/quench-observation.js'
const reauthorizationNames = new Set(['OAuthSessionCustodyError', 'TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError'])
// No upstream name, code, message, URL, or attached field is diagnostic data.
export const diagnostic = (phase, error) => JSON.stringify({
  phase, reason: phase === 'restore' && reauthorizationNames.has(error?.name) ? 'reauthorization_required' : 'capture_refused',
  status: Number.isSafeInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
})
export async function runCapture({ env, openDb, createAccounts, stdout, stderr }) {
  let db, output, phase = 'configuration', refused = false
  try {
    const required = name => { if (!env[name]) throw new Error('configuration unavailable'); return env[name] }
    const bound = Number(env.QUENCH_CAPTURE_BOUND ?? '500')
    if (!Number.isSafeInteger(bound) || bound < 1 || bound > 500) throw new Error('invalid bound')
    const did = required('QUENCH_CAPTURE_DID'), dbPath = required('QUENCH_CAPTURE_APP_DB'), keyPath = required('QUENCH_CAPTURE_OAUTH_KEY_FILE')
    const origin = new URL(required('QUENCH_CAPTURE_ORIGIN')).origin
    const discoverUri = env.QUENCH_CAPTURE_DISCOVER_URI ?? 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot'
    phase = 'startup'
    db = openDb(dbPath)
    const accounts = await createAccounts({ origin, oauthKeyFile: keyPath }, db)
    phase = 'restore'
    const account = await accounts.restore(did)
    account.resetRequestCount(12)
    const started = new Date().toISOString()
    phase = 'home'
    const homeAt = new Date().toISOString(), home = await account.feed({ type: 'timeline' }, bound)
    phase = 'discover'
    const discoverAt = new Date().toISOString(), discover = await account.feed({ type: 'feed', uri: discoverUri }, bound)
    phase = 'validation'
    const capture = {
      schema: QUENCH_CAPTURE_SCHEMA, capture_started_at: started, capture_ended_at: new Date().toISOString(),
      auth_mechanism: 'existing_atproto_oauth_read_session', writes_performed: false,
      requested_bounds: { home: bound, discover: bound }, feed_results: assessBoundedPrefixSamples(home, discover, bound, 100),
      observations: [...sanitizeFeedSample('home', home, homeAt), ...sanitizeFeedSample('discover', discover, discoverAt)],
    }
    assertBodyFreeCapture(capture)
    output = `${JSON.stringify(capture)}\n`
  } catch (error) {
    refused = true
    stderr(`quench capture refusal ${diagnostic(phase, error)}\n`)
  } finally {
    try { db?.close() } catch (error) { refused = true; stderr(`quench capture refusal ${diagnostic('close', error)}\n`) }
  }
  if (refused) return 2
  stdout(output)
  return 0
}
