import { id, sha, AppDb, asJson } from './db.js'
import { Engine, stableHash } from './engine.js'
import type { AccountProvider, Acquisition, FeedExposure, Receipt, ReceiptRow } from './types.js'
import { BSKY38_URL, fetchBsky38, type Bsky38Member } from './bsky38.js'
import { ServiceControls } from './controls.js'

const now = () => new Date().toISOString()

export function feedAcquisitionFailureReason(error: unknown) {
  const status = Number((error as any)?.status ?? (error as any)?.response?.status)
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (status === 401 || status === 403 || message.includes('did not grant') || message.includes('reconnect')) {
    return 'Reconnect your account to grant access to this feed.'
  }
  if (status === 429 || message.includes('rate limit')) {
    return 'The feed request was rate limited. Try again later.'
  }
  if (message.includes('request budget')) return 'Feed acquisition reached its request limit.'
  if (message.includes('time limit') || message.includes('timed out') || message.includes('timeout')) {
    return 'Feed acquisition reached its time limit.'
  }
  return 'The feed source is temporarily unavailable.'
}

export class AclService {
  constructor(
    readonly db: AppDb,
    readonly engine: Engine,
    readonly accounts: AccountProvider,
    readonly fixtureAcquisition?: (did: string, policyBody: string) => Partial<Acquisition>,
    readonly bsky38: () => Promise<Bsky38Member[]> = fetchBsky38,
    readonly controls?: ServiceControls,
  ) {}

