import assert from 'node:assert/strict'
import test from 'node:test'
import { assertFreshCaptureSession, withoutOAuthRefresh } from '../src/read-only-oauth.js'

test('capture session preflight refuses expired and nearly expired access tokens', () => {
  const now = Date.parse('2026-09-22T12:00:00Z')
  assert.throws(() => assertFreshCaptureSession({ tokenSet: { expires_at: '2026-09-22T11:59:59Z' } }, now))
  assert.throws(() => assertFreshCaptureSession({ tokenSet: { expires_at: '2026-09-22T12:09:59Z' } }, now))
  assert.equal(assertFreshCaptureSession({ tokenSet: { expires_at: '2026-09-22T12:10:01Z' } }, now),
    Date.parse('2026-09-22T12:10:01Z'))
})

test('read-only OAuth transport refuses refresh grants and delegates ordinary reads', async () => {
  let calls = 0
  const wrapped = withoutOAuthRefresh(async () => {
    calls += 1
    return new Response('{}', { status: 200 })
  })
  await assert.rejects(wrapped('https://issuer.example/token', {
    method: 'POST', body: 'grant_type=refresh_token&refresh_token=synthetic-canary',
  }), /refuses OAuth refresh/)
  assert.equal(calls, 0)
  const response = await wrapped('https://pds.example/xrpc/app.bsky.feed.getTimeline')
  assert.equal(response.status, 200)
  assert.equal(calls, 1)
})
