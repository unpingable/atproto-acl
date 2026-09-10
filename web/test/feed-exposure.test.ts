import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_FEED_PAGES,
  RELATIONSHIP_BATCH_SIZE,
  MAX_AUTHORS_PER_ITEM,
  acquireRelationships,
  extractFeedExposures,
  sampleFeed,
} from '../src/feed-exposure.js'
import { hasRpcPermission, OAUTH_SCOPE, observationRequestPlan, requiredFeedMethods, WRITE_OAUTH_SCOPE } from '../src/oauth.js'

const profile = (did: string, handle = `${did.slice(8)}.test`) => ({ did, handle })

test('generator acquisition requires only the hydrated feed RPC that it calls', () => {
  assert.deepEqual(requiredFeedMethods({ type: 'timeline' }), ['app.bsky.feed.getTimeline'])
  assert.deepEqual(requiredFeedMethods({
    type: 'feed', uri: 'at://did:plc:feed/app.bsky.feed.generator/exact',
  }), ['app.bsky.feed.getFeed'])
  assert.match(OAUTH_SCOPE, /rpc\?lxm=app\.bsky\.feed\.getFeed&aud=did:web:api\.bsky\.app%23bsky_appview/)
  assert.doesNotMatch(OAUTH_SCOPE, /getFeedSkeleton|muteActor|unmuteActor/)
  assert.equal(hasRpcPermission(WRITE_OAUTH_SCOPE.split(' '), 'app.bsky.graph.muteActor'), true)
  assert.equal(hasRpcPermission(WRITE_OAUTH_SCOPE.split(' '), 'app.bsky.graph.unmuteActor'), true)
  assert.equal(hasRpcPermission([
    'rpc:app.bsky.feed.getFeedSkeleton?aud=did:web:api.bsky.app#bsky_appview',
  ], 'app.bsky.feed.getFeedSkeleton'), true)
  assert.equal(hasRpcPermission(['rpc?lxm=app.bsky.feed.getTimeline&aud=did:web:api.bsky.app%23bsky_appview'],
    'app.bsky.feed.getFeedSkeleton'), false)
})

test('mute pagination reserves the fixed request budget for targeted profiles', () => {
  assert.deepEqual(observationRequestPlan(60, 40), { profileBatches: 40, mutePages: 20 })
  assert.deepEqual(observationRequestPlan(20, 40), { profileBatches: 20, mutePages: 0 })
  assert.deepEqual(observationRequestPlan(Number.POSITIVE_INFINITY, 40), { profileBatches: 40, mutePages: 50 })
})

function post(
  did: string,
  id: string,
  extra: Record<string, unknown> = {},
) {
  return {
    post: {
      uri: `at://${did}/app.bsky.feed.post/${id}`,
      cid: `cid-${id}`,
      author: profile(did),
      record: { $type: 'app.bsky.feed.post', text: 'must never enter the acquisition summary' },
      indexedAt: '2026-09-09T12:00:00Z',
      ...extra,
    },
    feedContext: 'must never enter the acquisition summary',
  } as any
}

const recordView = (did: string, id: string, embeds?: unknown[]) => ({
  $type: 'app.bsky.embed.record#viewRecord',
  uri: `at://${did}/app.bsky.feed.post/${id}`,
  cid: `cid-${id}`,
  author: profile(did),
  value: { text: 'quoted body must not be retained' },
  indexedAt: '2026-09-09T12:00:00Z',
  embeds,
})

const quote = (view: unknown) => ({
  $type: 'app.bsky.embed.record#view',
  record: view,
})

const quoteWithMedia = (view: unknown) => ({
  $type: 'app.bsky.embed.recordWithMedia#view',
  record: quote(view),
  media: { $type: 'app.bsky.embed.images#view', images: [] },
})

