import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

export type Config = {
  origin: string
  port: number
  dataDir: string
  python: string
  sessionSecret: string
  oauthKeyFile: string
  allowedDids: Set<string>
  fixtureMode: boolean
  workerEnabled: boolean
  admissionMode: 'allowlist' | 'invite' | 'open'
  acquisitionStartsPerDidHour: number
  acquisitionStartsGlobalHour: number
  acquisitionConcurrencyGlobal: number
  acquisitionConcurrencyPerDid: number
  acquisitionQueueDepth: number
  acquisitionMaxWaitSeconds: number
  actionBatchMax: number
  effectsPerDidDay: number
  effectsGlobalDay: number
  queuedActionsGlobal: number
  bridgeConcurrencyGlobal: number
  bridgeConcurrencyPerDid: number
  bridgeQueueDepth: number
  tombstonePath: string
  tombstoneSecret: string
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('invalid capacity setting')
  return parsed
}

export function loadConfig(env = process.env): Config {
  const origin = env.ATPROTO_ACL_ORIGIN ?? 'http://127.0.0.1:8426'
  const parsed = new URL(origin)
  const fixtureMode = env.ATPROTO_ACL_FIXTURE_MODE === '1'
  if (!fixtureMode && parsed.protocol !== 'https:') {
    throw new Error('production origin must use HTTPS')
  }
  const sessionSecret = env.ATPROTO_ACL_SESSION_SECRET_FILE
    ? readFileSync(env.ATPROTO_ACL_SESSION_SECRET_FILE, 'utf8').trim()
    : env.ATPROTO_ACL_SESSION_SECRET ?? (fixtureMode ? 'fixture-session-secret-at-least-32-bytes' : '')
  if (sessionSecret.length < 32) throw new Error('ATPROTO_ACL_SESSION_SECRET must contain at least 32 characters')
  const dataDir = resolve(env.ATPROTO_ACL_DATA_DIR ?? './var')
  const tombstoneSecret = env.ATPROTO_ACL_TOMBSTONE_SECRET_FILE
    ? readFileSync(env.ATPROTO_ACL_TOMBSTONE_SECRET_FILE, 'utf8').trim()
    : env.ATPROTO_ACL_TOMBSTONE_SECRET ?? (fixtureMode ? sessionSecret : '')
  const admissionMode = env.ATPROTO_ACL_ADMISSION_MODE ?? 'allowlist'
  if (!['allowlist', 'invite', 'open'].includes(admissionMode)) throw new Error('invalid admission mode')
  return {
    origin: parsed.origin,
    port: Number(env.ATPROTO_ACL_PORT ?? parsed.port ?? 8426),
    dataDir,
    python: env.ATPROTO_ACL_PYTHON ?? 'python3',
    sessionSecret,
    oauthKeyFile: env.ATPROTO_ACL_OAUTH_KEY_FILE ?? '',
    allowedDids: new Set((env.ATPROTO_ACL_ALLOWED_DIDS ?? '').split(',').map(x => x.trim()).filter(Boolean)),
    fixtureMode,
    workerEnabled: env.ATPROTO_ACL_WORKER !== '0',
    admissionMode: admissionMode as Config['admissionMode'],
    acquisitionStartsPerDidHour: boundedInt(env.ATPROTO_ACL_ACQUISITION_STARTS_PER_DID_HOUR, 6, 1, 1000),
    acquisitionStartsGlobalHour: boundedInt(env.ATPROTO_ACL_ACQUISITION_STARTS_GLOBAL_HOUR, 20, 1, 10000),
    acquisitionConcurrencyGlobal: boundedInt(env.ATPROTO_ACL_ACQUISITION_CONCURRENCY_GLOBAL, 2, 1, 100),
    acquisitionConcurrencyPerDid: boundedInt(env.ATPROTO_ACL_ACQUISITION_CONCURRENCY_PER_DID, 1, 1, 20),
    acquisitionQueueDepth: boundedInt(env.ATPROTO_ACL_ACQUISITION_QUEUE_DEPTH, 10, 0, 10000),
    acquisitionMaxWaitSeconds: boundedInt(env.ATPROTO_ACL_ACQUISITION_MAX_WAIT_SECONDS, 600, 1, 86400),
    actionBatchMax: boundedInt(env.ATPROTO_ACL_ACTION_BATCH_MAX, 50, 1, 100),
    effectsPerDidDay: boundedInt(env.ATPROTO_ACL_EFFECTS_PER_DID_DAY, 100, 1, 10000),
    effectsGlobalDay: boundedInt(env.ATPROTO_ACL_EFFECTS_GLOBAL_DAY, 250, 1, 100000),
    queuedActionsGlobal: boundedInt(env.ATPROTO_ACL_QUEUED_ACTIONS_GLOBAL, 500, 1, 100000),
    bridgeConcurrencyGlobal: boundedInt(env.ATPROTO_ACL_BRIDGE_CONCURRENCY_GLOBAL, 4, 1, 32),
    bridgeConcurrencyPerDid: boundedInt(env.ATPROTO_ACL_BRIDGE_CONCURRENCY_PER_DID, 1, 1, 8),
    bridgeQueueDepth: boundedInt(env.ATPROTO_ACL_BRIDGE_QUEUE_DEPTH, 32, 0, 1000),
    tombstonePath: resolve(env.ATPROTO_ACL_TOMBSTONE_PATH ?? `${dataDir}-deletions/deletions.db`),
    tombstoneSecret,
  }
}
