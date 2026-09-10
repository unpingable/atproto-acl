import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type Config } from './config.js'
import { AppDb, asJson, sha } from './db.js'
import { Engine } from './engine.js'
import { dashboard, deleteAccountPage, deletedAccountPage, exposureDetails, h, helpPage, jobPage, landing, page, policyEditor, previewPage, privacyPage,
  profileUrl, safeAvatarUrl } from './html.js'
import { hasRpcPermission, OAuthAccounts } from './oauth.js'
import { bsky38Policy, buildGuidedPolicy, poastersPolicy, type GuidedPolicy } from './policy-editor.js'
import { AclService } from './service.js'
import { Worker } from './worker.js'
import type { AccountProvider, Receipt } from './types.js'
import { CapacityError, ServiceControls } from './controls.js'
import { AdmissionManager, oauthFailureCategory } from './admission.js'
import { PrivacyManager } from './privacy.js'

type Auth = AccountProvider & {
  authorize(handle: string, state: string): Promise<URL>
  callback(params: URLSearchParams): Promise<{ session: { did: string }; state?: string | null }>
  metadata: unknown
  jwks: unknown
}

const cookies = (req: IncomingMessage) => Object.fromEntries(
  (req.headers.cookie ?? '').split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const at = x.indexOf('='); return [x.slice(0, at), decodeURIComponent(x.slice(at + 1))]
  }),
)

const cookie = (name: string, value: string, config: Config, options = '') =>
  `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; ${config.fixtureMode ? '' : 'Secure; '}${options}`

async function body(req: IncomingMessage) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 256 * 1024) throw new Error('form is too large')
  }
  return new URLSearchParams(raw)
}

function send(res: ServerResponse, status: number, content: string | Buffer, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(content)
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

function loginToken(config: Config) {
  const issued = Math.floor(Date.now() / 1000).toString()
  const nonce = randomBytes(24).toString('base64url')
  const value = `${issued}.${nonce}`
  const sig = createHmac('sha256', config.sessionSecret).update(value).digest('base64url')
  return `${value}.${sig}`
}

function validLoginToken(config: Config, value: string) {
  const at = value.lastIndexOf('.')
  if (at < 1) return false
  const signed = value.slice(0, at)
  const issuedText = signed.slice(0, signed.indexOf('.'))
  if (!/^\d+$/.test(issuedText)) return false
  const issued = Number(issuedText)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(issued) || issued > now + 60 || now - issued > 10 * 60) return false
  const expected = Buffer.from(createHmac('sha256', config.sessionSecret).update(signed).digest())
  let actual: Buffer
  try { actual = Buffer.from(value.slice(at + 1), 'base64url') } catch { return false }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'request failed'
  return message.replace(/https?:\/\/\S+/g, 'remote service').slice(0, 240)
}

