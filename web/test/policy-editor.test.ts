import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'yaml'
import { bsky38Policy, buildGuidedPolicy, DISCOVER_URI, readGuidedPolicy } from '../src/policy-editor.js'

test('guided policy round-trips every represented field', () => {
  const body = buildGuidedPolicy('did:plc:user', {
    sourceType: 'feeds', limit: 137, monthly: false, dailyPair: true,
  })
  assert.deepEqual(readGuidedPolicy(body), {
    supported: true, sourceType: 'feeds', limit: 137, subjects: [], monthly: false, dailyPair: true,
  })
  assert.deepEqual(parseSources(body), [
    { type: 'feed_exposure', surface: 'timeline', limit: 137, followed: 'review' },
    { type: 'feed_exposure', surface: 'generator', feed_uri: DISCOVER_URI, limit: 137, followed: 'review' },
  ])
})

test('legacy single-timeline policies stay round-trippable without adding Discover', () => {
  const body = buildGuidedPolicy('did:plc:user', {
    sourceType: 'timeline', limit: 91, monthly: true, dailyPair: false,
  })
  const model = readGuidedPolicy(body)
  assert.equal(model.supported, true)
  assert.equal(model.sourceType, 'timeline')
  assert.deepEqual(parseSources(body), [{ type: 'timeline', limit: 91 }])
})

test('Bsky38 preset round-trips as an external membership snapshot', () => {
  assert.deepEqual(readGuidedPolicy(bsky38Policy('did:plc:user')), {
    supported: true, sourceType: 'external_snapshot', limit: 38, subjects: [], monthly: false, dailyPair: false,
  })
})

test('specific accounts are stored as resolved DIDs', () => {
  const body = buildGuidedPolicy('did:plc:user', {
    sourceType: 'explicit_dids', limit: 500, subjects: ['did:plc:alice'], monthly: true, dailyPair: false,
  })
  assert.deepEqual(readGuidedPolicy(body).subjects, ['did:plc:alice'])
})

test('guided policy refuses unsupported advanced features', () => {
  const body = buildGuidedPolicy('did:plc:user', {
    sourceType: 'follows', limit: 500, monthly: true, dailyPair: true,
  }).replace('keep_muted: []', 'keep_muted: [did:plc:manual]')
  const model = readGuidedPolicy(body)
  assert.equal(model.supported, false)
  assert.match(model.reason ?? '', /advanced inline overrides/)
})

test('guided policy requires at least one publisher-defined condition', () => {
  assert.throws(() => buildGuidedPolicy('did:plc:user', {
    sourceType: 'follows', limit: 500, monthly: false, dailyPair: false,
  }), /at least one activity label/)
})

test('guided feed scope enforces the per-surface acquisition ceiling', () => {
  assert.throws(() => buildGuidedPolicy('did:plc:user', {
    sourceType: 'feeds', limit: 501, monthly: true, dailyPair: false,
  }), /between 1 and 500/)
})

function parseSources(body: string) {
  return parse(body).sources
}