  async acquire(
    did: string,
    policyBody: string,
    fixture?: Partial<Acquisition>,
    validatedConfig?: Record<string, any>,
    feedSnapshot?: Acquisition,
    onProgress?: (progress: Record<string, unknown>) => void | Promise<void>,
  ): Promise<Acquisition> {
    fixture ??= this.fixtureAcquisition?.(did, policyBody)
    if (fixture) {
      const data = {
        subjects: fixture.subjects ?? [],
        identities: fixture.identities ?? {},
        observations: fixture.observations ?? [],
        coverage: fixture.coverage ?? [],
        discovery: fixture.discovery ?? [],
        remote: fixture.remote ?? {},
      }
      return { ...data, acquisition_hash: stableHash(data) }
    }
    const config = validatedConfig ?? (await this.engine.validate(policyBody)).config
    const client = await this.accounts.restore(did)
    // The declared acquisition maxima require up to 10 feed pages, 34
    // relationship batches, 40 profile batches, and 50 mute-list pages. Keep
    // a fixed ceiling with enough room for that worst-case shape.
    client.resetRequestCount(160)
    const profile = await client.profile()
    if (profile.did !== did) throw new Error('active OAuth account changed')
    const actorNames = new Set<string>([config.account])
    for (const layer of ['exempt', 'allow', 'keep_muted']) {
      for (const actor of config[layer] ?? []) actorNames.add(actor)
    }
    for (const source of config.sources) {
      if (source.type === 'follows' && source.actor) actorNames.add(source.actor)
    }
    const identities = await client.resolve([...actorNames])
    identities[profile.handle] = did
    identities[config.account] ??= did
    const subjects = new Set<string>()
    const nonExposureSubjects = new Set<string>()
    const exposureSubjects = new Set<string>()
    const discovery: any[] = []
    const observations: any[] = []
    const coverage: any[] = []
    let suppliedEvidence = false
    let exposureCount = 0
    const startedAt = Date.now()
    const checkElapsed = () => {
      if (Date.now() - startedAt > 120_000) throw new Error('preview acquisition exceeded its 120 second limit')
    }
    const snapshotSources = (feedSnapshot?.discovery ?? []).filter((item: any) => item?.source === 'feed_exposure') as any[]
    let snapshotIndex = 0
    for (const source of config.sources) {
      checkElapsed()
      if (source.type === 'explicit_dids') {
        for (const subject of source.dids) { subjects.add(subject); nonExposureSubjects.add(subject) }
        discovery.push({ subjects: source.dids, complete: true, source: 'explicit_dids' })
      } else if (source.type === 'follows') {
        const actor = source.actor ? identities[source.actor] : did
        if (actor !== did) throw new Error('hosted follows source currently requires the active account')
        const found = await client.follows(Math.min(Number(source.limit ?? 500), 5000))
        found.dids.forEach(subject => { subjects.add(subject); nonExposureSubjects.add(subject) })
        discovery.push({ subjects: found.dids, complete: found.complete, source: 'follows', reason: found.reason ?? '' })
      } else if (source.type === 'timeline') {
        const found = await client.timeline(Math.min(Number(source.limit ?? 500), 1000))
        found.dids.forEach(subject => { subjects.add(subject); nonExposureSubjects.add(subject) })
        discovery.push({ subjects: found.dids, complete: found.complete, source: 'timeline', reason: found.reason ?? '' })
      } else if (source.type === 'feed_exposure') {
        const surface = source.surface === 'generator' ? 'generator' : 'timeline'
        const requestedLimit = Math.min(Number(source.limit ?? 500), 500)
        const feedSource = surface === 'generator'
          ? { type: 'feed' as const, uri: String(source.feed_uri) }
          : { type: 'timeline' as const }
        let found: any
        if (feedSnapshot) {
          const saved = snapshotSources[snapshotIndex++]
          if (!saved || saved.surface !== surface || (surface === 'generator' && saved.feed_uri !== source.feed_uri)) {
            throw new Error('approved feed sample does not match the current policy source')
          }
          found = saved
        } else {
          try {
            await onProgress?.({ surface, phase: 'feed', completed: 0, total: requestedLimit })
            found = await client.feed(feedSource, requestedLimit, progress => onProgress?.({ surface, ...progress }))
          } catch (error) {
            const failed = { source: 'feed_exposure', surface, feed_uri: source.feed_uri,
              subjects: [], exposures: [], items: [], complete: false, exposure_complete: false,
              retrieved_at: now(), reason: feedAcquisitionFailureReason(error) }
            discovery.push(failed)
            await onProgress?.({ surface, phase: 'feed', completed: 0, total: requestedLimit,
              complete: false, reason: failed.reason, distinct_authors: 0 })
            continue
          }
        }
        const retained: FeedExposure[] = []
        let bounded = false
        for (const occurrence of (found.exposures ?? []) as FeedExposure[]) {
          if (exposureCount >= 5000) { bounded = true; break }
          if (!exposureSubjects.has(occurrence.subject_did) && exposureSubjects.size >= 1000) {
            bounded = true
            continue
          }
          exposureCount += 1
          exposureSubjects.add(occurrence.subject_did)
          subjects.add(occurrence.subject_did)
          if (occurrence.subject_handle) identities[occurrence.subject_handle] = occurrence.subject_did
          retained.push(occurrence)
        }
        const sourceSubjects = [...new Set(retained.map(item => item.subject_did))]
        const itemsSampled = Number(found.items_sampled ?? (found.items ?? []).length)
        const sampleBoundReached = !found.complete && itemsSampled >= requestedLimit
        const sourceReason = String(found.reason ?? '').split('; ')
          .filter((reason: string) => reason !== 'configured feed item limit reached').join('; ')
        const item = {
          source: 'feed_exposure', surface, feed_uri: source.feed_uri,
          subjects: sourceSubjects, exposures: retained, items: found.items ?? [],
          items_sampled: itemsSampled,
          requested_items: requestedLimit,
          source_exhausted: Boolean(found.complete),
          sample_bound_reached: sampleBoundReached,
          complete: Boolean(found.complete || sampleBoundReached) && Boolean(found.exposure_complete) && !bounded,
          exposure_complete: Boolean(found.exposure_complete) && !bounded,
          retrieved_at: retained[0]?.acquired_at ?? now(),
          reason: bounded ? 'preview acquisition bound reached' : sourceReason,
        }
        discovery.push(item)
        await onProgress?.({ surface, phase: 'feed', completed: itemsSampled, total: requestedLimit,
          complete: item.complete, reason: item.reason, distinct_authors: sourceSubjects.length,
          author_occurrences: retained.length })
      } else if (source.type === 'external_snapshot' && source.url === BSKY38_URL &&
          config.providers[source.provider]?.did === 'did:web:bsky38.com') {
        suppliedEvidence = true
        const retrievedAt = new Date()
        try {
          const members = (await this.bsky38()).slice(0, Math.min(Number(source.limit ?? 38), 38))
          const expiresAt = new Date(retrievedAt.getTime() + 60 * 60 * 1000).toISOString()
          for (const member of members) {
            subjects.add(member.did)
            nonExposureSubjects.add(member.did)
            identities[member.handle] = member.did
            observations.push({
              provider: config.providers[source.provider].did, subject: member.did, property: 'member', value: true,
              observed_at: retrievedAt.toISOString(), expires_at: expiresAt, provider_id: `rank:${member.rank}`,
              evidence_id: stableHash({ provider: config.providers[source.provider].did, subject: member.did, property: 'member', value: true }),
              raw_json: JSON.stringify(member), retrieved_at: retrievedAt.toISOString(), provenance: BSKY38_URL,
            })
            coverage.push({ provider: config.providers[source.provider].did, subject: member.did, complete: true,
              checked_at: retrievedAt.toISOString(), reason: '' })
          }
          discovery.push({ subjects: members.map(item => item.did), complete: members.length === 38,
            source: 'external_snapshot', source_url: BSKY38_URL, retrieved_at: retrievedAt.toISOString(), members,
            reason: members.length === 38 ? '' : 'leaderboard snapshot did not contain 38 accounts' })
        } catch {
          discovery.push({ subjects: [], complete: false, source: 'external_snapshot', source_url: BSKY38_URL,
            retrieved_at: retrievedAt.toISOString(), reason: 'Bsky38 leaderboard unavailable or changed structure' })
        }
      }
    }
    const retainedBytes = () => Buffer.byteLength(JSON.stringify({ subjects: [...subjects], discovery }))
    if (retainedBytes() > 4 * 1024 * 1024) {
      const feedRows = discovery.filter(item => item.source === 'feed_exposure')
      while (retainedBytes() > 4 * 1024 * 1024 && feedRows.some(item => item.exposures.length || item.items.length)) {
        for (const item of feedRows) {
          item.exposures = item.exposures.slice(0, Math.floor(item.exposures.length * 0.75))
          item.items = item.items.slice(0, Math.floor(item.items.length * 0.75))
          item.items_sampled = item.items.length
          item.subjects = [...new Set(item.exposures.map((entry: FeedExposure) => entry.subject_did))]
          item.complete = false
          item.exposure_complete = false
          item.reason = [item.reason, '4 MiB acquisition retention bound reached'].filter(Boolean).join('; ')
        }
        exposureSubjects.clear()
        for (const item of feedRows) for (const subject of item.subjects) exposureSubjects.add(subject)
        subjects.clear()
        for (const subject of nonExposureSubjects) subjects.add(subject)
        for (const subject of exposureSubjects) subjects.add(subject)
      }
    }
    checkElapsed()
    const orderedSubjects = [...subjects].sort()
    let relationships: Awaited<ReturnType<typeof client.relationships>> = {}
    try {
      relationships = exposureSubjects.size ? await client.relationships([...exposureSubjects].sort(), progress =>
        onProgress?.({ ...progress, surface: 'all' })) : {}
    } catch {
      relationships = Object.fromEntries([...exposureSubjects].map(subject => [subject, {
        state: 'unknown' as const, reason: 'relationship lookup unavailable or request budget exhausted',
      }]))
      for (const item of discovery.filter(item => item.source === 'feed_exposure')) {
        item.complete = false
        item.reason = [item.reason, 'relationship lookup incomplete'].filter(Boolean).join('; ')
      }
    }
    checkElapsed()
    let remote: Awaited<ReturnType<typeof client.observe>>
    try {
      remote = await client.observe(orderedSubjects, progress => onProgress?.({ ...progress, surface: 'all' }))
    } catch (error) {
      if (feedSnapshot) throw error
      remote = Object.fromEntries(orderedSubjects.map(subject => [subject, { known: false }]))
      for (const item of discovery.filter(item => item.source === 'feed_exposure')) {
        item.complete = false
        item.reason = [item.reason, 'moderation-state lookup incomplete'].filter(Boolean).join('; ')
      }
    }
    for (const subject of exposureSubjects) {
      remote[subject] ??= { known: false }
      ;(remote[subject] as any).relationship = relationships[subject]?.state ?? 'unknown'
      if (relationships[subject]?.reason) (remote[subject] as any).relationship_reason = relationships[subject]!.reason
    }
    const data = { subjects: [...subjects].sort(), identities, discovery, remote,
      ...(suppliedEvidence ? { observations, coverage } : {}) }
    if (Buffer.byteLength(JSON.stringify({ subjects: data.subjects, discovery: data.discovery })) > 4 * 1024 * 1024) {
      throw new Error('acquisition metadata exceeded its fixed retention limit')
    }
    if (client.requestCount() > 160) throw new Error('internal request accounting exceeded its fixed bound')
    return { ...data, acquisition_hash: stableHash(data) }
  }

