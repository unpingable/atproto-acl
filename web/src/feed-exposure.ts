import type { AppBskyFeedDefs } from '@atproto/api'
import type {
  FeedExposure,
  FeedItemSummary,
  FeedSample,
  FeedSource,
  FollowingRelationship,
} from './types.js'

export const MAX_FEED_ITEMS = 1_000
export const MAX_QUOTE_DEPTH = 4
export const MAX_EXPOSURES = 5_000
export const MAX_AUTHORS_PER_ITEM = 16
export const MAX_FEED_PAGES = 20
export const RELATIONSHIP_BATCH_SIZE = 30
export const RELATIONSHIP_CONCURRENCY = 4

export type AcquisitionProgress = {
  phase: 'feed' | 'relationships' | 'mutes' | 'profiles'
  completed: number
  total?: number
  requests: number
}

export type ProgressReporter = (progress: AcquisitionProgress) => void | Promise<void>

export type FeedSampleResult = FeedSample & {
  sample_complete: boolean
  source_exhausted: boolean
}

type FeedViewPost = AppBskyFeedDefs.FeedViewPost
type FeedPage = { feed: FeedViewPost[]; cursor?: string }

export type FeedPageFetcher = (
  source: FeedSource,
  params: { limit: number; cursor?: string },
) => Promise<FeedPage>

export type RelationshipPageFetcher = (
  actor: string,
  others: string[],
) => Promise<{ actor?: string; relationships: unknown[] }>

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function actor(value: unknown): { did: string; handle?: string } | undefined {
  const candidate = record(value)
  if (!candidate || typeof candidate.did !== 'string' || !candidate.did.startsWith('did:')) return undefined
  return {
    did: candidate.did,
    handle: typeof candidate.handle === 'string' ? candidate.handle : undefined,
  }
}

function repostIntroducer(item: FeedViewPost) {
  const reason = record(item.reason)
  if (reason?.$type !== 'app.bsky.feed.defs#reasonRepost') return undefined
  const by = actor(reason.by)
  if (!by) return undefined
  return by
}