test('extracts ordered feed summaries and bounded quote/repost provenance without content', () => {
  const nested = quoteWithMedia(recordView('did:plc:carol', 'c'))
  const embedded = quote(recordView('did:plc:bob', 'b', [nested]))
  const first = post('did:plc:alice', 'a', { embed: embedded })
  first.reason = {
    $type: 'app.bsky.feed.defs#reasonRepost',
    by: profile('did:plc:introducer', 'intro.test'),
    indexedAt: '2026-09-09T12:00:00Z',
  }
  const duplicate = structuredClone(first)

  const result = extractFeedExposures(
    { type: 'timeline' },
    [first, duplicate],
    '2026-09-09T12:01:00Z',
  )

  assert.equal(result.items.length, 2)
  assert.deepEqual(result.subjects, ['did:plc:alice', 'did:plc:bob', 'did:plc:carol'])
  assert.equal(result.exposure_count, 3, 'same post identity and path is one occurrence')
  assert.deepEqual(result.exposures.map(row => [row.mechanism, row.subject_did, row.path]), [
    ['repost', 'did:plc:alice', 'post.author'],
    ['quote', 'did:plc:bob', 'post.embed.record.author'],
    ['quote', 'did:plc:carol', 'post.embed.record.embeds[0].record.record.author'],
  ])
  assert.equal(result.exposures[0]?.introducer_did, 'did:plc:introducer')
  assert.equal(result.exposures[0]?.introducer_handle, 'intro.test')
  assert.equal(result.exposures[1]?.introducer_did, 'did:plc:alice')
  assert.equal(result.exposures[2]?.introducer_did, 'did:plc:bob')
  assert.equal(result.exposures[2]?.acquired_at, '2026-09-09T12:01:00Z')
  assert.equal(result.exposure_complete, true)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('must never'), false)
  assert.equal(serialized.includes('feedContext'), false)
})

test('marks quote extraction incomplete at the depth and occurrence bounds', () => {
  const tooDeep = quote(recordView('did:plc:one', '1', [
    quote(recordView('did:plc:two', '2')),
  ]))
  const depth = extractFeedExposures(
    { type: 'feed', uri: 'at://did:plc:feed/app.bsky.feed.generator/x' },
    [post('did:plc:top', 'top', { embed: tooDeep })],
    '2026-09-09T12:01:00Z',
    { maxDepth: 1 },
  )
  assert.equal(depth.exposure_complete, false)
  assert.deepEqual(depth.subjects, ['did:plc:top', 'did:plc:one'])

  const occurrences = extractFeedExposures(
    { type: 'timeline' },
    [post('did:plc:a', 'a'), post('did:plc:b', 'b')],
    '2026-09-09T12:01:00Z',
    { maxOccurrences: 1 },
  )
  assert.equal(occurrences.exposure_count, 1)
  assert.equal(occurrences.exposure_complete, false)
})

test('limits each feed item to sixteen evaluated authors', () => {
  const nested = Array.from({ length: MAX_AUTHORS_PER_ITEM + 4 }, (_, index) =>
    quote(recordView(`did:plc:quoted-${index}`, String(index))))
  const result = extractFeedExposures({ type: 'timeline' }, [post('did:plc:top', 'top', {
    embed: quote(recordView('did:plc:first', 'first', nested)),
  })], '2026-09-09T12:01:00Z')
  assert.equal(result.exposure_count, MAX_AUTHORS_PER_ITEM)
  assert.equal(result.exposure_complete, false)
})

test('samples an exact generator URI using feed item count and cursor pagination', async () => {
  const uri = 'at://did:plc:feed/app.bsky.feed.generator/exact'
  const calls: Array<{ source: unknown; limit: number; cursor?: string }> = []
  const pages = [
    { feed: [post('did:plc:a', '1'), post('did:plc:a', '2')], cursor: 'next' },
    { feed: [post('did:plc:b', '3'), post('did:plc:c', '4')], cursor: 'more' },
  ]
  const result = await sampleFeed({ type: 'feed', uri }, 3, async (source, params) => {
    calls.push({ source, ...params })
    return pages.shift()!
  }, '2026-09-09T12:01:00Z')

  assert.deepEqual(calls, [
    { source: { type: 'feed', uri }, limit: 3, cursor: undefined },
    { source: { type: 'feed', uri }, limit: 1, cursor: 'next' },
  ])
  assert.equal(result.items_sampled, 3)
  assert.equal(result.items.length, 3)
  assert.equal(result.subject_count, 2)
  assert.equal(result.sample_complete, true)
  assert.equal(result.complete, true)
  assert.equal(result.source_exhausted, false)
  assert.equal(result.reason, undefined)
})

