import assert from 'node:assert/strict'
import test from 'node:test'
// The installed CLI runner uses compiled modules, as the real capture command does.
// @ts-expect-error ordinary JavaScript entry module
import { runCapture } from '../scripts/quench-capture-runner.mjs'
const sentinel = 'PRIVATE_BODY_URL_CREDENTIAL_SENTINEL'
const env = { QUENCH_CAPTURE_DID: 'did:plc:fixture', QUENCH_CAPTURE_APP_DB: 'fixture.db', QUENCH_CAPTURE_OAUTH_KEY_FILE: 'fixture.key', QUENCH_CAPTURE_ORIGIN: 'https://example.invalid' }
for (const fault of ['configuration', 'startup', 'restore', 'home', 'discover', 'validation', 'close']) {
  test(`capture refusal contains ${fault} errors and closes its database`, async () => {
    let out = '', err = '', closed = 0
    const error = Object.assign(new Error(sentinel), { name: sentinel, error: sentinel, body: sentinel, url: sentinel, token: sentinel, status: 503 })
    const code = await runCapture({
      env: fault === 'configuration' ? { ...env, QUENCH_CAPTURE_ORIGIN: sentinel } : env,
      openDb: () => ({ close() { closed++; if (fault === 'close') throw error } }),
      createAccounts: async () => {
        if (fault === 'startup') throw error
        return { restore: async () => {
          if (fault === 'restore') throw error
          return { resetRequestCount() {}, feed: async (source: { type: string }) => {
            if (fault === (source.type === 'timeline' ? 'home' : 'discover')) throw error
            if (fault === 'validation') return { sample_complete: true, get items() { throw error } }
            return { items: [], exposures: [], sample_complete: true, source_exhausted: true }
          } }
        } }
      },
      stdout: (s: string) => { out += s }, stderr: (s: string) => { err += s },
    })
    assert.equal(code, 2); assert.equal(out, '')
    assert.ok(err.includes('capture refusal')); assert.ok(!err.includes(sentinel))
    const detail = JSON.parse(err.trim().replace('quench capture refusal ', ''))
    assert.equal(detail.phase, fault); assert.equal(detail.reason, 'capture_refused')
    assert.equal(detail.status, fault === 'configuration' ? null : 503)
    assert.equal(closed, fault === 'configuration' ? 0 : 1)
  })
}
test('successful capture closes DB and emits only body-free capture', async () => {
  let out = '', err = '', closed = false
  const code = await runCapture({ env, openDb: () => ({ close() { closed = true } }),
    createAccounts: async () => ({ restore: async () => ({ resetRequestCount() {}, feed: async () => ({ items: [], exposures: [], sample_complete: true, source_exhausted: true }) }) }),
    stdout: (s: string) => { assert.ok(closed); out += s }, stderr: (s: string) => { err += s },
  })
  assert.equal(code, 0); assert.equal(err, ''); assert.equal(JSON.parse(out).writes_performed, false)
})

test('known restore refusal requires reauthorization without upstream text', async () => {
  let out = '', err = '', closed = false
  const code = await runCapture({ env, openDb: () => ({ close() { closed = true } }),
    createAccounts: async () => ({ restore: async () => { throw Object.assign(new Error(sentinel), { name: 'TokenRevokedError' }) } }),
    stdout: (s: string) => { out += s }, stderr: (s: string) => { err += s },
  })
  assert.equal(code, 2); assert.ok(closed); assert.equal(out, '')
  assert.equal(JSON.parse(err.trim().replace('quench capture refusal ', '')).reason, 'reauthorization_required')
  assert.ok(!err.includes(sentinel))
})