export function extractFeedExposures(
  source: FeedSource,
  items: FeedViewPost[],
  acquiredAt: string,
  options: { maxDepth?: number; maxOccurrences?: number } = {},
): Pick<FeedSample, 'items' | 'subjects' | 'exposures' | 'exposure_count' | 'subject_count' | 'exposure_complete'> {
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? MAX_QUOTE_DEPTH, MAX_QUOTE_DEPTH))
  const maxOccurrences = Math.max(1, Math.min(options.maxOccurrences ?? MAX_EXPOSURES, MAX_EXPOSURES))
  const surface = source.type === 'timeline' ? 'timeline' : 'generator'
  const summaries: FeedItemSummary[] = []
  const exposures: FeedExposure[] = []
  const subjects = new Set<string>()
  const occurrences = new Set<string>()
  let exposureComplete = true
  let itemOccurrences = 0

  const add = (exposure: FeedExposure) => {
    const key = [exposure.surface, exposure.post_uri, exposure.post_cid, exposure.path].join('\u0000')
    if (occurrences.has(key)) return
    if (itemOccurrences >= MAX_AUTHORS_PER_ITEM) { exposureComplete = false; return }
    if (exposures.length >= maxOccurrences) { exposureComplete = false; return }
    occurrences.add(key)
    exposures.push(exposure)
    itemOccurrences += 1
    subjects.add(exposure.subject_did)
  }

  const visitEmbed = (
    value: unknown,
    path: string,
    depth: number,
    position: number,
    quotingAuthor: { did: string; handle?: string } | undefined,
    visited: WeakSet<object>,
  ) => {
    const embed = record(value)
    if (!embed) return
    if (visited.has(embed)) { exposureComplete = false; return }
    visited.add(embed)
    if (depth > maxDepth) { exposureComplete = false; return }

    if (embed.$type === 'app.bsky.embed.recordWithMedia#view') {
      visitEmbed(embed.record, `${path}.record`, depth, position, quotingAuthor, visited)
      return
    }
    if (embed.$type !== 'app.bsky.embed.record#view') return

    const quoted = record(embed.record)
    if (!quoted || quoted.$type !== 'app.bsky.embed.record#viewRecord') return
    const author = actor(quoted.author)
    const uri = typeof quoted.uri === 'string' ? quoted.uri : undefined
    const cid = typeof quoted.cid === 'string' ? quoted.cid : undefined
    if (author && uri && cid) {
      add({
        surface,
        mechanism: 'quote',
        subject_did: author.did,
        subject_handle: author.handle,
        introducer_did: quotingAuthor?.did,
        introducer_handle: quotingAuthor?.handle,
        post_uri: uri,
        post_cid: cid,
        path: `${path}.record.author`,
        position,
        acquired_at: acquiredAt,
      })
    } else {
      exposureComplete = false
    }

    if (depth === maxDepth) {
      if (Array.isArray(quoted.embeds) && quoted.embeds.length > 0) exposureComplete = false
      return
    }
    if (Array.isArray(quoted.embeds)) {
      quoted.embeds.forEach((nested, index) => {
        visitEmbed(nested, `${path}.record.embeds[${index}]`, depth + 1, position, author, visited)
      })
    }
  }

  items.forEach((item, position) => {
    itemOccurrences = 0
    const top = actor(item.post?.author)
    const uri = item.post?.uri
    const cid = item.post?.cid
    const introducer = repostIntroducer(item)
    if (!top || typeof uri !== 'string' || typeof cid !== 'string') {
      exposureComplete = false
      return
    }
    summaries.push({
      position,
      post_uri: uri,
      post_cid: cid,
      author_did: top.did,
      author_handle: top.handle,
      introducer_did: introducer?.did,
      introducer_handle: introducer?.handle,
    })
    add({
      surface,
      mechanism: introducer ? 'repost' : 'top_level',
      subject_did: top.did,
      subject_handle: top.handle,
      introducer_did: introducer?.did,
      introducer_handle: introducer?.handle,
      post_uri: uri,
      post_cid: cid,
      path: 'post.author',
      position,
      acquired_at: acquiredAt,
    })
    if (item.post.embed) {
      visitEmbed(item.post.embed, 'post.embed', 1, position, top, new WeakSet())
    }
  })

  return {
    items: summaries,
    subjects: [...subjects],
    exposures,
    exposure_count: exposures.length,
    subject_count: subjects.size,
    exposure_complete: exposureComplete,
  }
}

export async function sampleFeed(
  source: FeedSource,
  limit: number,
  fetchPage: FeedPageFetcher,
  acquiredAt = new Date().toISOString(),
  onProgress?: ProgressReporter,
): Promise<FeedSampleResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FEED_ITEMS) {
    throw new Error(`feed item limit must be an integer from 1 to ${MAX_FEED_ITEMS}`)
  }
  if (source.type === 'feed' && !source.uri.startsWith('at://')) {
    throw new Error('feed generator must be an exact at:// URI')
  }

  const items: FeedViewPost[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let sourceExhausted = false
  let pages = 0
  let interrupted = false
  while (items.length < limit && pages < MAX_FEED_PAGES) {
    const remaining = limit - items.length
    let page: FeedPage
    try {
      page = await fetchPage(source, { limit: Math.min(100, remaining), cursor })
    } catch {
      if (items.length === 0) throw new Error('feed source unavailable')
      interrupted = true
      break
    }
    pages += 1
    items.push(...page.feed.slice(0, remaining))
    await onProgress?.({ phase: 'feed', completed: items.length, total: limit, requests: pages })
    if (page.feed.length > remaining) break
    cursor = page.cursor
    if (!cursor) { sourceExhausted = true; break }
    if (cursors.has(cursor)) throw new Error('feed source returned a repeated cursor')
    cursors.add(cursor)
    if (page.feed.length === 0) throw new Error('feed source returned an empty page with a cursor')
  }

  const extracted = extractFeedExposures(source, items, acquiredAt)
  const limitReached = items.length === limit
  const sampleComplete = !interrupted && (limitReached || sourceExhausted) && extracted.exposure_complete
  const reasons: string[] = []
  if (interrupted) {
    reasons.push('feed page acquisition stopped after a partial sample')
  } else if (!sampleComplete && pages >= MAX_FEED_PAGES && items.length < limit) {
    reasons.push('feed page safety limit reached before configured item limit')
  }
  if (!extracted.exposure_complete) reasons.push('exposure extraction limit or malformed hydrated quote reached')
  return {
    source,
    ...extracted,
    items_sampled: items.length,
    sample_complete: sampleComplete,
    source_exhausted: sourceExhausted,
    complete: sampleComplete,
    reason: reasons.length ? reasons.join('; ') : undefined,
  }
}

