import type { AccountClient, AccountProvider, Acquisition, RemoteState } from '../src/types.js'

export class FakeAccounts implements AccountProvider {
  profiles = new Map<string, { did: string; handle: string; displayName?: string; pds?: string; scopes?: string[] }>()
  remote = new Map<string, Map<string, RemoteState>>()
  failAfterEffect = new Set<string>()
  rateLimit = new Set<string>()
  readbackLag = new Map<string, number>()
  muteCalls = new Map<string, number>()
  revoked = new Set<string>()
  following = new Map<string, Set<string>>()

  add(did: string, handle: string) {
    this.profiles.set(did, { did, handle })
    this.remote.set(did, new Map())
    this.following.set(did, new Set())
  }

  async restore(did: string): Promise<AccountClient> {
    const profile = this.profiles.get(did)
    if (!profile || this.revoked.has(did)) {
      const error = new Error('session revoked') as Error & { status: number }; error.status = 401; throw error
    }
    const states = this.remote.get(did)!
    let requests = 0
    return {
      did,
      requestCount: () => requests,
      resetRequestCount: () => { requests = 0 },
      profile: async () => { requests += 1; return profile },
      resolve: async actors => Object.fromEntries(actors.map(actor => [
        actor, actor.startsWith('did:') ? actor : [...this.profiles.values()].find(p => p.handle === actor)?.did ?? did,
      ])),
      follows: async () => ({ dids: [...states.keys()], complete: true }),
      timeline: async () => ({ dids: [...states.keys()], complete: true }),
      feed: async source => {
        requests += 1
        const acquired = new Date().toISOString()
        const exposures = [...states.keys()].map((subject, position) => ({
          surface: source.type === 'timeline' ? 'timeline' as const : 'generator' as const,
          mechanism: 'top_level' as const, subject_did: subject,
          post_uri: `at://${subject}/app.bsky.feed.post/${position}`,
          post_cid: `cid-${position}`, path: 'post.author', position, acquired_at: acquired,
        }))
        return { source, items: exposures.map(item => ({ position: item.position, post_uri: item.post_uri,
          post_cid: item.post_cid, author_did: item.subject_did })), subjects: [...states.keys()],
          items_sampled: states.size, exposure_count: exposures.length, subject_count: states.size,
          exposures, complete: true, exposure_complete: true }
      },
      relationships: async subjects => {
        requests += Math.ceil(subjects.length / 30)
        const followed = this.following.get(did)!
        return Object.fromEntries(subjects.map(subject => [subject, {
          state: followed.has(subject) ? 'following' as const : 'not_following' as const,
        }]))
      },
      observe: async subjects => Object.fromEntries(subjects.map(subject => {
        const state = states.get(subject) ?? { known: true, direct: false, muted: false }
        const lag = this.readbackLag.get(subject) ?? 0
        if (lag > 0 && state.direct) {
          this.readbackLag.set(subject, lag - 1)
          return [subject, { ...state, direct: false, muted: false }]
        }
        return [subject, state]
      })),
      mute: async subject => {
        this.muteCalls.set(subject, (this.muteCalls.get(subject) ?? 0) + 1)
        if (this.rateLimit.delete(subject)) {
          const error = new Error('rate limited') as Error & { status: number }; error.status = 429; throw error
        }
        states.set(subject, { known: true, direct: true, muted: true })
        if (this.failAfterEffect.delete(subject)) throw new Error('connection dropped')
      },
      unmute: async subject => {
        states.set(subject, { known: true, direct: false, muted: false })
        if (this.failAfterEffect.delete(subject)) throw new Error('connection dropped')
      },
      disconnect: async () => { this.revoked.add(did) },
    }
  }
}

export function acquisition(accounts: FakeAccounts, did: string, observations: any[]): Partial<Acquisition> {
  const subjects = ['did:plc:alice', 'did:plc:bob', 'did:plc:carol']
  const state = accounts.remote.get(did)!
  const providers = ['did:plc:activity', 'did:plc:trusted']
  return {
    subjects,
    identities: { [did]: did },
    observations,
    coverage: subjects.flatMap(subject => providers.map(provider => ({
      provider, subject, complete: !(subject === 'did:plc:carol' && provider === 'did:plc:trusted'),
      checked_at: '2026-09-08T12:01:00Z',
      reason: subject === 'did:plc:carol' && provider === 'did:plc:trusted' ? 'publisher unavailable' : '',
    }))),
    discovery: [{ source: 'explicit_dids', subjects, complete: true }],
    remote: Object.fromEntries(subjects.map(subject => [subject, state.get(subject) ?? { known: true, direct: false, muted: false }])),
  }
}

export const policy = (did: string, threshold = 20) => `version: 1
account: ${did}
providers:
  activity:
    type: fixture
    did: did:plc:activity
    measurements:
      posts_per_day: posts per day
  trusted:
    type: fixture
    did: did:plc:trusted
sources:
  - type: explicit_dids
    dids: [did:plc:alice, did:plc:bob, did:plc:carol]
rules:
  - name: friends-can-poast
    disposition: allow
    when:
      source: trusted
      label: member
  - name: heavy-posting
    disposition: quarantine
    when:
      source: activity
      property: posts_per_day
      op: gt
      value: ${threshold}
exempt: []
allow: []
keep_muted: []
`

export const observations = [
  ...['did:plc:alice', 'did:plc:bob', 'did:plc:carol'].map(subject => ({
    provider: 'did:plc:activity', subject, property: 'posts_per_day', value: 24,
    observed_at: '2026-09-08T12:00:00Z', expires_at: '2026-09-20T12:00:00Z',
  })),
  {
    provider: 'did:plc:trusted', subject: 'did:plc:bob', property: 'member', value: true,
    observed_at: '2026-09-08T12:00:00Z', expires_at: '2026-09-20T12:00:00Z',
  },
]