  savePolicy(did: string, name: string, body: string, existing?: string) {
    const at = now()
    const sourceHash = sha(body)
    if (existing) {
      const current = this.db.sql.prepare('SELECT * FROM policies WHERE id=? AND did=?')
        .get(existing, did) as Record<string, unknown> | undefined
      if (!current) throw new Error('policy not found')
      const revision = Number(current.revision) + 1
      this.db.sql.prepare('UPDATE policies SET name=?,body=?,revision=?,source_hash=?,updated_at=? WHERE id=? AND did=?')
        .run(name, body, revision, sourceHash, at, existing, did)
      this.db.audit(did, 'policy_updated', { policy: existing, revision })
      return existing
    }
    const policyId = id('pol')
    this.db.sql.prepare('INSERT INTO policies VALUES(?,?,?,?,?,?,0,?,?)')
      .run(policyId, did, name, body, 1, sourceHash, at, at)
    this.db.audit(did, 'policy_created', { policy: policyId, revision: 1 })
    return policyId
  }

  async preview(did: string, policyId: string, fixture?: Partial<Acquisition>, evaluationTime?: string) {
    const lease = await this.controls?.beginAcquisition(did)
    try {
    const deadline = Date.now() + 120_000
    const policy = this.db.sql.prepare('SELECT * FROM policies WHERE id=? AND did=?')
      .get(policyId, did) as Record<string, unknown> | undefined
    if (!policy) throw new Error('policy not found')
    const body = String(policy.body)
    const validated = await this.engine.validate(body)
    const acquisition = await this.acquire(did, body, fixture, validated.config)
    let receipt = await this.engine.preview(String(policy.body), did, acquisition, evaluationTime, deadline - Date.now())
    if (!fixture && !this.fixtureAcquisition) {
      const missing = receipt.rows.map(row => row.subject).filter(subject => !(subject in acquisition.remote))
      if (missing.length) {
        const client = await this.accounts.restore(did)
        Object.assign(acquisition.remote, await client.observe(missing))
        acquisition.subjects = [...new Set([...acquisition.subjects, ...missing])].sort()
        acquisition.acquisition_hash = stableHash({
          subjects: acquisition.subjects, identities: acquisition.identities,
          discovery: acquisition.discovery, remote: acquisition.remote,
        })
        receipt = await this.engine.preview(String(policy.body), did, acquisition, evaluationTime, deadline - Date.now())
      }
    }
    const previewId = id('prev')
    const effectiveHash = stableHash({
      did, policy: receipt.policy_hash, revision: policy.revision,
      overrides: receipt.override_hash, acquisition: acquisition.acquisition_hash,
    })
    receipt.effective_config_hash = effectiveHash
    this.db.sql.prepare('INSERT INTO previews VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      previewId, did, policyId, Number(policy.revision), effectiveHash,
      JSON.stringify(receipt), JSON.stringify(acquisition), receipt.complete ? 1 : 0,
      now(), new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    )
    this.db.audit(did, 'preview_created', { preview: previewId, policy: policyId, complete: receipt.complete })
    return { id: previewId, receipt }
    } finally {
      if (lease) this.controls?.finishAcquisition(lease)
    }
  }

