import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeCapture,
  analyzeQuenchObservations,
  assertBodyFreeCapture,
  assessBoundedPrefixSamples,
  sanitizeFeedSample,
} from '../src/quench-observation.js'

const root = 'at://did:plc:root/app.bsky.feed.post/root'
const other = 'at://did:plc:bob/app.bsky.feed.post/other'
const item = (position: number, actor: string, uri: string, lineage = root, status: any = 'reply') => ({
  position, post_uri: uri, post_cid: `cid-${position}`, author_did: actor,
  lineage_uri: lineage, root_uri: lineage, lineage_status: status,
})

test('sanitization allowlists structural fields and retains determinate and indeterminate standing', () => {
  const sample: any = {
    items: [
      { ...item(0, 'did:plc:alice', root, root, 'root'), text: 'secret body', embed: { alt: 'secret alt' } },
      { ...item(1, 'did:plc:bob', 'at://did:plc:bob/app.bsky.feed.post/reply'), profile: { description: 'secret' } },
      { position: 2, post_uri: 'at://did:plc:carol/app.bsky.feed.post/missing', post_cid: 'cid-2',
        author_did: 'did:plc:carol', lineage_status: 'unknown', parent_uri: root },
    ],
    exposures: [{ mechanism: 'repost', position: 1, post_uri: 'at://did:plc:bob/app.bsky.feed.post/reply' }],
  }
  const observations = sanitizeFeedSample('discover', sample, '2026-09-22T12:00:00Z')
  const capture: any = { schema: 'atproto-acl.quench-exposure.v1', capture_started_at: '2026-09-22T12:00:00Z',
    capture_ended_at: '2026-09-22T12:01:00Z', auth_mechanism: 'existing_atproto_oauth_read_session',
    writes_performed: false, requested_bounds: { home: 500, discover: 500 }, observations }
  assertBodyFreeCapture(capture)
  const serialized = JSON.stringify(capture)
  assert.equal(serialized.includes('secret'), false)
  assert.equal(observations[0]?.lineage_uri, root)
  assert.equal(observations[1]?.repost_target_uri, 'at://did:plc:bob/app.bsky.feed.post/reply')
  assert.equal(observations[2]?.reason_indeterminate, 'missing_root')
  assert.equal(observations.every(row => row.feed === 'discover'), true)
})

test('analysis is deterministic, deduplicates receipts, and measures Quench selectivity', () => {
  const raw = [
    item(0, 'did:plc:alice', root, root, 'root'),
    item(1, 'did:plc:bob', 'at://did:plc:bob/app.bsky.feed.post/reply-1'),
    item(2, 'did:plc:alice', 'at://did:plc:alice/app.bsky.feed.post/reply-2'),
    item(3, 'did:plc:bob', other, other, 'root'),
  ]
  const sample: any = { items: raw, exposures: [] }
  const observations = sanitizeFeedSample('home', sample, '2026-09-22T12:00:00Z')
  const duplicated = [...observations, observations[1]!]
  const first = analyzeQuenchObservations(duplicated)
  assert.deepEqual(first, analyzeQuenchObservations(duplicated))
  assert.equal(first.duplicate_observations_removed, 1)
  assert.equal(first.lineages_2_plus, 1)
  assert.equal(first.repeated_lineages_multiple_actors, 1)
  assert.equal(first.quench_subsequent_exposures_suppressed, 2)
  assert.equal(first.quench_suppressed_by_actors_seen_in_unrelated_lineages, 1)
  assert.equal(first.actor_policy_unrelated_exposures_removed, 0,
    'trigger-actor suppression does not invent a broader actor set')
  assert.equal(first.repeated_lineages_actor_and_quench_equivalent, 0)
})

