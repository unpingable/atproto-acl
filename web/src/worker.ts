import { AppDb } from './db.js'
import { stableHash } from './engine.js'
import { AclService } from './service.js'
import type { Receipt } from './types.js'
import { CapacityError, ServiceControls } from './controls.js'

const now = () => new Date().toISOString()
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function codeFor(error: unknown) {
  const status = Number((error as any)?.status ?? (error as any)?.response?.status)
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'reconnect_required'
  return 'remote_write_uncertain'
}

export class Worker {
  private stopped = false
  constructor(
    private db: AppDb,
    private service: AclService,
    private pause: (ms: number) => Promise<unknown> = wait,
    private controls: ServiceControls,
  ) {}

  private async confirmEffect(client: any, subject: string, action: string) {
    for (const delay of [0, 1_000, 2_000]) {
      if (delay) await this.pause(delay)
      try {
        client.resetRequestCount(60)
        const after = await client.observe([subject])
        const state = after[subject]
        const confirmed = action === 'mute'
          ? Boolean(state?.known && state.direct)
          : Boolean(state?.known && !state.direct)
        if (confirmed) return true
      } catch {
        // A read failure says nothing about whether the already-completed RPC
        // took effect. Retry observation only; never replay the write.
      }
    }
    return false
  }

  recover() {
    this.db.transaction(() => {
      this.db.sql.prepare(`
        UPDATE job_items SET status='uncertain',error_code='worker_interrupted',updated_at=?
        WHERE status='attempting'`).run(now())
      this.db.sql.prepare(`
        UPDATE jobs SET status='queued',available_at=?,updated_at=?
        WHERE status='running' AND id NOT IN (
          SELECT job_id FROM job_items WHERE status='uncertain'
        )`).run(now(), now())
      this.db.sql.prepare(`
        UPDATE jobs SET status='needs_review',error_code='worker_interrupted',updated_at=?
        WHERE status='running'`).run(now())
      if (!Number(this.controls.state().writes_enabled)) {
        this.db.sql.prepare("UPDATE jobs SET status='paused_by_operator',error_code='writes_paused',updated_at=? WHERE status='queued'").run(now())
      }
    })
  }

  stop() { this.stopped = true }

  async loop(interval = 500) {
    this.recover()
    while (!this.stopped) {
      const worked = await this.runNext()
      if (!worked) await wait(interval)
    }
  }

  claim() {
    try { this.controls.requireWrite() } catch { return undefined }
    return this.db.transaction(() => {
      const row = this.db.sql.prepare(`
        SELECT id FROM jobs WHERE status='queued' AND available_at<=?
        ORDER BY created_at LIMIT 1`).get(now()) as { id: string } | undefined
      if (!row) return undefined
      const changed = this.db.sql.prepare(`
        UPDATE jobs SET status='running',updated_at=? WHERE id=? AND status='queued'`)
        .run(now(), row.id).changes
      return changed ? row.id : undefined
    })
  }

  async runNext() {
    const jobId = this.claim()
    if (!jobId) return false
    try {
      await this.run(jobId)
    } catch {
      this.finishJob(jobId, 'failed', 'worker_error')
    }
    return true
  }