test('rejects invalid bounds and repeated feed cursors', async () => {
  await assert.rejects(() => sampleFeed({ type: 'timeline' }, 0, async () => ({ feed: [] })), /limit/)
  await assert.rejects(() => sampleFeed({ type: 'feed', uri: 'not-a-feed' }, 1, async () => ({ feed: [] })), /exact at:\/\//)
  let calls = 0
  await assert.rejects(() => sampleFeed({ type: 'timeline' }, 3, async () => ({
    feed: [post('did:plc:a', String(++calls))],
    cursor: 'same',
  })), /repeated cursor/)
})

test('retains bounded partial feed results and reports page progress', async () => {
  const progress: unknown[] = []
  let calls = 0
  const result = await sampleFeed({ type: 'timeline' }, 50, async () => {
    calls += 1
    if (calls === 3) throw new Error('request budget exhausted')
    return { feed: [post(`did:plc:${calls}`, String(calls))], cursor: String(calls) }
  }, '2026-09-09T12:01:00Z', event => { progress.push(event) })
  assert.equal(result.items_sampled, 2)
  assert.equal(result.sample_complete, false)
  assert.equal(result.complete, false)
  assert.match(result.reason!, /partial sample/)
  assert.deepEqual(progress, [
    { phase: 'feed', completed: 1, total: 50, requests: 1 },
    { phase: 'feed', completed: 2, total: 50, requests: 2 },
  ])

  calls = 0
  const pageBound = await sampleFeed({ type: 'timeline' }, MAX_FEED_PAGES + 1, async () => ({
    feed: [post('did:plc:a', String(++calls))], cursor: String(calls),
  }))
  assert.equal(calls, MAX_FEED_PAGES)
  assert.equal(pageBound.items_sampled, MAX_FEED_PAGES)
  assert.equal(pageBound.sample_complete, false)
  assert.equal(pageBound.source_exhausted, false)
  assert.match(pageBound.reason!, /page safety limit/)
})

test('clean source exhaustion is a complete bounded sample on its own axis', async () => {
  const result = await sampleFeed({ type: 'timeline' }, 50, async () => ({
    feed: [post('did:plc:a', '1')],
  }))
  assert.equal(result.items_sampled, 1)
  assert.equal(result.sample_complete, true)
  assert.equal(result.complete, true)
  assert.equal(result.source_exhausted, true)
})

test('classifies relationships conclusively in batches of 30', async () => {
  const subjects = Array.from({ length: RELATIONSHIP_BATCH_SIZE + 1 }, (_, i) => `did:plc:${i}`)
  const batches: string[][] = []
  const result = await acquireRelationships('did:plc:self', subjects, async (actor, others) => {
    assert.equal(actor, 'did:plc:self')
    batches.push(others)
    return {
      actor,
      relationships: others.map((did, index) => ({
        $type: 'app.bsky.graph.defs#relationship',
        did,
        ...(index === 0 ? { following: `at://did:plc:self/app.bsky.graph.follow/${did}` } : {}),
      })),
    }
  })

  assert.deepEqual(batches.map(batch => batch.length), [30, 1])
  assert.equal(result['did:plc:0']?.state, 'following')
  assert.equal(result['did:plc:1']?.state, 'not_following')
  assert.equal(result['did:plc:30']?.state, 'following')
})

test('bounds relationship concurrency and reports completed batches', async () => {
  const subjects = Array.from({ length: RELATIONSHIP_BATCH_SIZE * 6 }, (_, i) => `did:plc:${i}`)
  let active = 0
  let peak = 0
  const progress: Array<{ completed: number; requests: number }> = []
  const result = await acquireRelationships('did:plc:self', subjects, async (_actor, others) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, others[0]!.endsWith(':0') ? 15 : 1))
    active -= 1
    return { relationships: others.map(did => ({ $type: 'app.bsky.graph.defs#relationship', did })) }
  }, { onProgress: event => { progress.push(event) } })

  assert.equal(peak, 4)
  assert.equal(Object.keys(result).length, subjects.length)
  assert.equal(progress.at(-1)?.completed, subjects.length)
  assert.equal(progress.at(-1)?.requests, 6)
  assert.deepEqual(Object.keys(result), subjects, 'concurrent completion does not change deterministic result order')
})

test('retains missing, malformed, duplicate, not-found, and failed relationships as unknown', async () => {
  const subjects = ['did:plc:missing', 'did:plc:duplicate', 'did:plc:notfound', 'did:plc:unknown']
  const result = await acquireRelationships('did:plc:self', subjects, async () => ({
    relationships: [
      { $type: 'app.bsky.graph.defs#relationship', did: 'did:plc:duplicate' },
      { $type: 'app.bsky.graph.defs#relationship', did: 'did:plc:duplicate', following: 'at://follow' },
      { $type: 'app.bsky.graph.defs#notFoundActor', actor: 'did:plc:notfound', notFound: true },
      { $type: 'future.relationship', did: 'did:plc:unknown' },
    ],
  }))
  for (const did of subjects) assert.equal(result[did]?.state, 'unknown')

  const failed = await acquireRelationships('did:plc:self', ['did:plc:a'], async () => {
    throw new Error('network unavailable')
  })
  assert.deepEqual(failed, { 'did:plc:a': { state: 'unknown', reason: 'relationship lookup failed' } })
})