  async startFeedYield(did: string, policyBody: string) {
    const validated = await this.engine.validate(policyBody)
    const lease = await this.controls?.beginAcquisition(did)
    const reportId = id('yield')
    const startedAt = now()
    const running: any = {
      schema: 2, status: 'running', complete: false, account: { did },
      policy_hash: validated.policy_hash, acquisition_hash: '', started_at: startedAt,
      updated_at: startedAt, sources: [], affected: [], unresolved: [],
    }
    this.db.sql.prepare(`INSERT INTO yield_reports
      (id,did,policy_hash,acquisition_hash,report,created_at) VALUES(?,?,?,?,?,?)`).run(
      reportId, did, validated.policy_hash, '', JSON.stringify(running), startedAt,
    )
    this.db.audit(did, 'feed_yield_started', { report: reportId })
    const progress = async (step: Record<string, unknown>) => {
      const surface = String(step.surface ?? 'all')
      if (surface === 'timeline' || surface === 'generator') {
        const existing = running.sources.find((item: any) => item.surface === surface)
        if (existing) Object.assign(existing, step)
        else running.sources.push({ ...step, surface })
      } else {
        running.progress = step
      }
      running.updated_at = now()
      this.db.sql.prepare('UPDATE yield_reports SET report=? WHERE id=? AND did=?')
        .run(JSON.stringify(running), reportId, did)
    }
    const completion = this.finishFeedYield(reportId, did, policyBody, validated, startedAt, progress)
      .catch(error => {
        running.status = 'failed'
        running.complete = false
        running.updated_at = now()
        const feedsComplete = running.sources.length > 0 && running.sources.every((source: any) => source.complete)
        running.interruption_reason = feedsComplete
          ? 'The feed samples completed, but later account or evidence checks did not finish. No result was inferred and no moderation action was created.'
          : 'The measurement stopped before it could produce a complete report. No result was inferred and no moderation action was created.'
        this.db.sql.prepare('UPDATE yield_reports SET report=? WHERE id=? AND did=?')
          .run(JSON.stringify(running), reportId, did)
        this.db.audit(did, 'feed_yield_failed', { report: reportId })
        throw error
      }).finally(() => { if (lease) this.controls?.finishAcquisition(lease) })
    return { id: reportId, completion }
  }

