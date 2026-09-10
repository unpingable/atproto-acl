import { parse, stringify } from 'yaml'
import { BSKY38_URL } from './bsky38.js'

export const CORNELL_PUBLISHER_DID = 'did:plc:oubsyca6hhgqhmbbk27lvs7c'
export const BSKY38_PROVIDER_DID = 'did:web:bsky38.com'
export const DISCOVER_URI = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot'
export const CORNELL_LABELS = {
  monthly: {
    value: 'monthly-posts-over-twenty-per-day',
    title: 'Averaged more than 20 posts a day this month',
  },
  dailyPosts: {
    value: 'made-over-thirty-posts-yesterday',
    title: 'Made more than 30 posts yesterday',
  },
  dailyReplies: {
    value: 'made-over-thirty-replies-yesterday',
    title: 'Made more than 30 replies yesterday',
  },
} as const

export type GuidedPolicy = {
  supported: boolean
  sourceType: 'feeds' | 'follows' | 'timeline' | 'labeled_stream' | 'explicit_dids' | 'external_snapshot'
  limit: number
  subjects: string[]
  monthly: boolean
  dailyPair: boolean
  reason?: string
}

const leaf = (value: unknown, label: string) => {
  const item = value as Record<string, unknown>
  return item?.source === 'cornell' && item?.label === label && Object.keys(item).length === 2
}

const dailyPair = (value: unknown) => {
  const item = value as Record<string, unknown>
  if (!item || !Array.isArray(item.all) || item.all.length !== 2 || Object.keys(item).length !== 1) return false
  return leaf(item.all[0], CORNELL_LABELS.dailyPosts.value) && leaf(item.all[1], CORNELL_LABELS.dailyReplies.value)
}

export function readGuidedPolicy(body: string): GuidedPolicy {
  const unsupported = (reason: string): GuidedPolicy => ({
    supported: false, sourceType: 'timeline', limit: 500, subjects: [], monthly: true, dailyPair: true, reason,
  })
  let value: Record<string, any>
  try { value = parse(body) as Record<string, any> } catch { return unsupported('Fix the YAML errors before returning to the guided editor.') }
  const providers = value?.providers
  const bskySource = value?.sources?.[0]
  const bskyRule = value?.rules?.[0]
  if (providers && Object.keys(providers).length === 1 && providers.bsky38?.type === 'external_list' &&
      providers.bsky38?.did === BSKY38_PROVIDER_DID && Object.keys(providers.bsky38).length === 2 &&
      Array.isArray(value.sources) && value.sources.length === 1 && bskySource?.type === 'external_snapshot' &&
      bskySource.provider === 'bsky38' && bskySource.url === BSKY38_URL && bskySource.limit === 38 &&
      Array.isArray(value.rules) && value.rules.length === 1 && bskyRule?.name === 'bsky38-membership' &&
      bskyRule?.disposition === 'quarantine' && bskyRule?.when?.source === 'bsky38' && bskyRule?.when?.label === 'member' &&
      ['exempt', 'allow', 'keep_muted'].every(key => Array.isArray(value[key] ?? []) && !(value[key] ?? []).length)) {
    return { supported: true, sourceType: 'external_snapshot', limit: 38, subjects: [], monthly: false, dailyPair: false }
  }
  if (!providers || Object.keys(providers).length !== 1 || providers.cornell?.type !== 'atproto_labels' ||
      providers.cornell?.did !== CORNELL_PUBLISHER_DID || Object.keys(providers.cornell).length !== 2) {
    return unsupported('This policy uses publisher settings the guided editor cannot represent.')
  }
  if (!Array.isArray(value.sources) || !value.sources.length) {
    return unsupported('This policy uses account sources the guided editor cannot represent.')
  }
  const feedSources = value.sources.length === 2 && value.sources[0]?.type === 'feed_exposure' &&
    value.sources[0]?.surface === 'timeline' && value.sources[1]?.type === 'feed_exposure' &&
    value.sources[1]?.surface === 'generator'
  if (!feedSources && (value.sources.length !== 1 ||
      !['follows', 'timeline', 'labeled_stream', 'explicit_dids'].includes(value.sources[0]?.type))) {
    return unsupported('This policy uses account sources the guided editor cannot represent.')
  }
  const source = value.sources[0]
  if (feedSources && (Object.keys(source).some(key => !['type', 'surface', 'limit', 'followed'].includes(key)) ||
      Object.keys(value.sources[1]).some(key => !['type', 'surface', 'feed_uri', 'limit', 'followed'].includes(key)) ||
      source.limit !== value.sources[1].limit || source.followed !== 'review' ||
      value.sources[1].followed !== 'review' || value.sources[1].feed_uri !== DISCOVER_URI)) {
    return unsupported('This feed scope has advanced options.')
  }
  const allowedSourceKeys = source.type === 'labeled_stream' ? ['type', 'provider', 'limit'] :
    source.type === 'explicit_dids' ? ['type', 'dids'] : ['type', 'limit']
  if (!feedSources && (Object.keys(source).some(key => !allowedSourceKeys.includes(key)) ||
      (source.type === 'labeled_stream' && source.provider !== 'cornell'))) {
    return unsupported('This account source has advanced options.')
  }
  if (!Array.isArray(value.rules) || value.rules.length !== 1 || value.rules[0]?.name !== 'sustained-or-combined-posting' ||
      value.rules[0]?.disposition !== 'quarantine') {
    return unsupported('This policy has rules the guided editor cannot represent.')
  }
  if (['exempt', 'allow', 'keep_muted'].some(key => !Array.isArray(value[key] ?? []) || (value[key] ?? []).length)) {
    return unsupported('This policy contains advanced inline overrides. Manage web overrides separately or continue in YAML.')
  }
  const when = value.rules[0].when
  const alternatives = Array.isArray(when?.any) && Object.keys(when).length === 1 ? when.any : [when]
  const monthly = alternatives.some((item: unknown) => leaf(item, CORNELL_LABELS.monthly.value))
  const daily = alternatives.some((item: unknown) => dailyPair(item))
  if (!alternatives.length || alternatives.some((item: unknown) => !leaf(item, CORNELL_LABELS.monthly.value) && !dailyPair(item))) {
    return unsupported('This rule contains conditions the guided editor cannot represent.')
  }
  return {
    supported: true,
    sourceType: feedSources ? 'feeds' : source.type,
    limit: Number.isInteger(source.limit) ? source.limit : 500,
    subjects: source.type === 'explicit_dids' ? source.dids : [],
    monthly,
    dailyPair: daily,
  }
}

