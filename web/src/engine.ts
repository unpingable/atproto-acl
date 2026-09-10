import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha } from './db.js'
import type { Acquisition, Receipt } from './types.js'
import type { Config } from './config.js'

type BridgeReply<T> = { ok: true; result: T } | { ok: false; error: string }
export type OverrideState = { exempt: string[]; allow: string[]; keep_muted: string[] }

export class PolicyServiceUnavailableError extends Error {
  constructor(readonly diagnosticId: string) {
    super(`The policy service is temporarily unavailable. Diagnostic ID: ${diagnosticId}.`)
    this.name = 'PolicyServiceUnavailableError'
  }
}

export class BridgeCapacityError extends Error {
  readonly retryAfterSeconds = 30
  constructor() {
    super('The policy service is busy. Try again shortly.')
    this.name = 'BridgeCapacityError'
  }
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyValidationError'
  }
}

type QueuedCall<T> = {
  key: string
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

type BridgeLease = {
  begin(did: string): string
  finish(token: string): void
}

export class Engine {
  private active = 0
  private activeByKey = new Map<string, number>()
  private queue: QueuedCall<unknown>[] = []
  private healthResult?: { value: BridgeHealth; expires: number }

  constructor(
    private config: Config,
    private lease?: BridgeLease,
    private log: (message: string, detail: unknown) => void = (message, detail) => console.error(message, detail),
  ) {}

  private unavailable(reason: string, detail: unknown) {
    const diagnosticId = randomUUID()
    this.log(`[policy-service:${diagnosticId}] ${reason}`, detail)
    return new PolicyServiceUnavailableError(diagnosticId)
  }

  private schedule<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.active < this.config.bridgeConcurrencyGlobal &&
        (this.activeByKey.get(key) ?? 0) < this.config.bridgeConcurrencyPerDid) {
      return this.start(key, run)
    }
    if (this.queue.length >= this.config.bridgeQueueDepth) return Promise.reject(new BridgeCapacityError())
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ key, run, resolve, reject } as QueuedCall<unknown>)
    })
  }

  private async start<T>(key: string, run: () => Promise<T>): Promise<T> {
    this.active += 1
    this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1)
    let lease: string | undefined
    try {
      if (!key.startsWith('_')) lease = this.lease?.begin(key)
      return await run()
    }
    finally {
      if (lease) this.lease?.finish(lease)
      this.active -= 1
      const remaining = (this.activeByKey.get(key) ?? 1) - 1
      if (remaining) this.activeByKey.set(key, remaining); else this.activeByKey.delete(key)
      this.drain()
    }
  }

  private drain() {
    for (let index = 0; index < this.queue.length && this.active < this.config.bridgeConcurrencyGlobal;) {
      const queued = this.queue[index]!
      if ((this.activeByKey.get(queued.key) ?? 0) >= this.config.bridgeConcurrencyPerDid) {
        index += 1
        continue
      }
      this.queue.splice(index, 1)
      void this.start(queued.key, queued.run).then(queued.resolve, queued.reject)
    }
  }

  statePath(did: string) {
    return join(this.config.dataDir, 'engine', sha(did).slice(0, 32) + '.db')
  }

  async call<T>(message: Record<string, unknown>, options: {
    key?: string
    timeoutMs?: number
    maxInputBytes?: number
    maxOutputBytes?: number
  } = {}): Promise<T> {
    const serialized = JSON.stringify(message)
    const maxInputBytes = options.maxInputBytes ?? 8 * 1024 * 1024
    if (Buffer.byteLength(serialized) > maxInputBytes) throw new PolicyValidationError('The policy request is too large.')
    return this.schedule(options.key ?? '_system', () => this.spawn<T>(serialized, options.timeoutMs, options.maxOutputBytes))
  }

  private async spawn<T>(serialized: string, timeoutMs = 120_000, maxOutputBytes = 16 * 1024 * 1024): Promise<T> {
    await mkdir(join(this.config.dataDir, 'engine'), { recursive: true, mode: 0o700 })
    return new Promise<T>((resolve, reject) => {
      const child = spawn(this.config.python, ['-m', 'atproto_acl.host_bridge'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: process.env.ATPROTO_ACL_PYTHONPATH,
          PYTHONUNBUFFERED: '1',
        },
      })
      let output = ''
      let stderr = ''
      let spawnFailed = false
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, Math.max(1, timeoutMs))
      child.stdout.setEncoding('utf8').on('data', chunk => {
        output += chunk
        if (output.length > maxOutputBytes) child.kill('SIGKILL')
      })
      child.stderr.setEncoding('utf8').on('data', chunk => {
        stderr += chunk
        if (stderr.length > 4096) child.kill('SIGKILL')
      })
      child.on('error', error => {
        spawnFailed = true
        reject(this.unavailable('interpreter spawn failed', error))
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (spawnFailed) return
        if (timedOut) return reject(this.unavailable('bridge timed out', { code, stderr }))
        try {
          const reply = JSON.parse(output) as BridgeReply<T>
          if (!reply.ok) {
            if (reply.error.startsWith('PolicyError:')) {
              return reject(new PolicyValidationError(reply.error.replace(/^PolicyError:\s*/, '')))
            }
            return reject(new Error(reply.error))
          }
          if (code !== 0) return reject(this.unavailable(`bridge exited with status ${code}`, stderr))
          resolve(reply.result)
        } catch {
          reject(this.unavailable('bridge returned an invalid response', { code, stderr }))
        }
      })
      child.stdin.end(serialized)
    })
  }

  preview(policy: string, account: string, acquisition: Acquisition, now?: string, timeoutMs?: number) {
    return this.call<Receipt>({
      command: 'preview', policy, account, state: this.statePath(account),
      ...acquisition, now, max_requests: 50, max_pages: 20,
    }, { key: account, timeoutMs })
  }

  validate(policy: string, account = '_validation') {
    return this.call<{ policy_hash: string; source_hash: string; config: Record<string, any> }>(
      { command: 'validate', policy },
      { key: account, timeoutMs: 10_000, maxInputBytes: 256 * 1024, maxOutputBytes: 2 * 1024 * 1024 },
    )
  }

  async health(force = false) {
    if (!force && this.healthResult && this.healthResult.expires > Date.now()) return this.healthResult.value
    const value = await this.call<BridgeHealth>({ command: 'health' }, {
      key: '_health', timeoutMs: 5_000, maxInputBytes: 1024, maxOutputBytes: 64 * 1024,
    })
    if (value.bridge_schema !== 1 || value.state_schema !== 1 || !value.package_version || !value.python_version) {
      throw this.unavailable('bridge health schema mismatch', value)
    }
    this.healthResult = { value, expires: Date.now() + 5_000 }
    return value
  }

  begin(account: string, subject: string, action: string, detail: unknown) {
    return this.call<{ attempt: number }>({
      command: 'begin_action', account, state: this.statePath(account), subject, action, detail,
    }, { key: account })
  }

  finish(account: string, subject: string, action: string, attempt: number, success: boolean) {
    return this.call({
      command: 'finish_action', account, state: this.statePath(account),
      subject, action, attempt, success,
    }, { key: account })
  }

  override(account: string, subject: string, kind: string, enabled: boolean) {
    return this.call<OverrideState>({
      command: 'override', account, state: this.statePath(account), subject, kind, enabled,
    }, { key: account })
  }

  overrides(account: string) {
    return this.call<OverrideState>({ command: 'list_overrides', account, state: this.statePath(account) }, { key: account })
  }
}

export type BridgeHealth = {
  bridge_schema: number
  package_version: string
  python_version: string
  state_schema: number
}

export function stableHash(value: unknown): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item
  return sha(JSON.stringify(sort(value)))
}