  async run(jobId: string) {
    const job = this.db.sql.prepare(`
        SELECT j.*,a.preview_id,a.policy_id,a.policy_revision,a.effective_hash,a.kind,
        p.acquisition AS preview_acquisition,p.expires_at AS approval_expires_at
      FROM jobs j JOIN approvals a ON a.id=j.approval_id
      JOIN previews p ON p.id=a.preview_id AND p.did=a.did WHERE j.id=?`)
      .get(jobId) as Record<string, unknown> | undefined
    if (!job) return
    const did = String(job.did)
    const deleting = this.db.sql.prepare('SELECT 1 FROM account_deletions WHERE did=?').get(did)
    if (deleting) {
      this.skipPending(jobId, 'account_deletion')
      this.finishJob(jobId, 'cancelled', 'account_deletion')
      return
    }
    if (job.approval_expires_at && Date.parse(String(job.approval_expires_at)) <= Date.now()) {
      this.skipPending(jobId, 'approval_expired')
      this.finishJob(jobId, 'needs_review', 'approval_expired')
      return
    }
    const user = this.db.sql.prepare('SELECT connected FROM users WHERE did=?').get(did) as { connected: number } | undefined
    if (!user?.connected) {
      this.finishJob(jobId, 'disconnected', 'account_disconnected')
      return
    }
    const policy = this.db.sql.prepare('SELECT * FROM policies WHERE id=? AND did=?')
      .get(String(job.policy_id), did) as Record<string, unknown> | undefined
    if (!policy || Number(policy.revision) !== Number(job.policy_revision)) {
      this.skipPending(jobId, 'policy_changed')
      this.finishJob(jobId, 'completed_with_skips', 'policy_changed')
      return
    }
    let receipt: Receipt
    let client
    try {
      client = await this.service.accounts.restore(did)
      const approvedAcquisition = JSON.parse(String(job.preview_acquisition))
      const acquisition = await this.service.acquire(did, String(policy.body), undefined, undefined, approvedAcquisition)
      const validated = await this.service.engine.validate(String(policy.body), did)
      const portable = await this.service.portableContext(did, validated.config)
      receipt = await this.service.engine.preview(String(policy.body), did, acquisition, undefined, undefined, portable)
    } catch (error) {
      const code = codeFor(error)
      if (code === 'rate_limited') {
        this.db.sql.prepare(`
          UPDATE jobs SET status='queued',available_at=?,error_code=?,updated_at=? WHERE id=?`)
          .run(new Date(Date.now() + 30_000).toISOString(), code, now(), jobId)
      } else {
        this.finishJob(jobId, code === 'reconnect_required' ? 'awaiting_reconnect' : 'failed', code)
      }
      return
    }
    const current = new Map(receipt.rows.map(row => [row.subject, row]))
    const items = this.db.sql.prepare(`
      SELECT * FROM job_items WHERE job_id=? AND status='pending' ORDER BY subject`)
      .all(jobId) as Record<string, unknown>[]
    for (const item of items) {
      if (this.db.sql.prepare('SELECT 1 FROM account_deletions WHERE did=?').get(did)) {
        this.skipPending(jobId, 'account_deletion')
        break
      }
      const status = this.db.sql.prepare('SELECT cancel_requested FROM jobs WHERE id=?')
        .get(jobId) as { cancel_requested: number }
      if (status.cancel_requested) {
        this.skipPending(jobId, 'cancelled')
        break
      }
      const row = current.get(String(item.subject))
      const expected = item.action === 'unmute' ? 'release_candidate'
        : String(job.kind) === 'apply_followed' ? 'follow_review_candidate' : 'mute'
      if (!row || row.action !== expected || row.fingerprint !== item.fingerprint) {
        this.setItem(String(item.id), 'skipped_changed', null, 'applicability_changed')
        continue
      }
      const action = String(item.action)
      let before
      try {
        // Acquisition has its own fixed budget. Give each approved item a
        // fresh, bounded recheck budget so earlier reads cannot starve the
        // applicability check immediately before its effect.
        client.resetRequestCount(60)
        before = await client.observe([String(item.subject)])
        if ((row.observed as any).relationship) {
          const relationship = await client.relationships([String(item.subject)])
          ;(before[String(item.subject)] as any).relationship = relationship[String(item.subject)]?.state ?? 'unknown'
          if (relationship[String(item.subject)]?.reason) {
            ;(before[String(item.subject)] as any).relationship_reason = relationship[String(item.subject)]!.reason
          }
        }
      } catch (error) {
        const code = codeFor(error)
        if (code === 'rate_limited') {
          this.db.sql.prepare("UPDATE jobs SET status='queued',available_at=?,error_code=?,updated_at=? WHERE id=?")
            .run(new Date(Date.now() + 30_000).toISOString(), code, now(), jobId)
        } else {
          this.finishJob(jobId, code === 'reconnect_required' ? 'awaiting_reconnect' : 'failed', code)
        }
        return
      }
      if (stableHash(before[String(item.subject)]) !== stableHash(row.observed)) {
        this.setItem(String(item.id), 'skipped_changed', null, 'moderation_state_changed')
        continue
      }
      let effect: string | undefined
      try {
        effect = this.controls.reserveEffect(did)
      } catch (error) {
        if (error instanceof CapacityError) {
          this.finishJob(jobId, 'paused_by_operator', 'capacity_reached')
        } else {
          this.finishJob(jobId, 'paused_by_operator', 'writes_paused')
        }
        return
      }
      let begun
      try {
        begun = await this.service.engine.begin(did, String(item.subject), action, {
          job: jobId, approval: job.approval_id, preview: job.preview_id,
          fingerprint: item.fingerprint,
        })
      } catch {
        if (effect) this.controls.finishEffect(effect, 'refused')
        this.finishJob(jobId, 'failed', 'journal_unavailable')
        return
      }
      this.setItem(String(item.id), 'attempting', begun.attempt, null)
      try {
        // The durable shared and per-account gates are deliberately re-read at
        // the last possible point. Failure to read them is a refusal to mutate.
        this.controls.requireAccountWrite(did)
      } catch {
        await this.service.engine.finish(did, String(item.subject), action, begun.attempt, false)
        this.setItem(String(item.id), 'pending', begun.attempt, 'writes_paused')
        if (effect) this.controls.finishEffect(effect, 'refused')
        this.finishJob(jobId, 'paused_by_operator', 'writes_paused')
        return
      }
      try {
        if (action === 'mute') await client.mute(String(item.subject))
        else await client.unmute(String(item.subject))
        const confirmed = await this.confirmEffect(client, String(item.subject), action)
        await this.service.engine.finish(did, String(item.subject), action, begun.attempt, confirmed)
        this.setItem(String(item.id), confirmed ? 'confirmed' : 'uncertain', begun.attempt,
          confirmed ? null : 'readback_mismatch')
        if (effect) this.controls.finishEffect(effect, confirmed ? 'confirmed' : 'uncertain')
        // This item's effect is ambiguous and must never be replayed. Other
        // untouched items remain independently authorized and still receive
        // their own applicability check before execution.
        if (!confirmed) continue
      } catch (error) {
        await this.service.engine.finish(did, String(item.subject), action, begun.attempt, false)
        this.setItem(String(item.id), 'uncertain', begun.attempt, codeFor(error))
        if (effect) this.controls.finishEffect(effect, 'uncertain')
        continue
      }
    }
    const counts = this.db.sql.prepare(`
      SELECT status,count(*) count FROM job_items WHERE job_id=? GROUP BY status`)
      .all(jobId) as Array<{ status: string; count: number }>
    const statuses = new Set(counts.map(row => row.status))
    if (statuses.has('uncertain')) this.finishJob(jobId, 'needs_review', 'uncertain_write')
    else if (statuses.has('pending')) this.finishJob(jobId, 'cancelled', 'cancelled')
    else if ([...statuses].some(value => value.startsWith('skipped'))) this.finishJob(jobId, 'completed_with_skips', null)
    else this.finishJob(jobId, 'completed', null)
  }

  private setItem(id: string, status: string, attempt: number | null, error: string | null) {
    this.db.sql.prepare('UPDATE job_items SET status=?,attempt=?,error_code=?,updated_at=? WHERE id=?')
      .run(status, attempt, error, now(), id)
  }

  private skipPending(jobId: string, reason: string) {
    this.db.sql.prepare(`
      UPDATE job_items SET status='skipped_cancelled',error_code=?,updated_at=?
      WHERE job_id=? AND status='pending'`).run(reason, now(), jobId)
  }

  private finishJob(jobId: string, status: string, error: string | null) {
    this.db.sql.prepare('UPDATE jobs SET status=?,error_code=?,updated_at=? WHERE id=?')
      .run(status, error, now(), jobId)
  }
}