  async measureFeedYield(did: string, policyBody: string) {
    const started = await this.startFeedYield(did, policyBody)
    return started.completion
  }

  private async finishFeedYield(
    reportId: string,
    did: string,
    policyBody: string,
    validated: { policy_hash: string; source_hash: string; config: Record<string, any> },
    startedAt: string,
    progress: (step: Record<string, unknown>) => Promise<void>,
  ) {
    const deadline = Date.now() + 120_000
    const acquisition = await this.acquire(did, policyBody, undefined, validated.config, undefined, progress)
    const receipt = await this.engine.preview(policyBody, did, acquisition, undefined, deadline - Date.now())
    const client = await this.accounts.restore(did)
    const profile = await client.profile()
    const rows = new Map(receipt.rows.map(row => [row.subject, row]))
    const evidenceSubjects = new Set(receipt.evidence.map(item => String(item.subject ?? '')).filter(Boolean))
    const covered = new Set((receipt.coverage ?? []).filter(item => item.complete).map(item => item.subject))
    const cumulativeAuthors = new Set<string>()
    const cumulativeMatches = new Set<string>()
    const allExposures = acquisition.discovery.flatMap((item: any) => (item?.exposures ?? []) as FeedExposure[])
    const sources = acquisition.discovery.filter((item: any) => item?.source === 'feed_exposure').map((item: any) => {
      const exposures = (item.exposures ?? []) as FeedExposure[]
      const atPrefix = (ceiling: number) => {
        const prefix = exposures.filter(exposure => exposure.position < ceiling)
        const found = new Set(prefix.map(exposure => exposure.subject_did))
        const foundRows = [...found].map(subject => rows.get(subject)).filter(Boolean) as ReceiptRow[]
        return {
          ceiling,
          items: Math.min(Number(item.items_sampled ?? item.items?.length ?? 0), ceiling),
          distinct_authors: found.size,
          publisher_checks: [...found].filter(subject => covered.has(subject)).length,
          positive_labels: [...found].filter(subject => evidenceSubjects.has(subject)).length,
          matching_accounts: foundRows.filter(row => row.evaluation.matches.length > 0).length,
          actionable_mutes: foundRows.filter(row => row.action === 'mute').length,
          followed_review: foundRows.filter(row => row.action === 'follow_review_candidate').length,
          unresolved: foundRows.filter(row => row.desired === 'indeterminate' || (row.observed as any).relationship === 'unknown').length,
        }
      }
      const prefixes = [100, 250, 500].map(atPrefix)
      const withMarginal = prefixes.map((entry, index) => ({
        ...entry,
        added_distinct_authors: entry.distinct_authors - (prefixes[index - 1]?.distinct_authors ?? 0),
        added_matching_accounts: entry.matching_accounts - (prefixes[index - 1]?.matching_accounts ?? 0),
      }))
      const subjectSet = new Set<string>([
        ...(item.subjects ?? []).map(String),
        ...exposures.map(exposure => exposure.subject_did),
      ])
      const sourceMatches = new Set([...subjectSet].filter(subject => (rows.get(subject)?.evaluation.matches.length ?? 0) > 0))
      const addedDistinctAuthors = [...subjectSet].filter(subject => !cumulativeAuthors.has(subject)).length
      const addedMatchingAccounts = [...sourceMatches].filter(subject => !cumulativeMatches.has(subject)).length
      subjectSet.forEach(subject => cumulativeAuthors.add(subject))
      sourceMatches.forEach(subject => cumulativeMatches.add(subject))
      const relationships = { followed: 0, not_followed: 0, unknown: 0 }
      for (const subject of subjectSet) {
        const relation = (acquisition.remote[subject] as any)?.relationship
        if (relation === 'following') relationships.followed += 1
        else if (relation === 'not_following') relationships.not_followed += 1
        else relationships.unknown += 1
      }
      return {
        surface: item.surface,
        feed_uri: item.feed_uri,
        complete: Boolean(item.complete && item.exposure_complete),
        reason: item.reason ?? '',
        items_fetched: Number(item.items_sampled ?? item.items?.length ?? 0),
        unique_posts: new Set(exposures.map(exposure => `${exposure.post_uri}\u0000${exposure.post_cid}`)).size,
        author_occurrences: exposures.length,
        distinct_authors: subjectSet.size,
        added_distinct_authors: addedDistinctAuthors,
        matching_accounts: sourceMatches.size,
        added_matching_accounts: addedMatchingAccounts,
        mechanisms: {
          top_level: exposures.filter(exposure => exposure.mechanism === 'top_level').length,
          repost: exposures.filter(exposure => exposure.mechanism === 'repost').length,
          quote: exposures.filter(exposure => exposure.mechanism === 'quote').length,
        },
        relationships,
        prefixes: withMarginal,
      }
    })
    const affected = receipt.rows.filter(row => row.subject !== receipt.account && row.evaluation.matches.length > 0).map(row => ({
      subject: row.subject,
      handle: row.observed.handle,
      display_name: row.observed.display_name,
      action: row.action,
      current_state: row.observed.muted ? 'muted' : 'not_muted',
      reason: row.reason,
      matches: row.evaluation.matches,
      avatar: row.observed.avatar,
      exposures: allExposures.filter(item => item.subject_did === row.subject).slice(0, 20),
      evidence: receipt.evidence.filter(item => item.subject === row.subject).map(item => ({
        property: item.property,
        observed_at: item.observed_at,
        expires_at: item.expires_at,
      })),
    }))
    const unresolved = receipt.rows.filter(row => row.desired === 'indeterminate' || (row.observed as any).relationship === 'unknown').map(row => ({
      subject: row.subject, handle: row.observed.handle, reason: row.reason,
      unresolved: row.evaluation.unresolved,
      relationship: (row.observed as any).relationship ?? 'not_applicable',
    }))
    const actionable = affected.filter(row => row.action === 'mute').length
    const followedReview = affected.filter(row => row.action === 'follow_review_candidate').length
    const retainedContextMatches = affected.filter(row => !cumulativeAuthors.has(row.subject)).length
    const report = {
      schema: 2,
      status: 'completed',
      started_at: startedAt,
      updated_at: now(),
      account: { did: profile.did, handle: profile.handle, pds: profile.pds },
      policy_hash: receipt.policy_hash,
      policy: validated.config,
      acquisition_hash: acquisition.acquisition_hash,
      evaluated_at: receipt.evaluated_at,
      complete: Boolean(receipt.complete && sources.every(source => source.complete)),
      feed_acquisition_complete: sources.every(source => source.complete),
      policy_evaluation_complete: receipt.complete,
      overall: {
        items_fetched: sources.reduce((sum, source) => sum + source.items_fetched, 0),
        distinct_authors: cumulativeAuthors.size,
        matching_accounts: affected.length,
        feed_matching_accounts: cumulativeMatches.size,
        retained_context_matches: retainedContextMatches,
        actionable_mutes: actionable,
        followed_review: followedReview,
      },
      sources,
      affected,
      unresolved,
    }
    this.db.sql.prepare(`UPDATE yield_reports SET policy_hash=?,acquisition_hash=?,report=?
      WHERE id=? AND did=?`).run(
      receipt.policy_hash, acquisition.acquisition_hash, JSON.stringify(report), reportId, did,
    )
    this.db.audit(did, 'feed_yield_measured', { report: reportId, complete: report.complete,
      affected: affected.length, unresolved: unresolved.length })
    return { id: reportId, report }
  }