export async function acquireRelationships(
  actorDid: string,
  subjects: string[],
  fetchPage: RelationshipPageFetcher,
  options: { concurrency?: number; onProgress?: ProgressReporter } = {},
): Promise<Record<string, FollowingRelationship>> {
  const requested = [...new Set(subjects)]
  const output: Record<string, FollowingRelationship> = {}
  const batches = Array.from(
    { length: Math.ceil(requested.length / RELATIONSHIP_BATCH_SIZE) },
    (_, index) => requested.slice(index * RELATIONSHIP_BATCH_SIZE, (index + 1) * RELATIONSHIP_BATCH_SIZE),
  )
  const concurrency = Math.max(1, Math.min(options.concurrency ?? RELATIONSHIP_CONCURRENCY, RELATIONSHIP_CONCURRENCY))
  let next = 0
  let completed = 0
  let completedBatches = 0
  const process = async (batch: string[]) => {
    let page: Awaited<ReturnType<RelationshipPageFetcher>>
    try {
      page = await fetchPage(actorDid, batch)
    } catch {
      for (const did of batch) output[did] = { state: 'unknown', reason: 'relationship lookup failed' }
      return
    }
    if (page.actor && page.actor !== actorDid) {
      for (const did of batch) output[did] = { state: 'unknown', reason: 'relationship response actor mismatch' }
      return
    }

    const rows = new Map<string, UnknownRecord[]>()
    for (const value of page.relationships) {
      const row = record(value)
      const did = typeof row?.did === 'string'
        ? row.did
        : typeof row?.actor === 'string' ? row.actor : undefined
      if (!did || !batch.includes(did)) continue
      rows.set(did, [...(rows.get(did) ?? []), row!])
    }
    for (const did of batch) {
      const matches = rows.get(did) ?? []
      if (matches.length !== 1) {
        output[did] = { state: 'unknown', reason: matches.length ? 'duplicate relationship rows' : 'relationship missing from response' }
        continue
      }
      const row = matches[0]!
      if (row.$type === 'app.bsky.graph.defs#notFoundActor' || row.notFound === true) {
        output[did] = { state: 'unknown', reason: 'subject account was not found' }
      } else if (row.$type && row.$type !== 'app.bsky.graph.defs#relationship') {
        output[did] = { state: 'unknown', reason: 'unrecognized relationship response' }
      } else if (typeof row.following === 'string' && row.following.length > 0) {
        output[did] = { state: 'following', following_uri: row.following }
      } else {
        output[did] = { state: 'not_following' }
      }
    }
  }
  const worker = async () => {
    while (true) {
      const index = next++
      const batch = batches[index]
      if (!batch) return
      await process(batch)
      completed += batch.length
      completedBatches += 1
      await options.onProgress?.({
        phase: 'relationships',
        completed,
        total: requested.length,
        requests: completedBatches,
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()))
  return Object.fromEntries(requested.map(did => [did, output[did]!]))
}
