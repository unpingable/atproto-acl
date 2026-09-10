export type RemoteState = {
  known: boolean
  handle?: string
  display_name?: string
  avatar?: string
  direct?: boolean
  muted?: boolean
  only_reposts?: boolean
  only_quotes?: boolean
  list?: string | null
  blocked?: boolean
  relationship?: FollowingState
  relationship_reason?: string
}

export type FeedSource =
  | { type: 'timeline' }
  | { type: 'feed'; uri: string }

export type FeedItemSummary = {
  position: number
  post_uri: string
  post_cid: string
  author_did: string
  author_handle?: string
  introducer_did?: string
  introducer_handle?: string
}

export type FeedExposure = {
  surface: 'timeline' | 'generator'
  mechanism: 'top_level' | 'repost' | 'quote'
  subject_did: string
  subject_handle?: string
  introducer_did?: string
  introducer_handle?: string
  post_uri: string
  post_cid: string
  path: string
  position: number
  acquired_at: string
}

export type FeedSample = {
  source: FeedSource
  items: FeedItemSummary[]
  subjects: string[]
  items_sampled: number
  exposure_count: number
  subject_count: number
  exposures: FeedExposure[]
  /** The configured bounded sample was acquired without interruption. */
  sample_complete: boolean
  /** The upstream feed ended before or exactly at the configured sample bound. */
  source_exhausted: boolean
  complete: boolean
  exposure_complete: boolean
  reason?: string
}

export type FollowingState = 'following' | 'not_following' | 'unknown'

export type FollowingRelationship = {
  state: FollowingState
  following_uri?: string
  reason?: string
}

export type Acquisition = {
  subjects: string[]
  identities: Record<string, string>
  observations?: unknown[]
  coverage?: unknown[]
  discovery: unknown[]
  remote: Record<string, RemoteState>
  acquisition_hash: string
}

export type ReceiptRow = {
  subject: string
  desired: string
  action: string
  reason: string
  basis: string
  fingerprint: string
  manual_review_required: boolean
  observed: RemoteState
  evaluation: {
    matches: string[]
    unresolved: string[]
    evidence_ids: string[]
    reason_codes: string[]
  }
  [key: string]: unknown
}

export type Receipt = {
  id: string
  account: string
  policy_hash: string
  effective_config_hash: string
  override_hash: string
  evaluated_at: string
  complete: boolean
  incomplete_reasons?: string[]
  evidence: Array<{ evidence_id?: string; provider?: string; property?: string; observed_at: string; expires_at?: string; [key: string]: unknown }>
  coverage?: Array<{ provider: string; subject: string; complete: boolean; reason?: string; checked_at?: string }>
  discovery?: Array<{ source: string; subjects?: string[]; complete: boolean; reason?: string;
    source_url?: string; retrieved_at?: string; members?: Array<Record<string, unknown>> }>
  completeness?: Record<string, boolean>
  rows: ReceiptRow[]
  [key: string]: unknown
}

export type AccountProgress = {
  phase: 'feed' | 'relationships' | 'mutes' | 'profiles'
  completed: number
  total?: number
  requests?: number
}

export interface AccountClient {
  readonly did: string
  requestCount(): number
  resetRequestCount(limit?: number): void
  profile(): Promise<{ did: string; handle: string; displayName?: string; pds?: string; scopes?: string[] }>
  resolve(actors: string[]): Promise<Record<string, string>>
  follows(limit: number): Promise<{ dids: string[]; complete: boolean; reason?: string }>
  timeline(limit: number): Promise<{ dids: string[]; complete: boolean; reason?: string }>
  feed(source: FeedSource, limit: number, onProgress?: (progress: AccountProgress) => void | Promise<void>): Promise<FeedSample>
  relationships(subjects: string[], onProgress?: (progress: AccountProgress) => void | Promise<void>): Promise<Record<string, FollowingRelationship>>
  observe(subjects: string[], onProgress?: (progress: AccountProgress) => void | Promise<void>): Promise<Record<string, RemoteState>>
  mute(did: string): Promise<void>
  unmute(did: string): Promise<void>
  disconnect(): Promise<void>
}

export interface AccountProvider {
  restore(did: string): Promise<AccountClient>
}
