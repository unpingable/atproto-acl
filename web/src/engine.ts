import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha } from './db.js'
import type { Acquisition, Receipt } from './types.js'
import type { Config } from './config.js'

type BridgeReply<T> = { ok: true; result: T } | { ok: false; error: string }

export class Engine {
  constructor(private config: Config) {}

  statePath(did: string) {
    return join(this.config.dataDir, 'engine', sha(did).slice(0, 32) + '.db')
  }

  async call<T>(message: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
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
      const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, timeoutMs))
      child.stdout.setEncoding('utf8').on('data', chunk => {
        output += chunk
        if (output.length > 16 * 1024 * 1024) child.kill('SIGKILL')
      })
      child.stderr.setEncoding('utf8').on('data', chunk => {
        stderr += chunk
        if (stderr.length > 4096) child.kill('SIGKILL')
      })
      child.on('error', reject)
      child.on('close', code => {
        clearTimeout(timer)
        try {
          const reply = JSON.parse(output) as BridgeReply<T>
          if (!reply.ok) return reject(new Error(reply.error))
          if (code !== 0) return reject(new Error('policy runtime refused the request'))
          resolve(reply.result)
        } catch {
          reject(new Error('policy runtime returned an invalid response'))
        }
      })
      child.stdin.end(JSON.stringify(message))
    })
  }

  preview(policy: string, account: string, acquisition: Acquisition, now?: string, timeoutMs?: number) {
    return this.call<Receipt>({
      command: 'preview', policy, account, state: this.statePath(account),
      ...acquisition, now, max_requests: 50, max_pages: 20,
    }, timeoutMs)
  }

  validate(policy: string) {
    return this.call<{ policy_hash: string; source_hash: string; config: Record<string, any> }>({ command: 'validate', policy })
  }

  begin(account: string, subject: string, action: string, detail: unknown) {
    return this.call<{ attempt: number }>({
      command: 'begin_action', account, state: this.statePath(account), subject, action, detail,
    })
  }

  finish(account: string, subject: string, action: string, attempt: number, success: boolean) {
    return this.call({
      command: 'finish_action', account, state: this.statePath(account),
      subject, action, attempt, success,
    })
  }

  override(account: string, subject: string, kind: string, enabled: boolean) {
    return this.call({
      command: 'override', account, state: this.statePath(account), subject, kind, enabled,
    })
  }
}

export function stableHash(value: unknown): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item
  return sha(JSON.stringify(sort(value)))
}