function yieldReportPage(
  account: { did: string; handle: string; pds: string },
  csrf: string,
  report: any,
  query = '',
) {
  const sourceNames: Record<string, string> = { timeline: 'Following', generator: 'Discover' }
  const sourceRows = report.sources ?? []
  const status = report.status ?? 'completed'
  const active = status === 'running'
  const interrupted = status === 'interrupted' || status === 'failed'
  const sourceSummary = sourceRows.map((source: any) => {
    const name = sourceNames[source.surface] ?? source.surface
    const items = source.items_fetched ?? source.completed ?? 0
    const authors = source.distinct_authors
    if (source.complete) return `${name}: read ${items} posts by ${authors} different accounts.`
    if (active) return `${name}: read ${items} of ${source.total ?? 500} posts so far.`
    return `${name}: stopped after ${items} posts${authors !== undefined ? ` by ${authors} different accounts` : ''}.`
  }).join(' ')
  const technicalSources = sourceRows.map((source: any) => `
    <section class="result-section">
      <div class="section-heading"><div><p class="eyebrow">${h(sourceNames[source.surface] ?? source.surface)}</p>
      <h3>${h(String(source.items_fetched ?? source.completed ?? 0))} posts · ${source.distinct_authors === undefined ? 'counting accounts…' : `${h(String(source.distinct_authors))} accounts`}</h3></div>
      <span class="status ${source.complete ? 'status-good' : 'status-warn'}">${source.complete ? 'Finished' : active ? 'Reading' : 'Stopped early'}</span></div>
      ${source.reason ? `<p class="notice">${h(source.reason)}</p>` : ''}
      ${source.relationships ? `<dl class="metrics compact-metrics">
        <div><dt>Author occurrences</dt><dd>${h(String(source.author_occurrences))}</dd></div>
        <div><dt>Unique posts</dt><dd>${h(String(source.unique_posts))}</dd></div>
        <div><dt>Not followed</dt><dd>${h(String(source.relationships.not_followed ?? 0))}</dd></div>
        <div><dt>Followed</dt><dd>${h(String(source.relationships.followed ?? 0))}</dd></div>
      </dl>` : ''}
      ${source.prefixes?.length ? `<div class="table-wrap"><table><thead><tr><th>Posts read</th><th>Accounts</th><th>Looked up</th><th>Had labels</th><th>Matched rules</th><th>Would mute</th><th>You follow</th><th>Couldn’t tell</th></tr></thead><tbody>
      ${source.prefixes.map((prefix: any) => `<tr><td>${h(String(prefix.items))}</td><td>${h(String(prefix.distinct_authors))}</td><td>${h(String(prefix.publisher_checks))}</td><td>${h(String(prefix.positive_labels))}</td><td>${h(String(prefix.matching_accounts))}</td><td>${h(String(prefix.actionable_mutes))}</td><td>${h(String(prefix.followed_review))}</td><td>${h(String(prefix.unresolved))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    </section>`).join('')

  if (active || interrupted) {
    const heading = active ? 'Reading your feeds…' : 'The scan stopped early'
    const explanation = active
      ? 'This takes a moment. You can go back to the dashboard and it will keep going — it only reads, so it can’t change anything on your account.'
      : report.interruption_reason ?? 'The scan stopped before it finished. Nothing was changed. You can start a new one.'
    return page('Feed coverage', `
      <nav><a href="/app">← Dashboard</a></nav><section class="title page-heading"><div><p class="eyebrow">Nothing is being changed</p><h1>${h(heading)}</h1><p>${h(explanation)}</p><p><a class="button" href="/app">Back to dashboard</a></p></div><span class="status ${active ? 'status-warn' : 'needs_review'}">${h(status)}</span></section>
      ${sourceSummary ? `<section class="panel"><p>${h(sourceSummary)}</p></section>` : '<section class="panel"><p>Asking Bluesky for the first batch of posts.</p></section>'}
      <details class="technical"><summary>Technical details</summary>${technicalSources || '<p>No feed page finished before this stopped.</p>'}</details>
      ${active ? '<span id="measurement-refresh" data-auto-refresh="true" class="muted" role="status">Checking for updates…</span>' : ''}`, account, csrf)
  }

  const allPeople = (report.affected ?? []).filter((item: any) => item.subject !== report.account?.did)
  const searchable = (item: any) => [item.subject, item.handle, item.display_name, item.reason, ...(item.matches ?? [])].join(' ').toLowerCase()
  const people = allPeople.filter((item: any) => !query || searchable(item).includes(query.toLowerCase()))
  const proposed = people.filter((item: any) => item.action === 'mute')
  const followed = people.filter((item: any) => item.action === 'follow_review_candidate')
  const handled = people.filter((item: any) => !['mute', 'follow_review_candidate'].includes(item.action))
  const evidenceLabels: Record<string, string> = {
    'monthly-posts-over-twenty-per-day': 'Averaged more than 20 posts a day this month',
    'made-over-thirty-posts-yesterday': 'Made more than 30 posts yesterday',
    'made-over-thirty-replies-yesterday': 'Made more than 30 replies yesterday',
  }
  const person = (item: any) => {
    const profile = profileUrl(String(item.subject))
    const avatar = safeAvatarUrl(item.avatar)
    const title = item.display_name || (item.handle ? `@${item.handle}` : item.subject)
    const conditions = [...new Set((item.evidence ?? []).map((entry: any) => evidenceLabels[entry.property] ?? entry.property))]
    const surfaces = [...new Set((item.exposures ?? []).map((entry: any) => entry.surface === 'generator' ? 'Discover' : 'Following'))]
    return `<article class="result measurement-account"><div></div><div>
      <div class="account-heading">${avatar ? `<img class="avatar" src="${h(avatar)}" alt="">` : '<span class="avatar avatar-placeholder" aria-hidden="true"></span>'}<div><h3><a href="${h(profile)}" target="_blank" rel="noopener noreferrer">${h(title)}</a></h3>${item.display_name && item.handle ? `<p class="handle"><a href="${h(profile)}" target="_blank" rel="noopener noreferrer">@${h(item.handle)}</a></p>` : ''}<p class="profile-link"><a href="${h(profile)}" target="_blank" rel="noopener noreferrer">View profile</a></p></div></div>
      <p><strong>Why:</strong> ${h(conditions.join(' · ') || 'Matched the rules in the example policy')}</p>
      <p><strong>Seen in:</strong> ${h(surfaces.join(' and ') || 'couldn’t tell')}</p>
      ${exposureDetails(item.exposures ?? [])}
      <details class="technical"><summary>Posting data and account details</summary><p class="did">${h(item.subject)}</p><ul>${(item.evidence ?? []).map((entry: any) => `<li>${h(evidenceLabels[entry.property] ?? entry.property)} · observed ${h(entry.observed_at)}${entry.expires_at ? ` · expires ${h(entry.expires_at)}` : ''}</li>`).join('')}</ul></details>
    </div></article>`
  }
  const overall = report.overall ?? {}
  const totalItems = overall.items_fetched ?? sourceRows.reduce((sum: number, source: any) => sum + Number(source.items_fetched ?? 0), 0)
  const matched = allPeople.length
  const feedMatched = Number(overall.feed_matching_accounts ?? (report.schema === 2 ? overall.matching_accounts : matched))
  const retainedMatched = Number(overall.retained_context_matches ?? Math.max(0, matched - feedMatched))
  const sourceStanding = sourceRows.map((source: any) => {
    const name = sourceNames[source.surface] ?? source.surface
    const added = source.added_distinct_authors
    const addedMatches = source.added_matching_accounts
    return `<li><strong>${h(name)}:</strong> ${h(String(source.items_fetched ?? 0))} posts · ${h(String(source.distinct_authors ?? 0))} accounts${added === undefined ? '' : ` · ${h(String(added))} not seen in another feed`}${addedMatches === undefined ? '' : ` · ${h(String(addedMatches))} matched`}</li>`
  }).join('')
  const defaultView = query || !proposed.length ? 'all' : 'proposed'
  // Empty chips lead nowhere, so only render the ones with something behind them.
  const filterButton = (value: string, label: string, count: number) => !count && value !== 'all' ? '' :
    `<button type="button" class="result-filter${defaultView === value ? ' active' : ''}" data-result-filter="${value}" aria-pressed="${defaultView === value}">${h(label)} <span>${count}</span></button>`
  return page('What a scan would find', `
    <nav><a href="/app">← Dashboard</a></nav><section class="title page-heading"><div><p class="eyebrow">Nothing was changed</p><h1>${matched ? `${h(String(matched))} account${matched === 1 ? '' : 's'} would match` : 'Nothing in your feed matched'}</h1>
    <p>${matched ? `${h(String(proposed.length))} could be muted${followed.length ? ` · ${h(String(followed.length))} you follow, listed separately` : ''}${handled.length ? ` · ${h(String(handled.length))} already muted or left alone` : ''}.` : 'Nobody in this sample of your feeds posts often enough to match the example rules.'}</p>
    <p class="scope-line">Read ${h(String(totalItems))} posts by ${h(String(overall.distinct_authors ?? '—'))} different accounts${retainedMatched ? `, plus ${h(String(retainedMatched))} from your earlier scans` : ''}. This was a look, not a change — set up a policy when you want to actually mute anyone.</p></div></section>
    <div class="metrics"><div><strong>${h(String(totalItems))}</strong><span>posts read</span></div><div><strong>${h(String(overall.distinct_authors ?? '—'))}</strong><span>accounts seen</span></div><div><strong>${h(String(proposed.length))}</strong><span>would be muted</span></div><div><strong>${h(String(followed.length))}</strong><span>you follow</span></div></div>
    <section class="source-standing"><p><strong>What each feed added</strong></p><ul>${sourceStanding}</ul></section>
    <form method="get"><label for="q">Search these accounts</label><div class="search"><input id="q" name="q" value="${h(query)}"><button class="quiet">Search</button></div></form>
    <div class="result-filters" role="group" aria-label="Filter matching accounts" data-default-filter="${h(defaultView)}">
      ${filterButton('proposed', 'Would be muted', proposed.length)}
      ${filterButton('followed', 'People you follow', followed.length)}
      ${filterButton('unchanged', 'Already handled', handled.length)}
      ${filterButton('all', 'Everyone', people.length)}
    </div>
    <div class="filter-empty" role="status" hidden>Nothing in this view.</div>
    <section class="result-group" data-result-group="proposed"><div class="results">${proposed.map(person).join('')}</div><nav class="result-pages" aria-label="Proposed mute pages"></nav></section>
    <section class="result-group" data-result-group="followed"><div class="notice"><strong>These are people you follow</strong><p>They matched, but they’re listed on their own so you don’t mute a friend by accident.</p></div><div class="results">${followed.map(person).join('')}</div><nav class="result-pages" aria-label="Followed account pages"></nav></section>
    <section class="result-group" data-result-group="unchanged"><div class="results">${handled.map(person).join('')}</div><nav class="result-pages" aria-label="Already handled result pages"></nav></section>
    ${!people.length ? '<p class="empty">Nothing matches that search.</p>' : ''}
    <div class="actions next-step"><a class="button" href="/policies/new?example=poasters">Set up a scan like this</a><a href="/app">Back to dashboard</a></div>
    <details class="technical receipt"><summary>Technical details</summary><p>${h(sourceSummary)}</p>${technicalSources}<dl><dt>Policy hash</dt><dd><code>${h(report.policy_hash)}</code></dd><dt>Acquisition hash</dt><dd><code>${h(report.acquisition_hash)}</code></dd><dt>Evaluated</dt><dd>${h(report.evaluated_at)}</dd><dt>Policy evaluation complete</dt><dd>${h(String(report.policy_evaluation_complete ?? report.complete))}</dd></dl><pre>${h(JSON.stringify(report.policy, null, 2))}</pre></details>`, account, csrf)
}
export async function createApp(config: Config, db: AppDb, service: AclService, auth: Auth) {
  db.recoverInterruptedMeasurements()
  const controls = new ServiceControls(db, config)
  AdmissionManager.install(db)
  const admissions = new AdmissionManager(db, {
    mode: config.admissionMode, stateSecret: config.sessionSecret,
    allowedDids: config.allowedDids, openWritesEnabled: false,
  })
  const privacy = new PrivacyManager(db, {
    dataDir: config.dataDir, tombstonePath: config.tombstonePath, tombstoneSecret: config.tombstoneSecret,
  })
  privacy.reconcileRestore()
  db.pruneExpiredUserData()
  const css = await readFile(join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'app.css'), 'utf8')
  const js = await readFile(join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'app.js'), 'utf8')
  const socialCard = await readFile(join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'social-card.png'))
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https://cdn.bsky.app; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    const url = new URL(req.url ?? '/', config.origin)
    const jar = cookies(req)
    const session = db.session(jar.acl_session)
    const did = session ? String(session.did) : ''
    const grantedScopes = session ? (() => {
      try {
        const value = JSON.parse(String(session.permissions ?? '[]'))
        return Array.isArray(value) ? value.map(String) : []
      } catch { return [] }
    })() : []
    const account = session ? {
      did, handle: String(session.handle), pds: String(session.pds ?? ''),
      reconnectRequired: !hasRpcPermission(grantedScopes, 'app.bsky.feed.getFeedSkeleton'),
      writesEnabled: controls.accountWritesEnabled(did),
    } : undefined
    const csrf = jar.acl_csrf ?? ''
    try {
      if (req.method === 'GET' && url.pathname === '/health/live') return send(res, 200, '{"status":"ok"}', 'application/json')
      if (req.method === 'GET' && url.pathname === '/health/ready') {
        db.sql.prepare('SELECT 1').get()
        controls.state()
        privacy.assertReady()
        return send(res, 200, '{"status":"ready"}', 'application/json')
      }
      if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, css, 'text/css; charset=utf-8')
      if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, js, 'text/javascript; charset=utf-8')
      if (req.method === 'GET' && url.pathname === '/social-card.png') return send(res, 200, socialCard, 'image/png')
      if (req.method === 'GET' && url.pathname === '/help') return send(res, 200, helpPage(account, csrf))
      if (req.method === 'GET' && url.pathname === '/privacy') return send(res, 200, privacyPage(account, csrf))
      if (req.method === 'GET' && url.pathname === '/oauth-client-metadata.json') {
        return send(res, 200, JSON.stringify(auth.metadata), 'application/json')
      }
      if (req.method === 'GET' && url.pathname === '/oauth-jwks.json') {
        return send(res, 200, JSON.stringify(auth.jwks), 'application/json')
      }
      if (req.method === 'GET' && url.pathname === '/') {
        if (session) return redirect(res, '/app')
        const token = loginToken(config)
        return send(res, 200, landing(token, url.searchParams.get('error') ?? '', config.admissionMode))
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== config.origin) return send(res, 403, page('Request refused', '<section class="title"><div><h1>That request didn’t come from here</h1><p>Nothing was changed. Go back and try again from this site.</p><p><a class="button" href="/">Back to sign in</a></p></div></section>'))
        const form = await body(req)
        if (url.pathname === '/oauth/start') {
          const token = form.get('login_token') ?? ''
          if (!validLoginToken(config, token)) return send(res, 403, page('Request refused', '<section class="title"><div><h1>That sign-in link expired</h1><p>Start again from the sign-in page.</p><p><a class="button" href="/">Back to sign in</a></p></div></section>'))
          const handle = (form.get('handle') ?? '').trim().replace(/^@/, '')
          if (!/^[a-zA-Z0-9.-]{3,253}$/.test(handle)) throw new Error('enter a valid account handle')
          const attempt = admissions.begin({ inviteCode: form.get('invite_code') ?? undefined })
          const target = await auth.authorize(handle, attempt.state)
          return redirect(res, target.toString())
        }
        if (!session || !db.checkCsrf(session, form.get('csrf') ?? undefined) || form.get('csrf') !== csrf) {
          return send(res, 403, page('Request refused', '<section class="title"><div><h1>Your session expired</h1><p>Nothing was changed. Sign in again and repeat what you were doing.</p><p><a class="button" href="/">Back to sign in</a></p></div></section>'))
        }
        if (!Number(session.connected) && !['/disconnect', '/signout'].includes(url.pathname)) return send(res, 403, page('Disconnected', '<section class="title"><div><h1>This account is disconnected</h1><p>Sign in again to use the app.</p><p><a class="button" href="/">Back to sign in</a></p></div></section>'))
        if (privacy.deletionRequested(did) && url.pathname !== '/account/delete') {
          return send(res, 409, deleteAccountPage(account!, csrf, privacy.standing(did), 'Account deletion is pending.'))
        }
        if (url.pathname === '/reconnect') {
          const attempt = admissions.begin({ kind: 'reconnect', expectedDid: did })
          const target = await auth.authorize(account!.handle, attempt.state)
          db.transaction(() => {
            db.sql.prepare('UPDATE users SET connected=0,updated_at=? WHERE did=?').run(new Date().toISOString(), did)
            db.sql.prepare("UPDATE jobs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'disconnected' ELSE status END,updated_at=? WHERE did=? AND status IN ('queued','running')")
              .run(new Date().toISOString(), did)
            db.sql.prepare('DELETE FROM web_sessions WHERE did=?').run(did)
            db.audit(did, 'oauth_reconnect_started', { existing_mutes_remain: true })
          })
          try { await (await service.accounts.restore(did)).disconnect() } catch {}
          db.sql.prepare('DELETE FROM oauth_sessions WHERE did=?').run(did)
          res.setHeader('Set-Cookie', [cookie('acl_session', '', config, 'HttpOnly; Max-Age=0'), cookie('acl_csrf', '', config, 'Max-Age=0')])
          return redirect(res, target.toString())
        }
        if (url.pathname === '/policies/save') {
          const name = (form.get('name') ?? '').trim()
          if (!name || name.length > 80) throw new Error('policy name is required')
          const existing = form.get('id') || undefined
          const editor = form.get('after') === 'preview' ? 'guided' : form.get('editor')
          const draft: GuidedPolicy = {
            supported: true,
            sourceType: ['feeds', 'timeline', 'follows', 'labeled_stream', 'explicit_dids', 'external_snapshot'].includes(form.get('source_type') ?? '')
              ? form.get('source_type') as GuidedPolicy['sourceType'] : 'timeline',
            limit: Number(form.get('limit') ?? 500),
            subjects: (form.get('subjects') ?? '').split(/[\s,]+/).filter(Boolean),
            monthly: form.get('monthly') === '1',
            dailyPair: form.get('daily_pair') === '1',
          }
          let policyBody = form.get('body') ?? ''
          try {
            if (editor === 'guided') {
              if (draft.sourceType === 'explicit_dids') {
                if (!draft.subjects.length) throw new Error('Enter at least one account handle or DID.')
                const resolved = await (await service.accounts.restore(did)).resolve(draft.subjects)
                draft.subjects = [...new Set(draft.subjects.map(actor => resolved[actor]))]
              }
              policyBody = buildGuidedPolicy(did, {
                sourceType: draft.sourceType, limit: draft.limit, subjects: draft.subjects,
                monthly: draft.monthly, dailyPair: draft.dailyPair,
              })
            }
            await service.engine.validate(policyBody)
          } catch (error) {
            const message = safeError(error).replace(/^PolicyError:\s*/, '')
            return send(res, 400, policyEditor(account!, csrf, { id: existing, name, body: policyBody }, message,
              editor === 'guided' ? draft : undefined))
          }
          const id = service.savePolicy(did, name, policyBody, existing)
          if (editor === 'guided' && form.get('after') === 'preview') {
            const result = await service.preview(did, id)
            return redirect(res, `/previews/${result.id}`)
          }
          return redirect(res, `/policies/${id}`)
        }
        if (url.pathname === '/diagnostics/yield') {
          const measured = await service.startFeedYield(did, poastersPolicy(did))
          void measured.completion.catch(() => {})
          return redirect(res, `/diagnostics/yield/${measured.id}`)
        }
        const previewMatch = url.pathname.match(/^\/policies\/([^/]+)\/preview$/)
        if (previewMatch) {
          const result = await service.preview(did, previewMatch[1]!)
          return redirect(res, `/previews/${result.id}`)
        }
        const approveMatch = url.pathname.match(/^\/previews\/([^/]+)\/approve$/)
        if (approveMatch) {
          const kind = form.get('kind')
          if (kind !== 'apply' && kind !== 'apply_followed' && kind !== 'release') throw new Error('choose an approval type')
          const job = service.approve(did, approveMatch[1]!, kind, form.getAll('subject'))
          return redirect(res, `/jobs/${job}`)
        }
        const recheckMatch = url.pathname.match(/^\/jobs\/([^/]+)\/recheck\/([^/]+)$/)
        if (recheckMatch) {
          const subject = decodeURIComponent(recheckMatch[2]!)
          if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(subject)) throw new Error('invalid account DID')
          await service.recheckUncertain(did, recheckMatch[1]!, subject)
          return redirect(res, `/jobs/${recheckMatch[1]}`)
        }
        const cancelMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/)
        if (cancelMatch) {
          service.owned('jobs', cancelMatch[1]!, did)
          db.sql.prepare('UPDATE jobs SET cancel_requested=1,updated_at=? WHERE id=? AND did=?')
            .run(new Date().toISOString(), cancelMatch[1], did)
          db.audit(did, 'job_cancel_requested', { job: cancelMatch[1] })
          return redirect(res, `/jobs/${cancelMatch[1]}`)
        }
        if (url.pathname === '/overrides') {
          const actor = (form.get('subject') ?? '').trim().replace(/^@/, '')
          const kind = form.get('kind') ?? ''
          if (!actor || actor.length > 253 || !['exempt','allow','keep_muted'].includes(kind)) {
            throw new Error('override requires an account and a supported kind')
          }
          const resolved = await (await service.accounts.restore(did)).resolve([actor])
          const subject = resolved[actor]
          if (!subject || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(subject)) throw new Error('account could not be resolved to a DID')
          const enabled = form.get('enabled') === '1'
          await service.engine.override(did, subject, kind, enabled)
          try {
            if (enabled) {
              db.sql.prepare('INSERT OR REPLACE INTO account_exceptions (did,subject,kind,handle,created_at) VALUES (?,?,?,?,?)')
                .run(did, subject, kind, actor === subject ? '' : actor, new Date().toISOString())
            } else {
              db.sql.prepare('DELETE FROM account_exceptions WHERE did=? AND subject=? AND kind=?').run(did, subject, kind)
            }
          } catch { db.audit(did, 'override_handle_cache_failed', { subject, kind }) }
          db.audit(did, 'override_changed', { subject, kind, enabled })
          return redirect(res, '/app')
        }
        if (url.pathname === '/signout') {
          db.deleteSession(jar.acl_session)
          db.audit(did, 'signed_out', { connection_retained: true })
          res.setHeader('Set-Cookie', [cookie('acl_session', '', config, 'HttpOnly; Max-Age=0'), cookie('acl_csrf', '', config, 'Max-Age=0')])
          return redirect(res, '/')
        }
        if (url.pathname === '/disconnect') {
          db.transaction(() => {
            db.sql.prepare('UPDATE users SET connected=0,updated_at=? WHERE did=?').run(new Date().toISOString(), did)
            db.sql.prepare("UPDATE jobs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'disconnected' ELSE status END,updated_at=? WHERE did=? AND status IN ('queued','running')")
              .run(new Date().toISOString(), did)
            db.sql.prepare('DELETE FROM web_sessions WHERE did=?').run(did)
            db.audit(did, 'account_disconnected', { existing_mutes_remain: true })
          })
          try { await (await service.accounts.restore(did)).disconnect() } catch {}
          db.sql.prepare('DELETE FROM oauth_sessions WHERE did=?').run(did)
          res.setHeader('Set-Cookie', [cookie('acl_session', '', config, 'HttpOnly; Max-Age=0'), cookie('acl_csrf', '', config, 'Max-Age=0')])
          return send(res, 200, page('Disconnected', '<section class="title"><div><h1>App disconnected</h1><p>This app can no longer read your feeds or change your mutes. Anyone you muted stays muted, and your policies and history are still here if you sign in again.</p><p><a class="button" href="/">Back to sign in</a></p></div></section>'))
        }
        if (url.pathname === '/account/delete') {
          if (form.get('confirm') !== 'delete') throw new Error('Confirm that you want to delete this account data.')
          const mode = form.get('mode')
          if (mode !== 'leave_mutes' && mode !== 'after_releases') throw new Error('Choose a supported deletion path.')
          const before = privacy.standing(did)
          if (mode === 'after_releases' && before.historicallyAttributedMutes) {
            return send(res, 409, deleteAccountPage(account!, csrf, before,
              'Review or retain the remaining release candidates before deleting data.'))
          }
          let standing = privacy.requestDeletion(did, mode)
          if (standing.activeJobs) return send(res, 409, deleteAccountPage(account!, csrf, standing,
            'An action is still finishing. No new actions will start; return after its outcome is recorded.'))
          try { await (await service.accounts.restore(did)).disconnect() } catch {}
          db.sql.prepare('DELETE FROM oauth_sessions WHERE did=?').run(did)
          try { privacy.completeDeletion(did) } catch (error) {
            standing = privacy.standing(did)
            return send(res, 409, deleteAccountPage(account!, csrf, standing, safeError(error)))
          }
          res.setHeader('Set-Cookie', [cookie('acl_session', '', config, 'HttpOnly; Max-Age=0'), cookie('acl_csrf', '', config, 'Max-Age=0')])
          return send(res, 200, deletedAccountPage())
        }
      }
      if (req.method === 'GET' && url.pathname === '/oauth/callback') {
        const result = await auth.callback(url.searchParams)
        const callbackDid = result.session.did
        let admission
        try {
          admissions.markCallbackReceived(result.state ?? '')
          admission = admissions.complete(result.state, callbackDid)
        } catch (error) {
          try { await (await service.accounts.restore(callbackDid)).disconnect() } catch {}
          db.sql.prepare('DELETE FROM oauth_sessions WHERE did=?').run(callbackDid)
          throw error
        }
        const client = await service.accounts.restore(callbackDid)
        const profile = await client.profile()
        if (profile.did !== callbackDid) throw new Error('OAuth subject did not match the account profile')
        db.upsertUser(profile)
        // Reconnection restores read access only. Paused or interrupted writes
        // require an explicit operator resume and a still-current approval.
        const created = db.createSession(callbackDid)
        db.audit(callbackDid, 'signed_in', { admission: admission.source, writes_enabled: admission.writesEnabled })
        res.setHeader('Set-Cookie', [
          cookie('acl_session', created.token, config, 'HttpOnly; Max-Age=43200'),
          cookie('acl_csrf', created.csrf, config, 'Max-Age=43200'),
          cookie('acl_login', '', config, 'HttpOnly; Max-Age=0'),
        ])
        return redirect(res, '/app')
      }
      if (!session || !account) return redirect(res, '/')
      if (privacy.deletionRequested(did)) return send(res, 409, deleteAccountPage(account, csrf, privacy.standing(did), 'Account deletion is pending.'))
      if (req.method === 'GET' && url.pathname === '/app') {
        let exceptions: Record<string, unknown>[] = []
        let exceptionsAvailable = true
        try {
          const authoritative = await service.engine.overrides(did)
          const cached = db.sql.prepare('SELECT subject,kind,handle FROM account_exceptions WHERE did=?').all(did) as Record<string, unknown>[]
          const handles = new Map(cached.map(item => [`${item.subject}\u0000${item.kind}`, String(item.handle ?? '')]))
          exceptions = Object.entries(authoritative).flatMap(([kind, subjects]) => subjects.map(subject => ({
            subject, kind, handle: handles.get(`${subject}\u0000${kind}`) ?? '',
          }))).sort((a, b) => String(a.subject).localeCompare(String(b.subject)))
        } catch { exceptionsAvailable = false }
        return send(res, 200, dashboard(account, csrf, service.listPolicies(did), service.listJobs(did), service.listYieldReports(did), exceptions, exceptionsAvailable))
      }
      if (req.method === 'GET' && url.pathname === '/account/delete') {
        return send(res, 200, deleteAccountPage(account, csrf, privacy.standing(did)))
      }
      const yieldMatch = url.pathname.match(/^\/diagnostics\/yield\/([^/]+)$/)
      if (req.method === 'GET' && yieldMatch) {
        const row = service.owned<{ report: string }>('yield_reports', yieldMatch[1]!, did)
        return send(res, 200, yieldReportPage(account, csrf, JSON.parse(row.report), url.searchParams.get('q') ?? ''))
      }
      if (req.method === 'GET' && url.pathname === '/policies/new') {
        const useExample = url.searchParams.get('example') === 'poasters'
        const useBsky38 = url.searchParams.get('example') === 'bsky38'
        return send(res, 200, policyEditor(account, csrf, {
          name: useBsky38 ? 'Bsky38 quiet mode' : useExample ? 'Poasters Quarantine' : 'My feed policy',
          body: useBsky38 ? bsky38Policy(account.did) : poastersPolicy(account.did),
        }))
      }
      const policyMatch = url.pathname.match(/^\/policies\/([^/]+)$/)
      if (req.method === 'GET' && policyMatch) {
        const policy = service.owned<Record<string, unknown>>('policies', policyMatch[1]!, did)
        return send(res, 200, policyEditor(account, csrf, {
          id: String(policy.id), name: String(policy.name), body: String(policy.body), revision: Number(policy.revision),
        }))
      }
      const resultMatch = url.pathname.match(/^\/previews\/([^/]+)$/)
      if (req.method === 'GET' && resultMatch) {
        const row = service.owned<Record<string, unknown>>('previews', resultMatch[1]!, did)
        return send(res, 200, previewPage(account, csrf, String(row.id), asJson<Receipt>(row, 'receipt'), url.searchParams.get('q') ?? ''))
      }
      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/)
      if (req.method === 'GET' && jobMatch) {
        const { job, items } = service.jobDetails(did, jobMatch[1]!)
        return send(res, 200, jobPage(account, csrf, job, items))
      }
      return send(res, 404, page('Not found', '<section class="title"><div><h1>Page not found</h1><p><a href="/">Back to sign in</a></p></div></section>'))
    } catch (error) {
      db.audit(did || null, 'request_refused', {
        path: url.pathname,
        reason: url.pathname === '/oauth/callback' ? oauthFailureCategory(error) : safeError(error),
      })
      if (error instanceof Error && error.message === 'resource not found') {
        return send(res, 404, page('Not found', '<section class="title"><div><h1>Page not found</h1><p>That page has gone, or it never existed.</p><p><a class="button" href="/app">Back to dashboard</a></p></div></section>', account, csrf))
      }
      const status = error instanceof CapacityError ? 429 : 400
      if (error instanceof CapacityError) res.setHeader('Retry-After', String(error.retryAfterSeconds))
      const message = url.pathname === '/oauth/callback'
        ? 'Sign-in didn’t go through. Head back and try again.'
        : error instanceof CapacityError ? 'A lot of people are using the beta right now. Nothing was changed — try again in a few minutes.'
        : safeError(error)
      return send(res, status, page('Something went wrong', `<section class="title"><div><h1>${error instanceof CapacityError ? 'Too busy right now' : 'That didn’t work'}</h1><p>${h(message)}</p><p><a class="button" href="${session ? '/app' : '/'}">Go back</a></p></div></section>`, account, csrf))
    }
  })
  server.on('close', () => privacy.close())
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig()
  const db = new AppDb(join(config.dataDir, 'app.db'))
  const oauth = await OAuthAccounts.create(config, db)
  const auth = Object.assign(oauth, { metadata: oauth.oauth.clientMetadata, jwks: oauth.oauth.jwks }) as Auth
  const controls = new ServiceControls(db, config)
  const service = new AclService(db, new Engine(config), oauth, undefined, undefined, controls)
  const server = await createApp(config, db, service, auth)
  const worker = new Worker(db, service, undefined, controls)
  if (config.workerEnabled) worker.loop().catch(() => process.exitCode = 1)
  server.listen(config.port, '127.0.0.1')
  const stop = () => { worker.stop(); server.close(() => db.close()) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