test('trigger-actor negative control counts unrelated later exposure without mutating policy', () => {
  const sample: any = { items: [
    item(0, 'did:plc:alice', root, root, 'root'),
    item(1, 'did:plc:bob', 'at://did:plc:bob/app.bsky.feed.post/reply'),
    item(2, 'did:plc:alice', 'at://did:plc:alice/app.bsky.feed.post/unrelated', other, 'reply'),
  ], exposures: [] }
  const observations = sanitizeFeedSample('home', sample, '2026-09-22T12:00:00Z')
  const before = JSON.stringify(observations)
  const result = analyzeQuenchObservations(observations)
  assert.equal(result.quench_subsequent_exposures_suppressed, 1)
  assert.equal(result.actor_policy_unrelated_exposures_removed, 1)
  assert.equal(JSON.stringify(observations), before)
})

test('capture analysis keeps feed provenance separate and creates no action vocabulary', () => {
  const home = sanitizeFeedSample('home', { items: [item(0, 'did:plc:alice', root, root, 'root')], exposures: [] } as any,
    '2026-09-22T12:00:00Z')
  const discover = sanitizeFeedSample('discover', { items: [item(0, 'did:plc:bob', other, other, 'root')], exposures: [] } as any,
    '2026-09-22T12:01:00Z')
  const analysis = analyzeCapture({ schema: 'atproto-acl.quench-exposure.v1', capture_started_at: '2026-09-22T12:00:00Z',
    capture_ended_at: '2026-09-22T12:02:00Z', auth_mechanism: 'existing_atproto_oauth_read_session',
    writes_performed: false, requested_bounds: { home: 1, discover: 1 }, observations: [...home, ...discover] })
  assert.equal(analysis.home.total_exposures, 1)
  assert.equal(analysis.discover.total_exposures, 1)
  assert.equal(JSON.stringify(analysis).includes('worker'), false)
  assert.equal(JSON.stringify(analysis).includes('mute'), false)
})

test('capture validation refuses credential and content-bearing fields', () => {
  const observation: any = sanitizeFeedSample('home', {
    items: [item(0, 'did:plc:alice', root, root, 'root')], exposures: [],
  } as any, '2026-09-22T12:00:00Z')[0]
  const base: any = { schema: 'atproto-acl.quench-exposure.v1', capture_started_at: '2026-09-22T12:00:00Z',
    capture_ended_at: '2026-09-22T12:01:00Z', auth_mechanism: 'existing_atproto_oauth_read_session',
    writes_performed: false, requested_bounds: { home: 1, discover: 0 }, observations: [observation] }
  assert.throws(() => assertBodyFreeCapture({ ...base, observations: [{ ...observation, text: 'not retained' }] }),
    /non-allowlisted/)
  assert.throws(() => assertBodyFreeCapture({ ...base, authorization: 'synthetic-canary' }), /forbidden field/)
  assert.throws(() => assertBodyFreeCapture({ ...base, feed_results: {
    home: { actual_count: 1, terminal_condition: 'normal_exhaustion', minimum_useful_sample: 1,
      empirical_power: 'adequate' },
    discover: { actual_count: 0, terminal_condition: 'requested_bound_reached', minimum_useful_sample: 1,
      empirical_power: 'underpowered' },
  } }), /feed result/)
})

test('coherent capture accepts a bounded prefix or normal exhaustion and reports power', () => {
  const sample = (count: number, complete = true, exhausted = count < 500) => ({
    items: Array.from({ length: count }, (_, position) => ({ position })) as any[],
    sample_complete: complete,
    source_exhausted: exhausted,
  })
  assert.deepEqual(assessBoundedPrefixSamples(sample(0), sample(500), 500), {
    home: { actual_count: 0, terminal_condition: 'normal_exhaustion', minimum_useful_sample: 100,
      empirical_power: 'underpowered' },
    discover: { actual_count: 500, terminal_condition: 'requested_bound_reached', minimum_useful_sample: 100,
      empirical_power: 'adequate' },
  })
  assert.throws(() => assessBoundedPrefixSamples(sample(499, false), sample(500), 500), /incomplete/)
  assert.throws(() => assessBoundedPrefixSamples(sample(499, true, false), sample(500), 500), /ambiguous pagination/)
  assert.throws(() => assessBoundedPrefixSamples(sample(501, true, false), sample(500), 500), /incomplete/)
})