  approve(did: string, previewId: string, kind: 'apply' | 'apply_followed' | 'release', subjects: string[]) {
    return this.db.transaction(() => {
      const preview = this.db.sql.prepare('SELECT * FROM previews WHERE id=? AND did=? AND expires_at>?')
        .get(previewId, did, now()) as Record<string, unknown> | undefined
      if (!preview) throw new Error('preview is missing, expired, or belongs to another account')
      const policy = this.db.sql.prepare('SELECT revision FROM policies WHERE id=? AND did=?')
        .get(String(preview.policy_id), did) as { revision: number } | undefined
      if (!policy || policy.revision !== Number(preview.policy_revision)) throw new Error('policy changed; create a new preview')
      const receipt = asJson<Receipt>(preview, 'receipt')
      const wanted = new Set(subjects)
      if (wanted.size === 0 || wanted.size !== subjects.length) throw new Error('select a nonempty unique action batch')
      this.controls?.requireApprovalCapacity(did, wanted.size)
      if (!this.controls && wanted.size > 100) throw new Error('an action batch may contain at most 100 accounts')
      const expectedAction = kind === 'apply' ? 'mute' : kind === 'apply_followed' ? 'follow_review_candidate' : 'release_candidate'
      const rows = receipt.rows.filter(row => wanted.has(row.subject))
      if (rows.length !== wanted.size || rows.some(row => row.action !== expectedAction)) {
        throw new Error('approval includes an unavailable action')
      }
      const actions = rows.map(row => ({
        subject: row.subject,
        action: kind === 'release' ? 'unmute' : 'mute',
        fingerprint: row.fingerprint,
        handle: row.observed.handle ?? null,
        display_name: row.observed.display_name ?? null,
        avatar: row.observed.avatar ?? null,
      })).sort((a, b) => a.subject.localeCompare(b.subject))
      const batchHash = stableHash({
        did, preview: previewId, policy: preview.policy_id, revision: preview.policy_revision,
        effective: preview.effective_hash, kind, actions,
      })
      const approvalId = id('approval')
      const jobId = id('job')
      const old = this.db.sql.prepare('SELECT id FROM approvals WHERE did=? AND preview_id=? AND kind=? AND batch_hash=?')
        .get(did, previewId, kind, batchHash) as { id: string } | undefined
      if (old) {
        const oldJob = this.db.sql.prepare('SELECT id FROM jobs WHERE approval_id=?').get(old.id) as { id: string }
        return oldJob.id
      }
      this.db.sql.prepare(`INSERT INTO approvals
        (id,did,preview_id,policy_id,policy_revision,effective_hash,kind,batch_hash,actions,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        approvalId, did, previewId, String(preview.policy_id), Number(preview.policy_revision),
        String(preview.effective_hash), kind, batchHash, JSON.stringify(actions), 'approved', now(),
      )
      this.db.sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)')
        .run(jobId, did, approvalId, 'queued', 0, now(), null, now(), now())
      const insert = this.db.sql.prepare('INSERT INTO job_items VALUES(?,?,?,?,?,?,?,?,?)')
      for (const action of actions) {
        insert.run(id('item'), jobId, action.subject, action.action, action.fingerprint, 'pending', null, null, now())
      }
      this.db.audit(did, 'batch_approved', { approval: approvalId, job: jobId, batch: batchHash, count: actions.length })
      return jobId
    })
  }

  owned<T extends Record<string, unknown>>(table: 'policies' | 'previews' | 'jobs' | 'yield_reports', idValue: string, did: string): T {
    const row = this.db.sql.prepare(`SELECT * FROM ${table} WHERE id=? AND did=?`).get(idValue, did) as T | undefined
    if (!row) throw new Error('resource not found')
    return row
  }

  listPolicies(did: string) {
    return this.db.sql.prepare(`
      SELECT p.id,p.name,p.body,p.revision,p.enabled,p.updated_at,
        (SELECT pr.id FROM previews pr WHERE pr.policy_id=p.id AND pr.did=p.did ORDER BY pr.created_at DESC LIMIT 1) AS latest_preview_id,
        (SELECT pr.receipt FROM previews pr WHERE pr.policy_id=p.id AND pr.did=p.did ORDER BY pr.created_at DESC LIMIT 1) AS latest_receipt
      FROM policies p WHERE p.did=? ORDER BY p.updated_at DESC`)
      .all(did) as Record<string, unknown>[]
  }

  listJobs(did: string) {
    return this.db.sql.prepare(`
      SELECT j.id,j.status,j.error_code,j.created_at,j.updated_at,p.name AS policy_name,a.kind,
        COUNT(i.id) AS total,
        SUM(CASE WHEN i.status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN i.status='uncertain' OR i.status LIKE 'failed%' THEN 1 ELSE 0 END) AS needs_review,
        SUM(CASE WHEN i.status='pending' OR i.status='attempting' THEN 1 ELSE 0 END) AS pending
      FROM jobs j JOIN approvals a ON a.id=j.approval_id AND a.did=j.did
      JOIN policies p ON p.id=a.policy_id AND p.did=a.did
      LEFT JOIN job_items i ON i.job_id=j.id
      WHERE j.did=? GROUP BY j.id ORDER BY j.created_at DESC LIMIT 50`).all(did) as Record<string, unknown>[]
  }

  async recheckUncertain(did: string, jobId: string, subject: string) {
    this.owned('jobs', jobId, did)
    const item = this.db.sql.prepare(`SELECT i.id,i.action FROM job_items i
      JOIN jobs j ON j.id=i.job_id WHERE i.job_id=? AND j.did=? AND i.subject=? AND i.status='uncertain'`)
      .get(jobId, did, subject) as { id: string; action: string } | undefined
    if (!item) throw new Error('unconfirmed account result not found')
    const client = await this.accounts.restore(did)
    client.resetRequestCount(5)
    const observed = (await client.observe([subject]))[subject]
    const currentlyApplied = item.action === 'mute'
      ? Boolean(observed?.known && observed.direct)
      : Boolean(observed?.known && !observed.direct)
    const code = observed?.known
      ? currentlyApplied ? 'current_state_matches_ownership_uncertain' : 'current_state_does_not_match'
      : 'current_state_unavailable'
    this.db.sql.prepare('UPDATE job_items SET error_code=?,updated_at=? WHERE id=? AND status=?')
      .run(code, now(), item.id, 'uncertain')
    this.db.audit(did, 'uncertain_state_rechecked', { job: jobId, subject, current_state: code })
    return code
  }

  jobDetails(did: string, jobId: string) {
    const job = this.owned<Record<string, unknown>>('jobs', jobId, did)
    const context = this.db.sql.prepare(`
      SELECT p.receipt,p.acquisition,p.id AS preview_id,a.kind AS approval_kind,
        a.actions AS approval_actions,a.created_at AS approved_at,pol.name AS policy_name
      FROM jobs j
      JOIN approvals a ON a.id=j.approval_id AND a.did=j.did
      JOIN previews p ON p.id=a.preview_id AND p.did=a.did
      JOIN policies pol ON pol.id=a.policy_id AND pol.did=a.did
      WHERE j.id=? AND j.did=?`).get(jobId, did) as Record<string, unknown> | undefined
    const receipt = context ? JSON.parse(String(context.receipt)) as Receipt : undefined
    const acquisition = context ? JSON.parse(String(context.acquisition)) as Acquisition : undefined
    const approvalActions = context
      ? new Map((JSON.parse(String(context.approval_actions)) as Array<Record<string, unknown>>)
        .map(action => [String(action.subject), action]))
      : new Map<string, Record<string, unknown>>()
    const receiptRows = new Map((receipt?.rows ?? []).map(row => [row.subject, row]))
    const acquiredHandles = new Map<string, string>()
    for (const [handle, subject] of Object.entries(acquisition?.identities ?? {})) {
      if (handle !== subject && typeof subject === 'string') acquiredHandles.set(subject, handle)
    }
    for (const source of acquisition?.discovery ?? []) {
      for (const exposure of ((source as any)?.exposures ?? []) as FeedExposure[]) {
        if (exposure.subject_handle) acquiredHandles.set(exposure.subject_did, exposure.subject_handle)
      }
    }
    const items = this.db.sql.prepare(`
      SELECT subject,action,status,error_code,updated_at FROM job_items
      WHERE job_id=? ORDER BY subject`).all(jobId) as Record<string, unknown>[]
    const presentedJob = context ? {
      ...job,
      policy_name: context.policy_name,
      approval_kind: context.approval_kind,
      approved_at: context.approved_at,
      preview_id: context.preview_id,
      preview_url: `/previews/${context.preview_id}`,
    } : job
    return { job: presentedJob, items: items.map(item => {
      const subjectDid = String(item.subject)
      const observed = receiptRows.get(subjectDid)?.observed
      const approved = approvalActions.get(subjectDid)
      const snapshotHasHandle = approved && Object.hasOwn(approved, 'handle')
      const snapshotHasDisplayName = approved && Object.hasOwn(approved, 'display_name')
      const handle = snapshotHasHandle
        ? (typeof approved.handle === 'string' ? approved.handle : undefined)
        : observed?.handle ?? acquiredHandles.get(subjectDid)
      const displayName = snapshotHasDisplayName
        ? (typeof approved.display_name === 'string' ? approved.display_name : undefined)
        : observed?.display_name
      const avatar = approved && typeof approved.avatar === 'string' ? approved.avatar : observed?.avatar
      const exposures = (acquisition?.discovery ?? []).flatMap(source => ((source as any)?.exposures ?? []) as FeedExposure[])
        .filter(exposure => exposure.subject_did === subjectDid)
      return {
        ...item,
        subject_did: subjectDid,
        handle,
        display_name: displayName,
        avatar,
        exposures,
        subject_label: displayName || (handle ? `@${handle}` : subjectDid),
        action_label: item.action === 'unmute' ? 'Unmute' : 'Mute',
      }
    }) }
  }

  listYieldReports(did: string) {
    return this.db.sql.prepare('SELECT id,report,created_at FROM yield_reports WHERE did=? ORDER BY created_at DESC LIMIT 10')
      .all(did) as Record<string, unknown>[]
  }
}
