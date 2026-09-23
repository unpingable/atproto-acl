import { createHash } from 'node:crypto'
import type { FeedSample } from './types.js'

export const QUENCH_CAPTURE_SCHEMA = 'atproto-acl.quench-exposure.v1'

export type QuenchObservation = {
  observation_id: string
  observed_at: string
  feed: 'home' | 'discover'
  position: number
  post_uri: string
  post_cid: string
  author_did: string
  lineage_status: 'determinate' | 'indeterminate'
  lineage_uri?: string
  parent_uri?: string
  repost_target_uri?: string
  reason_indeterminate?: 'missing_root' | 'malformed_lineage' | 'conflicting_lineage'
}

export type QuenchCapture = {
  schema: typeof QUENCH_CAPTURE_SCHEMA
  capture_started_at: string
  capture_ended_at: string
  auth_mechanism: 'existing_atproto_oauth_read_session'
  writes_performed: false
  requested_bounds: { home: number; discover: number }
  observations: QuenchObservation[]
}

export function assertExactCaptureSamples(
  home: Pick<FeedSample, 'items'>,
  discover: Pick<FeedSample, 'items'>,
  bound: number,
) {
  if (home.items.length !== bound || discover.items.length !== bound) {
    throw new Error('bounded Quench capture is incomplete; no coherent result may be retained')
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function sanitizeFeedSample(
  feed: 'home' | 'discover',
  sample: Pick<FeedSample, 'items' | 'exposures'>,
  observedAt: string,
): QuenchObservation[] {
  const reposts = new Set(sample.exposures
    .filter(item => item.mechanism === 'repost')
    .map(item => `${item.position}\u0000${item.post_uri}`))
  return sample.items.map(item => {
    const state = item.lineage_status
    const determinate = (state === 'root' || state === 'reply') && typeof item.lineage_uri === 'string'
    const reason = state === 'malformed' ? 'malformed_lineage' as const
      : state === 'conflict' ? 'conflicting_lineage' as const
      : 'missing_root' as const
    const stable = {
      observed_at: observedAt, feed, position: item.position,
      post_uri: item.post_uri, post_cid: item.post_cid,
    }
    return {
      observation_id: digest(stable),
      ...stable,
      author_did: item.author_did,
      lineage_status: determinate ? 'determinate' as const : 'indeterminate' as const,
      ...(determinate ? { lineage_uri: item.lineage_uri } : { reason_indeterminate: reason }),
      ...(item.parent_uri ? { parent_uri: item.parent_uri } : {}),
      ...(reposts.has(`${item.position}\u0000${item.post_uri}`) ? { repost_target_uri: item.post_uri } : {}),
    }
  })
}

function uniqueOrdered(input: QuenchObservation[]) {
  const seen = new Set<string>()
  return input.filter(item => {
    if (seen.has(item.observation_id)) return false
    seen.add(item.observation_id)
    return true
  })
}

export type QuenchAnalysis = ReturnType<typeof analyzeQuenchObservations>

export function analyzeQuenchObservations(input: QuenchObservation[]) {
  const observations = uniqueOrdered(input)
  const determinate = observations.filter(item => item.lineage_status === 'determinate' && item.lineage_uri)
  const indeterminate = observations.filter(item => item.lineage_status === 'indeterminate')
  const byLineage = new Map<string, QuenchObservation[]>()
  for (const item of determinate) {
    const rows = byLineage.get(item.lineage_uri!) ?? []
    rows.push(item)
    byLineage.set(item.lineage_uri!, rows)
  }
  const lineages = [...byLineage.entries()]
  const repeated = lineages.filter(([, rows]) => rows.length >= 2)
  const suppressed = repeated.flatMap(([, rows]) => rows.slice(1))
  const actorLineages = new Map<string, Set<string>>()
  for (const item of determinate) {
    const values = actorLineages.get(item.author_did) ?? new Set<string>()
    values.add(item.lineage_uri!)
    actorLineages.set(item.author_did, values)
  }
  const selectiveSuppressed = suppressed.filter(item => (actorLineages.get(item.author_did)?.size ?? 0) > 1)
  let actorUnrelated = 0
  let equivalent = 0
  for (const [lineage, rows] of repeated) {
    const trigger = rows[0]!
    const triggerIndex = observations.indexOf(trigger)
    const quenchSet = new Set(rows.slice(1).map(item => item.observation_id))
    const actorSet = new Set(observations.slice(triggerIndex + 1)
      .filter(item => item.author_did === trigger.author_did)
      .map(item => item.observation_id))
    actorUnrelated += [...actorSet].filter(id => !quenchSet.has(id)).length
    if (quenchSet.size === actorSet.size && [...quenchSet].every(id => actorSet.has(id))) equivalent += 1
  }
  const distribution: Record<string, number> = {}
  for (const [, rows] of lineages) distribution[String(rows.length)] = (distribution[String(rows.length)] ?? 0) + 1
  const countAtLeast = (minimum: number) => lineages.filter(([, rows]) => rows.length >= minimum).length
  const fraction = (part: number, whole: number) => whole ? part / whole : 0
  return {
    total_exposures: observations.length,
    duplicate_observations_removed: input.length - observations.length,
    determinate_exposures: determinate.length,
    indeterminate_exposures: indeterminate.length,
    determinate_fraction: fraction(determinate.length, observations.length),
    distinct_determinate_lineages: lineages.length,
    lineage_exposure_count_distribution: Object.fromEntries(Object.entries(distribution)
      .sort(([a], [b]) => Number(a) - Number(b))),
    lineages_exactly_once: lineages.length - countAtLeast(2),
    lineages_2_plus: countAtLeast(2),
    lineages_3_plus: countAtLeast(3),
    lineages_5_plus: countAtLeast(5),
    fraction_lineages_2_plus: fraction(countAtLeast(2), lineages.length),
    fraction_lineages_3_plus: fraction(countAtLeast(3), lineages.length),
    fraction_lineages_5_plus: fraction(countAtLeast(5), lineages.length),
    exposures_in_repeated_lineages: repeated.reduce((total, [, rows]) => total + rows.length, 0),
    fraction_exposures_in_repeated_lineages: fraction(
      repeated.reduce((total, [, rows]) => total + rows.length, 0), observations.length),
    repeated_lineages_one_actor: repeated.filter(([, rows]) => new Set(rows.map(item => item.author_did)).size === 1).length,
    repeated_lineages_multiple_actors: repeated.filter(([, rows]) => new Set(rows.map(item => item.author_did)).size > 1).length,
    quench_subsequent_exposures_suppressed: suppressed.length,
    quench_suppressed_by_actors_seen_in_unrelated_lineages: selectiveSuppressed.length,
    actor_policy_unrelated_exposures_removed: actorUnrelated,
    repeated_lineages_actor_and_quench_equivalent: equivalent,
    lineages_where_quench_has_no_effect: lineages.length - repeated.length,
  }
}

export function analyzeCapture(capture: QuenchCapture) {
  const home = capture.observations.filter(item => item.feed === 'home')
  const discover = capture.observations.filter(item => item.feed === 'discover')
  return {
    schema: 'atproto-acl.quench-analysis.v1',
    capture_schema: capture.schema,
    home: analyzeQuenchObservations(home),
    discover: analyzeQuenchObservations(discover),
    combined: analyzeQuenchObservations(capture.observations),
    combined_order: 'home capture order followed by discover capture order',
  }
}

export function assertBodyFreeCapture(value: unknown): asserts value is QuenchCapture {
  const capture = value as QuenchCapture
  if (capture?.schema !== QUENCH_CAPTURE_SCHEMA || !Array.isArray(capture.observations)) {
    throw new Error('unsupported Quench capture')
  }
  const allowed = new Set([
    'observation_id', 'observed_at', 'feed', 'position', 'post_uri', 'post_cid', 'author_did',
    'lineage_status', 'lineage_uri', 'parent_uri', 'repost_target_uri', 'reason_indeterminate',
  ])
  for (const item of capture.observations) {
    if (Object.keys(item).some(key => !allowed.has(key))) throw new Error('capture contains a non-allowlisted field')
    if (!['home', 'discover'].includes(item.feed)) throw new Error('capture contains an unknown feed')
    if (!item.post_uri.startsWith('at://') || !item.author_did.startsWith('did:')) throw new Error('capture identity is invalid')
    if (item.lineage_status === 'determinate' && !item.lineage_uri?.startsWith('at://')) {
      throw new Error('determinate lineage is missing its AT URI')
    }
    if (item.lineage_status === 'indeterminate' && !item.reason_indeterminate) {
      throw new Error('indeterminate lineage is missing its reason')
    }
  }
  const serialized = JSON.stringify(capture).toLowerCase()
  for (const forbidden of ['authorization', 'access_token', 'refresh_token', 'dpop', 'text', 'alt', 'media', 'description', 'embed']) {
    if (serialized.includes(`"${forbidden}"`)) throw new Error(`capture contains forbidden field ${forbidden}`)
  }
}