export function buildGuidedPolicy(account: string, input: {
  sourceType: string
  limit: string | number
  subjects?: string[]
  monthly: boolean
  dailyPair: boolean
}) {
  if (!['feeds', 'follows', 'timeline', 'labeled_stream', 'explicit_dids', 'external_snapshot'].includes(input.sourceType)) throw new Error('Choose a supported account source.')
  const limit = Number(input.limit)
  const ceiling = input.sourceType === 'feeds' ? 500 : input.sourceType === 'timeline' ? 1000 : 5000
  if (input.sourceType !== 'explicit_dids' && (!Number.isInteger(limit) || limit < 1 || limit > ceiling)) {
    throw new Error(`Account limit must be between 1 and ${ceiling}.`)
  }
  if (input.sourceType === 'explicit_dids' && (!input.subjects?.length || input.subjects.some(x => !x.startsWith('did:')))) {
    throw new Error('Specific accounts must resolve to at least one DID.')
  }
  if (input.sourceType === 'external_snapshot') {
    return stringify({
      version: 1, account,
      providers: { bsky38: { type: 'external_list', did: BSKY38_PROVIDER_DID } },
      sources: [{ type: 'external_snapshot', provider: 'bsky38', url: BSKY38_URL, limit: 38 }],
      rules: [{ name: 'bsky38-membership', disposition: 'quarantine', when: { source: 'bsky38', label: 'member' } }],
      exempt: [], allow: [], keep_muted: [],
    }, { lineWidth: 0 })
  }
  if (!input.monthly && !input.dailyPair) throw new Error('Choose at least one activity label condition.')
  const alternatives: Record<string, unknown>[] = []
  if (input.monthly) alternatives.push({ source: 'cornell', label: CORNELL_LABELS.monthly.value })
  if (input.dailyPair) alternatives.push({ all: [
    { source: 'cornell', label: CORNELL_LABELS.dailyPosts.value },
    { source: 'cornell', label: CORNELL_LABELS.dailyReplies.value },
  ] })
  const when = alternatives.length === 1 ? alternatives[0] : { any: alternatives }
  const sources = input.sourceType === 'feeds' ? [
    { type: 'feed_exposure', surface: 'timeline', limit, followed: 'review' },
    { type: 'feed_exposure', surface: 'generator', feed_uri: DISCOVER_URI, limit, followed: 'review' },
  ] :
    input.sourceType === 'labeled_stream' ? [{ type: 'labeled_stream', provider: 'cornell', limit }] :
    input.sourceType === 'explicit_dids' ? { type: 'explicit_dids', dids: input.subjects } :
    { type: input.sourceType, limit }
  return stringify({
    version: 1,
    account,
    providers: { cornell: { type: 'atproto_labels', did: CORNELL_PUBLISHER_DID } },
    sources: Array.isArray(sources) ? sources : [sources],
    rules: [{ name: 'sustained-or-combined-posting', disposition: 'quarantine', when }],
    exempt: [], allow: [], keep_muted: [],
  }, { lineWidth: 0 })
}

export const poastersPolicy = (account: string) => buildGuidedPolicy(account, {
  sourceType: 'feeds', limit: 500, monthly: true, dailyPair: true,
})

export const bsky38Policy = (account: string) => buildGuidedPolicy(account, {
  sourceType: 'external_snapshot', limit: 38, monthly: false, dailyPair: false,
})
