import { AppDb, id } from './db.js'
import type { Config } from './config.js'

const now = () => new Date().toISOString()
const ago = (milliseconds: number) => new Date(Date.now() - milliseconds).toISOString()
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

export class CapacityError extends Error {
  constructor(readonly retryAfterSeconds = 60) {
    super('The beta is temporarily at capacity. Please try again later.')
  }
}

export class ServiceControls {
  constructor(private db: AppDb, private config: Config) {}

  state() {
    const row = this.db.sql.prepare('SELECT * FROM service_controls WHERE singleton=1').get() as Record<string, unknown> | undefined
    if (!row) throw new Error('shared service controls are unavailable')
    return row
  }

  requireAdmission() {
    if (!Number(this.state().admissions_enabled)) throw new CapacityError(300)
  }

  requireWrite() {
    if (!Number(this.state().writes_enabled)) throw new Error('moderation writes are paused by the operator')
  }

  requireAccountWrite(did: string) {
    this.requireWrite()
    const row = this.db.sql.prepare('SELECT writes_enabled FROM admissions WHERE did=?').get(did) as { writes_enabled: number } | undefined
    if (!row?.writes_enabled) throw new Error('Moderation changes are not enabled for this beta account.')
  }

  set(kind: 'writes' | 'admissions', enabled: boolean, operator: string, reason: string) {
    const column = kind === 'writes' ? 'writes_enabled' : 'admissions_enabled'
    this.db.transaction(() => {
      this.db.sql.prepare(`UPDATE service_controls SET ${column}=?,generation=generation+1,reason=?,updated_by=?,updated_at=? WHERE singleton=1`)
        .run(enabled ? 1 : 0, reason.slice(0, 240), operator.slice(0, 120), now())
      if (kind === 'writes' && !enabled) {
        this.db.sql.prepare("UPDATE jobs SET status='paused_by_operator',error_code='writes_paused',updated_at=? WHERE status='queued'").run(now())
      }
    })
  }

  async beginAcquisition(did: string) {
    this.requireAdmission()
    const lease = this.db.transaction(() => {
      this.db.sql.prepare("DELETE FROM capacity_events WHERE kind='acquisition' AND status='running' AND created_at<?")
        .run(ago(this.config.acquisitionMaxWaitSeconds * 1000 + 15 * 60 * 1000))
      const globalStarts = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='acquisition' AND created_at>=?")
        .get(ago(60 * 60 * 1000)) as { count: number }
      const didStarts = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='acquisition' AND did=? AND created_at>=?")
        .get(did, ago(60 * 60 * 1000)) as { count: number }
      const globalRunning = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='acquisition' AND status='running'").get() as { count: number }
      const didRunning = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='acquisition' AND status='running' AND did=?").get(did) as { count: number }
      if (globalStarts.count >= this.config.acquisitionStartsGlobalHour || didStarts.count >= this.config.acquisitionStartsPerDidHour) {
        throw new CapacityError(60)
      }
      const canRun = globalRunning.count < this.config.acquisitionConcurrencyGlobal && didRunning.count < this.config.acquisitionConcurrencyPerDid
      if (!canRun) {
        const waiting = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='acquisition' AND status='waiting'").get() as { count: number }
        if (waiting.count >= this.config.acquisitionQueueDepth) throw new CapacityError(60)
      }
      const token = id('acq')
      this.db.sql.prepare("INSERT INTO capacity_events(id,did,kind,status,created_at) VALUES(?,?,'acquisition',?,?)")
        .run(token, did, canRun ? 'running' : 'waiting', now())
      return { token, running: canRun }
    })
    if (lease.running) return lease.token
    const deadline = Date.now() + this.config.acquisitionMaxWaitSeconds * 1000
    while (Date.now() < deadline) {
      await pause(250)
      try { this.requireAdmission() } catch (error) {
        this.db.sql.prepare("UPDATE capacity_events SET status='capacity_expired',finished_at=? WHERE id=? AND status='waiting'").run(now(), lease.token)
        throw error
      }
      const claimed = this.db.transaction(() => {
        const global = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='acquisition' AND status='running'").get() as { count: number }
        const own = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='acquisition' AND status='running' AND did=?").get(did) as { count: number }
        if (global.count >= this.config.acquisitionConcurrencyGlobal || own.count >= this.config.acquisitionConcurrencyPerDid) return false
        return this.db.sql.prepare("UPDATE capacity_events SET status='running' WHERE id=? AND status='waiting'").run(lease.token).changes === 1
      })
      if (claimed) return lease.token
    }
    this.db.sql.prepare("UPDATE capacity_events SET status='capacity_expired',finished_at=? WHERE id=? AND status='waiting'").run(now(), lease.token)
    throw new CapacityError(60)
  }

  finishAcquisition(lease: string) {
    this.db.sql.prepare("UPDATE capacity_events SET status='completed',finished_at=? WHERE id=? AND kind='acquisition'").run(now(), lease)
  }

  requireApprovalCapacity(did: string, count: number) {
    this.requireAccountWrite(did)
    if (count > this.config.actionBatchMax) throw new Error(`an action batch may contain at most ${this.config.actionBatchMax} accounts`)
    const queued = this.db.sql.prepare("SELECT count(*) count FROM job_items WHERE status IN ('pending','attempting')").get() as { count: number }
    if (queued.count + count > this.config.queuedActionsGlobal) throw new CapacityError(300)
    const since = ago(24 * 60 * 60 * 1000)
    const global = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='effect' AND status!='refused' AND created_at>=?").get(since) as { count: number }
    const own = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='effect' AND status!='refused' AND did=? AND created_at>=?").get(did, since) as { count: number }
    if (global.count + count > this.config.effectsGlobalDay || own.count + count > this.config.effectsPerDidDay) throw new CapacityError(3600)
  }

  reserveEffect(did: string) {
    this.requireAccountWrite(did)
    return this.db.transaction(() => {
      this.requireAccountWrite(did)
      const since = ago(24 * 60 * 60 * 1000)
      const global = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='effect' AND status!='refused' AND created_at>=?").get(since) as { count: number }
      const own = this.db.sql.prepare("SELECT count(*) count FROM capacity_events WHERE kind='effect' AND status!='refused' AND did=? AND created_at>=?").get(did, since) as { count: number }
      if (global.count >= this.config.effectsGlobalDay || own.count >= this.config.effectsPerDidDay) throw new CapacityError(3600)
      const effect = id('effect')
      this.db.sql.prepare("INSERT INTO capacity_events(id,did,kind,status,created_at) VALUES(?,?,'effect','attempting',?)").run(effect, did, now())
      return effect
    })
  }

  finishEffect(effect: string, status: 'confirmed' | 'uncertain' | 'refused') {
    this.db.sql.prepare("UPDATE capacity_events SET status=?,finished_at=? WHERE id=? AND kind='effect'").run(status, now(), effect)
  }
}
