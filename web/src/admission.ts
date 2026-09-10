import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AppDb } from './db.js'

export type AdmissionMode = 'allowlist' | 'invite' | 'open'
export type OAuthAttemptKind = 'sign_in' | 'reconnect'

export const ADMISSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS admissions (
  did TEXT PRIMARY KEY, source TEXT NOT NULL, writes_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
  redeemed_at TEXT, redeemed_did TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_expiry ON invites(expires_at);
CREATE TABLE IF NOT EXISTS oauth_attempts (
  state_hash TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, kind TEXT NOT NULL,
  invite_id TEXT, expected_did TEXT, stage TEXT NOT NULL, expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_attempts_expiry ON oauth_attempts(expires_at);
`

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const iso = (date: Date) => date.toISOString()

export function parseAdmissionMode(value: string | undefined): AdmissionMode {
  const mode = value || 'allowlist'
  if (mode !== 'allowlist' && mode !== 'invite' && mode !== 'open') {
    throw new Error('ATPROTO_ACL_ADMISSION_MODE must be allowlist, invite, or open')
  }
  return mode
}

/** A deliberately lossy category suitable for OAuth audit records. */
export function oauthFailureCategory(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : ''
  if (/state|csrf|expired/.test(message)) return 'invalid_or_expired_state'
  if (/access.denied|denied|cancel/.test(message)) return 'authorization_denied'
  if (/timeout|network|fetch|econn|unavailable/.test(message)) return 'provider_unavailable'
  if (/oauth|dpop|pkce|par|grant|protocol|authorization/.test(message)) return 'oauth_protocol_error'
  return 'oauth_callback_failed'
}

export type AdmissionOptions = {
  mode: AdmissionMode
  stateSecret: string
  allowedDids?: ReadonlySet<string>
  openWritesEnabled?: boolean
}

export type OAuthAttempt = {
  state: string
  correlationId: string
  expiresAt: string
}

export type AdmissionDecision = {
  did: string
  source: 'allowlist' | 'invite' | 'open' | 'existing' | 'reconnect'
  writesEnabled: boolean
}

/** Create an operator-delivered invite without requiring OAuth key material. */
export function createInvite(db: AppDb, at = new Date(), lifetimeMs = 14 * 24 * 60 * 60 * 1000) {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000) throw new Error('invite lifetime is invalid')
  const code = `acl_inv_${randomBytes(24).toString('base64url')}`
  const id = `inv_${randomBytes(18).toString('base64url')}`
  const expiresAt = new Date(at.getTime() + lifetimeMs)
  db.sql.prepare(`INSERT INTO invites
    (id,code_hash,expires_at,redeemed_at,redeemed_did,created_at) VALUES(?,?,?,NULL,NULL,?)`)
    .run(id, digest(code), iso(expiresAt), iso(at))
  return { id, code, expiresAt: iso(expiresAt) }
}

/** Admission and application-state handling around the OAuth client.
 *
 * The OAuth library owns protocol state and PKCE. This class owns the opaque
 * application state returned by the library, and binds it to an admission
 * attempt without storing the state or an invite code in plaintext.
 */
export class AdmissionManager {
  constructor(private db: AppDb, private options: AdmissionOptions) {
    if (options.stateSecret.length < 32) throw new Error('OAuth application-state secret is too short')
    // One-time compatibility migration for accounts explicitly authorized by
    // the former DID allowlist. Configuration is the permission boundary.
    const at = iso(new Date())
    for (const did of options.allowedDids ?? []) {
      if (!this.db.sql.prepare('SELECT 1 FROM users WHERE did=?').get(did)) continue
      this.db.sql.prepare(`INSERT OR IGNORE INTO admissions(did,source,writes_enabled,created_at,updated_at)
        VALUES(?,'allowlist',1,?,?)`).run(did, at, at)
    }
  }

  static install(db: AppDb) {
    db.sql.exec(ADMISSION_SCHEMA)
  }

  createInvite(at = new Date(), lifetimeMs = 14 * 24 * 60 * 60 * 1000) {
    return createInvite(this.db, at, lifetimeMs)
  }

  begin(input: { kind?: OAuthAttemptKind; inviteCode?: string; expectedDid?: string }, at = new Date()): OAuthAttempt {
    const kind = input.kind ?? 'sign_in'
    if (kind === 'reconnect' && !input.expectedDid) throw new Error('reconnect must be bound to an account')
    if (kind === 'sign_in' && !this.admissionsEnabled()) throw new Error('The beta is not accepting new sign-ins right now.')

    this.cleanup(at)
    let inviteId: string | null = null
    const code = input.inviteCode?.trim()
    if (code) {
      const invite = this.db.sql.prepare(`SELECT id FROM invites
        WHERE code_hash=? AND redeemed_at IS NULL AND expires_at>?`).get(digest(code), iso(at)) as { id: string } | undefined
      if (!invite) throw new Error('That invite code is invalid, expired, or already used.')
      inviteId = invite.id
    }

    const attemptId = randomBytes(18).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const signed = `v1.${attemptId}.${nonce}`
    const signature = createHmac('sha256', this.options.stateSecret).update(signed).digest('base64url')
    const state = `${signed}.${signature}`
    const correlationId = `oauth_${randomBytes(12).toString('base64url')}`
    const expiresAt = new Date(at.getTime() + 10 * 60 * 1000)
    this.db.sql.prepare(`INSERT INTO oauth_attempts
      (state_hash,correlation_id,kind,invite_id,expected_did,stage,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,'authorization_started',?,?,?)`).run(
        digest(state), correlationId, kind, inviteId, input.expectedDid ?? null,
        iso(expiresAt), iso(at), iso(at),
      )
    this.db.audit(null, 'oauth_progress', { correlation_id: correlationId, stage: 'authorization_started' })
    return { state, correlationId, expiresAt: iso(expiresAt) }
  }

  markCallbackReceived(state: string, at = new Date()) {
    const row = this.attempt(state, at)
    this.db.sql.prepare(`UPDATE oauth_attempts SET stage='callback_received',updated_at=? WHERE state_hash=?`)
      .run(iso(at), digest(state))
    this.db.audit(null, 'oauth_progress', { correlation_id: row.correlation_id, stage: 'callback_received' })
  }

  complete(state: string | null | undefined, did: string, at = new Date()): AdmissionDecision {
    if (!state) throw new Error('OAuth sign-in state was missing.')
    const row = this.attempt(state, at)
    let decision: AdmissionDecision | undefined
    let refusal: string | undefined

    this.db.transaction(() => {
      const current = this.db.sql.prepare(`SELECT correlation_id,kind,invite_id,expected_did
        FROM oauth_attempts WHERE state_hash=? AND expires_at>?`).get(digest(state), iso(at)) as AttemptRow | undefined
      if (!current) throw new Error('OAuth sign-in state expired or was already used.')
      // Application state is one-use even when admission is refused.
      this.db.sql.prepare('DELETE FROM oauth_attempts WHERE state_hash=?').run(digest(state))

      if (current.kind === 'reconnect') {
        if (current.expected_did !== did) { refusal = 'OAuth reconnect returned a different account.'; return }
        const admitted = this.admission(did)
        if (!admitted) { refusal = 'This account no longer has beta access.'; return }
        decision = { did, source: 'reconnect', writesEnabled: Boolean(admitted.writes_enabled) }
        return
      }

      const admitted = this.admission(did)
      if (admitted) {
        decision = { did, source: 'existing', writesEnabled: Boolean(admitted.writes_enabled) }
        return
      }
      // A freeze blocks new account admission even if authorization began earlier.
      if (!this.admissionsEnabled()) { refusal = 'The beta is not accepting new accounts right now.'; return }

      if (this.options.mode === 'allowlist') {
        if (!this.options.allowedDids?.has(did)) { refusal = 'This pilot is currently access restricted.'; return }
        this.insertAdmission(did, 'allowlist', true, at)
        decision = { did, source: 'allowlist', writesEnabled: true }
        return
      }
      if (this.options.mode === 'open') {
        const writes = Boolean(this.options.openWritesEnabled)
        this.insertAdmission(did, 'open', writes, at)
        decision = { did, source: 'open', writesEnabled: writes }
        return
      }
      if (!current.invite_id) { refusal = 'An invite code is required for a first sign-in.'; return }
      const claimed = this.db.sql.prepare(`UPDATE invites SET redeemed_at=?,redeemed_did=?
        WHERE id=? AND redeemed_at IS NULL AND expires_at>?`).run(iso(at), did, current.invite_id, iso(at))
      if (claimed.changes !== 1) { refusal = 'That invite code is invalid, expired, or already used.'; return }
      this.insertAdmission(did, 'invite', false, at)
      decision = { did, source: 'invite', writesEnabled: false }
    })

    if (refusal) throw new Error(refusal)
    this.db.audit(did, 'oauth_progress', {
      correlation_id: row.correlation_id,
      stage: 'admission_completed',
      admission_source: decision!.source,
    })
    return decision!
  }

  private attempt(state: string, at: Date): AttemptRow {
    if (!this.validStateSignature(state)) throw new Error('OAuth sign-in state was invalid.')
    const row = this.db.sql.prepare(`SELECT correlation_id,kind,invite_id,expected_did
      FROM oauth_attempts WHERE state_hash=? AND expires_at>?`).get(digest(state), iso(at)) as AttemptRow | undefined
    if (!row) throw new Error('OAuth sign-in state expired or was already used.')
    return row
  }

  private validStateSignature(state: string) {
    const pieces = state.split('.')
    if (pieces.length !== 4 || pieces[0] !== 'v1') return false
    const signed = pieces.slice(0, 3).join('.')
    const expected = createHmac('sha256', this.options.stateSecret).update(signed).digest()
    let actual: Buffer
    try { actual = Buffer.from(pieces[3]!, 'base64url') } catch { return false }
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private admission(did: string) {
    return this.db.sql.prepare('SELECT source,writes_enabled FROM admissions WHERE did=?')
      .get(did) as { source: string; writes_enabled: number } | undefined
  }

  private insertAdmission(did: string, source: AdmissionDecision['source'], writes: boolean, at: Date) {
    this.db.sql.prepare(`INSERT INTO admissions(did,source,writes_enabled,created_at,updated_at)
      VALUES(?,?,?,?,?)`).run(did, source, writes ? 1 : 0, iso(at), iso(at))
  }

  private admissionsEnabled() {
    const row = this.db.sql.prepare('SELECT admissions_enabled FROM service_controls WHERE singleton=1')
      .get() as { admissions_enabled: number } | undefined
    // Missing/unreadable durable standing fails closed.
    return row?.admissions_enabled === 1
  }

  private cleanup(at: Date) {
    this.db.sql.prepare('DELETE FROM oauth_attempts WHERE expires_at<=?').run(iso(at))
  }
}

type AttemptRow = {
  correlation_id: string
  kind: OAuthAttemptKind
  invite_id: string | null
  expected_did: string | null
}
