import type { Receipt, ReceiptRow } from './types.js'
import { CORNELL_LABELS, readGuidedPolicy, type GuidedPolicy } from './policy-editor.js'

export const h = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!))

export function profileUrl(did: string) {
  return /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(did) ? `https://bsky.app/profile/${did}` : ''
}

export function sampledPostUrl(uri: string) {
  const match = uri.match(/^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]+)$/)
  return match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : ''
}

export function safeAvatarUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'https:' && url.hostname === 'cdn.bsky.app' && url.pathname.startsWith('/img/avatar/')
      ? url.toString() : ''
  } catch { return '' }
}

export function exposureDetails(exposures: Array<Record<string, unknown>>) {
  const unique = [...new Map(exposures.map(item => [String(item.post_uri ?? ''), item])).values()]
    .filter(item => sampledPostUrl(String(item.post_uri ?? '')))
  if (!unique.length) return ''
  const list = unique.map(item => {
    const surface = item.surface === 'generator' ? 'Discover' : 'Timeline'
    const mechanism = item.mechanism === 'quote' ? 'quoted post' : item.mechanism === 'repost' ? 'repost' : 'post'
    return `<li><a href="${h(sampledPostUrl(String(item.post_uri)))}" target="_blank" rel="noopener noreferrer">View sampled ${h(mechanism)}</a> <span class="muted">from ${h(surface)}</span></li>`
  }).join('')
  if (unique.length === 1) return `<p class="exposure-links">${list.replace(/^<li>|<\/li>$/g, '')}</p>`
  return `<details class="exposure-links"><summary>Seen ${unique.length} times · view sampled posts</summary><ul>${list}</ul></details>`
}

export function page(title: string, body: string, account?: { handle: string; did: string }, csrf = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · atproto-acl</title>
<meta name="description" content="Preview account activity rules, review the exact effects, and apply only what you approve.">
<link rel="canonical" href="https://atproto-acl.neutral.zone/">
<meta property="og:type" content="website"><meta property="og:site_name" content="atproto-acl">
<meta property="og:title" content="atproto-acl · Personal feed policy">
<meta property="og:description" content="Publishers observe. You decide. Adapters enforce.">
<meta property="og:url" content="https://atproto-acl.neutral.zone/">
<meta property="og:image" content="https://atproto-acl.neutral.zone/social-card.png">
<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1730"><meta property="og:image:height" content="909">
<meta property="og:image:alt" content="atproto-acl: Publishers observe. You decide. Adapters enforce.">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="atproto-acl · Personal feed policy">
<meta name="twitter:description" content="Publishers observe. You decide. Adapters enforce.">
<meta name="twitter:image" content="https://atproto-acl.neutral.zone/social-card.png">
<meta name="twitter:image:alt" content="atproto-acl: Publishers observe. You decide. Adapters enforce.">
<link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body><a class="skip" href="#content">Skip to content</a>
<header><a class="brand" href="/app">atproto-acl</a>
${account ? `<div class="identity"><strong>@${h(account.handle)}</strong></div>
<form method="post" action="/disconnect"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Disconnect</button></form>` : ''}
</header><main id="content" tabindex="-1">${body}</main>
<footer>Publishers observe. You decide. Adapters enforce. · <a href="/help">Help</a> · <a href="/privacy">Privacy</a></footer></body></html>`
}

export function helpPage(account?: { handle: string; did: string }, csrf = '') {
  return page('Help', `<nav><a href="${account ? '/app' : '/'}">← ${account ? 'Dashboard' : 'Sign in'}</a></nav>
<section class="title"><div><p class="eyebrow">Help</p><h1>How previews and changes work</h1></div></section>
<section class="help"><h2>Start with a preview</h2><p>Choose where accounts come from and what evidence should match. A maximum limits that source; it does not invent more accounts.</p>
<h2>Review before anything changes</h2><p>A preview is read-only. Select only the proposed accounts you want to change. The app rechecks the exact batch before execution.</p>
<h2>When a source fails</h2><p>Unavailable or incomplete evidence appears as unresolved. It never becomes an empty clearance or permission for a new action. Try a fresh preview later.</p>
<h2>Disconnect</h2><p>Disconnect removes this app’s future account authority and stops remaining work. Your saved policies and history remain, and existing Bluesky mutes stay in place.</p>
<h2>Delete your data</h2><p>Deleting removes your atproto-acl policies, evidence, credentials, and history. It does not silently unmute accounts. Open <a href="/account/delete">Delete my atproto-acl data</a> while signed in to choose what happens.</p>
<h2>Get help</h2><p><a href="https://bsky.app/profile/did:plc:dki5xu3vgyo7ubl7vaw55zzq" target="_blank" rel="noopener noreferrer">Message @neutral.zone on Bluesky</a>. Report security issues through the repository’s private vulnerability reporting channel.</p></section>`, account, csrf)
}

export function privacyPage(account?: { handle: string; did: string }, csrf = '') {
  return page('Privacy', `<nav><a href="${account ? '/app' : '/'}">← ${account ? 'Dashboard' : 'Sign in'}</a></nav>
<section class="title"><div><p class="eyebrow">Privacy</p><h1>What atproto-acl reads and keeps</h1><p>atproto-acl is operated by James Beck and hosted on Linode/Akamai infrastructure.</p></div></section>
<section class="help privacy-notice">
<h2>What the service reads</h2><p>When you ask for a preview, the service reads your ATProto account identity, PDS, configured Timeline or Discover samples, account relationships, moderation state, and observations from the publishers your policy names. Requests go to your ATProto PDS, the Bluesky AppView when a selected feed requires it, and the selected observation publishers.</p>
<h2>What the service stores</h2><p>The service stores your DID, handle, display name, PDS, server-side OAuth credentials and DPoP material, policies and exceptions, saved post URI/CID exposure references, label evidence, observed mute state, previews, approvals, action outcomes, admission records, and operational timestamps. Saved feed evidence contains identifiers and provenance; atproto-acl does not retain sampled post bodies.</p>
<h2>Why it is stored</h2><p>This information is used to build the previews you request, bind approval to an exact account and policy revision, execute only approved actions, reconcile uncertain outcomes, preserve mute-ownership history, recover work after restart, and prevent one user from seeing another user’s records.</p>
<h2>How long it remains</h2><p>Policies, action history, approved-preview evidence, and mute-ownership records remain until you delete your data. Unapproved previews and measurements expire after 30 days. Live data is removed promptly after deletion can safely complete. Ordinary backup copies expire within 30 days.</p>
<h2>Deletion and backups</h2><p>Deleting atproto-acl data does not automatically unmute accounts. You can leave existing Bluesky mutes unchanged, or review releases first and then delete. Pending actions are cancelled or refused before deletion.</p><p>To prevent an older backup from restoring deleted account data, the service keeps a keyed deletion tombstone outside ordinary backups for 31 days. It contains a keyed, non-reversible account identifier plus deletion and expiry times. Every restore reapplies retained tombstones before the service accepts traffic.</p>
<h2>Disconnect is different</h2><p>Disconnect revokes this app’s connection and prevents further execution. It keeps policies, history, approved evidence, and ownership records so you can reconnect later. Existing Bluesky mutes remain.</p>
<h2>Contact</h2><p>For privacy questions or ordinary support, <a href="https://bsky.app/profile/did:plc:dki5xu3vgyo7ubl7vaw55zzq" target="_blank" rel="noopener noreferrer">message @neutral.zone on Bluesky</a>. Security reports should use GitHub private vulnerability reporting after the source repository is public.</p>
${account ? '<p><a class="button danger" href="/account/delete">Delete my atproto-acl data</a></p>' : ''}
</section>`, account, csrf)
}

export function deleteAccountPage(
  account: { handle: string; did: string },
  csrf: string,
  standing: { activeJobs: number; queuedJobs: number; historicallyAttributedMutes: number },
  error = '',
) {
  const attributed = standing.historicallyAttributedMutes
  return page('Delete account data', `<nav><a href="/app">← Dashboard</a></nav>
<section class="title"><div><p class="eyebrow">Account data</p><h1>Delete my atproto-acl data</h1><p>This permanently removes the data atproto-acl keeps for <strong>@${h(account.handle)}</strong>.</p></div></section>
${error ? `<div role="alert" class="notice bad">${h(error)}</div>` : ''}
${standing.activeJobs ? `<div role="status" class="notice"><strong>${h(standing.activeJobs)} action job is still finishing.</strong><p>Deletion has stopped new actions and will remain unavailable until the in-flight outcome has durable standing.</p></div>` : ''}
${standing.queuedJobs ? `<div class="notice"><strong>${h(standing.queuedJobs)} pending job${standing.queuedJobs === 1 ? '' : 's'} will be cancelled.</strong></div>` : ''}
<section class="deletion-choices">
<article class="panel"><h2>Delete data; leave existing Bluesky mutes unchanged</h2><p>Policies, evidence, credentials, jobs, action history, exceptions, and all per-user derived engine state will be deleted. Accounts already muted on Bluesky stay muted.</p>
<form method="post" action="/account/delete"><input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="mode" value="leave_mutes"><label class="confirm"><input type="checkbox" name="confirm" value="delete" required> I understand that existing Bluesky mutes will remain.</label><button class="danger" ${standing.activeJobs ? 'disabled' : ''}>Delete data and leave mutes</button></form></article>
<article class="panel"><h2>Review releases, then delete data</h2><p>${attributed ? `atproto-acl has historical records for ${h(attributed)} mute${attributed === 1 ? '' : 's'} it created. Historical authorship does not prove current ownership, so every release requires a fresh review.` : 'No historically attributed mutes remain to review.'}</p>
${attributed ? '<p>Return to your policies, build a fresh preview, and explicitly approve any releases you want. Come back here when you are ready to delete, or choose to leave the remaining mutes unchanged.</p><p><a class="button" href="/app">Review policies and releases</a></p>' : `<form method="post" action="/account/delete"><input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="mode" value="after_releases"><label class="confirm"><input type="checkbox" name="confirm" value="delete" required> I have finished reviewing releases.</label><button class="danger" ${standing.activeJobs ? 'disabled' : ''}>Delete data after release review</button></form>`}
</article></section>
<p><a href="/app">Cancel and keep my data</a></p>`, account, csrf)
}

export function deletedAccountPage() {
  return page('Data deleted', `<section class="title"><div><p class="eyebrow">Account data</p><h1>Your atproto-acl data was deleted</h1><p>The app can no longer execute account actions. Existing Bluesky mutes were left as they stood.</p><p><a class="button" href="/">Return to sign in</a></p></div></section>`)
}

export function landing(loginToken: string, error = '', admissionMode: 'allowlist' | 'invite' | 'open' = 'allowlist') {
  return page('Sign in', `
<section class="hero"><p class="eyebrow">Personal feed policy</p><h1>Choose what earns your attention.</h1>
<p>Preview account activity rules, review the exact effects, and apply only what you approve.</p></section>
${error ? `<div role="alert" class="notice bad">${h(error)}</div>` : ''}
<section class="panel narrow"><h2>Sign in with your ATProto account</h2>
<form method="post" action="/oauth/start">
<input type="hidden" name="login_token" value="${h(loginToken)}">
${admissionMode === 'invite' ? '<label for="invite_code">Invite code <span class="muted">(required for first sign-in)</span></label><input id="invite_code" name="invite_code" autocomplete="one-time-code">' : ''}
<label for="handle">Handle</label><input id="handle" name="handle" autocomplete="username" placeholder="you.bsky.social" required>
<button>Continue securely</button></form>
<p class="muted">Your browser is redirected to your account provider. This app never asks for an app password.</p></section>`)
}

function guidedSummary(guided: GuidedPolicy) {
  const scope = guided.sourceType === 'feeds' ? 'accounts appearing in your Timeline and Discover feeds' :
    guided.sourceType === 'timeline' ? 'accounts appearing in your recent timeline' :
    guided.sourceType === 'follows' ? 'accounts you follow' :
    guided.sourceType === 'labeled_stream' ? 'accounts found in Cornell’s public label catalog' :
    guided.sourceType === 'external_snapshot' ? 'accounts in the current Bsky38 leaderboard snapshot' :
    `${guided.subjects.length} specific account${guided.subjects.length === 1 ? '' : 's'}`
  const conditions = [
    guided.monthly ? 'averaging more than 20 posts a day this month' : '',
    guided.dailyPair ? 'making both more than 30 posts and more than 30 replies yesterday' : '',
  ].filter(Boolean)
  if (guided.sourceType === 'external_snapshot') return 'Suggest muting accounts included in the current Bsky38 leaderboard snapshot.'
  if (guided.sourceType === 'labeled_stream') return `Scan up to ${guided.limit} public Cornell label records and check the accounts they name. ${
    conditions.length ? `Suggest muting accounts matching ${conditions.join(' or ')}.` : 'No activity conditions selected.'}`
  const bound = guided.sourceType === 'explicit_dids' ? '' : `Check up to ${guided.limit} ${scope}. `
  return `${bound}${guided.sourceType === 'explicit_dids' ? `Check ${scope}. ` : ''}${
    conditions.length ? `Suggest muting accounts Cornell labels as ${conditions.join(' or ')}.` : 'No activity conditions selected.'}`
}

export function dashboard(
  account: { handle: string; did: string; pds?: string; reconnectRequired?: boolean },
  csrf: string,
  policies: Record<string, unknown>[],
  jobs: Record<string, unknown>[],
  yieldReports: Record<string, unknown>[] = [],
) {
  const policyRows = policies.map(p => {
    const guided = readGuidedPolicy(String(p.body))
    const summary = guided.supported ? guidedSummary(guided) : 'Advanced policy. Open it to inspect its sources and rules.'
    let standing = 'Not previewed yet'
    if (p.latest_receipt) {
      const receipt = JSON.parse(String(p.latest_receipt)) as Receipt
      const rows = receipt.rows.filter(row => row.subject !== receipt.account)
      const proposed = rows.filter(row => ['mute', 'follow_review_candidate', 'release_candidate'].includes(row.action)).length
      const unresolved = rows.filter(row => row.desired === 'indeterminate').length
      standing = proposed ? `${proposed} proposed change${proposed === 1 ? '' : 's'} in the last preview` :
        unresolved ? `${unresolved} unresolved result${unresolved === 1 ? '' : 's'} in the last preview` : 'Last preview proposed no changes'
    }
    return `<article class="policy-card"><div class="policy-copy"><p class="eyebrow">Preview only</p><h2>${h(p.name)}</h2>
      <p>${h(summary)}</p><p class="policy-standing">${h(standing)}</p></div>
      <div class="policy-actions"><form method="post" action="/policies/${h(p.id)}/preview"><input type="hidden" name="csrf" value="${h(csrf)}"><button>Preview accounts</button></form>
      <a href="/policies/${h(p.id)}">Edit policy</a>${p.latest_preview_id ? `<a href="/previews/${h(p.latest_preview_id)}">View last preview</a>` : ''}</div></article>`
  }).join('')
  const jobRows = jobs.length ? jobs.map(j => {
    const date = new Date(String(j.created_at)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    const confirmed = Number(j.confirmed ?? 0)
    const needsReview = Number(j.needs_review ?? 0)
    const pending = Number(j.pending ?? 0)
    const effect = j.kind === 'release' ? 'released' : 'muted'
    const summary = pending ? `${pending} waiting · ${confirmed} completed` : `${confirmed} ${effect}${needsReview ? ` · ${needsReview} needs review` : ''}`
    return `<li class="activity-row"><a href="/jobs/${h(j.id)}"><strong>${h(j.policy_name || 'Approved changes')}</strong><span>${h(date)} · ${h(summary)}</span></a>
      <span class="status ${h(j.status)}">${h(String(j.status).replaceAll('_', ' '))}</span></li>`
  }).join('') : '<li class="empty">No action history yet.</li>'
  const workspace = policies.length ? `<section class="policy-list" aria-labelledby="policies-heading"><div class="section-head"><h2 id="policies-heading">Your policies</h2><div class="policy-create"><a href="/policies/new?example=bsky38">Bsky38 quiet mode</a><a href="/policies/new">Create another policy</a></div></div>${policyRows}</section>` : `
<section class="panel onboarding"><p class="eyebrow">Get started</p><h2>Set up your first feed policy</h2>
<ol><li>Choose a policy and the accounts to check.</li><li>Preview what would change.</li><li>Review and approve exact actions.</li></ol>
<div class="actions"><a class="button" href="/policies/new?example=poasters">Configure Poasters Quarantine</a><a href="/policies/new?example=bsky38">Try Bsky38 quiet mode</a></div></section>`
  return page('Policy dashboard', `
<section class="dashboard-intro"><p class="eyebrow">@${h(account.handle)}</p><h1>Your feed policies</h1>
<p>Preview who a policy affects, then review every change before anything happens.</p></section>
${account.reconnectRequired ? `<section class="notice" aria-labelledby="connection-heading"><h2 id="connection-heading">Reconnect before checking Discover</h2><p>Your saved connection predates a permission this feed needs. Timeline still works, but Discover will remain unavailable until you sign in again. Policies, action history, and existing mutes stay in place.</p><form method="post" action="/reconnect"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Reconnect with Discover access</button></form></section>` : ''}
${workspace}
<section class="coverage-check" aria-labelledby="coverage-heading"><div><p class="eyebrow">Read-only account check</p><h2 id="coverage-heading">See how much of your feeds this policy can measure</h2>
<p>Sample your Timeline and Discover feed with the Poasters Quarantine example. This measures account and label coverage and makes no account changes.</p></div>
<div><form method="post" action="/diagnostics/yield"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Measure feed coverage</button></form>
${yieldReports[0] ? (() => { try { const report = JSON.parse(String(yieldReports[0].report)); const label = report.status === 'running' ? 'Measurement in progress' : ['failed','interrupted'].includes(report.status) ? 'Last measurement needs attention' : 'View last measurement'; return `<p><a href="/diagnostics/yield/${h(yieldReports[0].id)}">${h(label)}</a></p>` } catch { return '' } })() : ''}</div></section>
<div class="lower-grid"><section><h2>Action history</h2><ul class="rows compact-rows">${jobRows}</ul></section>
<section><h2>Account exceptions</h2>
<p>Use an account handle or DID. Exempt skips all automation. Allow changes the policy result. Keep muted prevents a release proposal.</p>
<form method="post" action="/overrides"><input type="hidden" name="csrf" value="${h(csrf)}">
<label for="subject">Account handle or DID</label><input id="subject" name="subject" required placeholder="friend.bsky.social">
<label for="kind">Override</label><select id="kind" name="kind"><option value="exempt">Always exempt from automation</option><option value="allow">Always allow by policy</option><option value="keep_muted">Never propose releasing this mute</option></select>
<div class="actions"><button name="enabled" value="1">Add exception</button><button class="quiet" name="enabled" value="0">Remove exception</button></div></form></section></div>
<details class="account-details technical"><summary>Connection, permissions, and account data</summary><p>Connected as @${h(account.handle)}. The app reads configured account sources and moderation state. It changes mutes only after you approve an exact batch.</p><p>Disconnect keeps your saved atproto-acl data. <a href="/account/delete">Delete my atproto-acl data</a> removes it.</p><p class="did">${h(account.did)}</p>${account.pds ? `<p class="did">PDS: ${h(account.pds)}</p>` : ''}</details>
`, account, csrf)
}

export function policyEditor(account: { handle: string; did: string }, csrf: string, value: {
  id?: string; name: string; body: string; revision?: number
}, error = '', guidedDraft?: GuidedPolicy) {
  const guided = guidedDraft ?? readGuidedPolicy(value.body)
  const summary = guidedSummary(guided)
  const bsky38 = guided.sourceType === 'external_snapshot'
  return page(value.id ? 'Edit policy' : 'New policy', `
<nav><a href="/app">← Dashboard</a></nav><section class="title"><div><p class="eyebrow">Policy</p>
<h1>${value.id ? h(value.name) : 'Create a policy'}</h1>
<p>Nothing changes until you review and approve an exact action batch.</p></div></section>
${error ? `<div role="alert" class="notice bad">${h(error)}</div>` : ''}
<form class="panel editor" method="post" action="/policies/save">
<input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="id" value="${h(value.id ?? '')}">
${guided.supported ? `<div class="builder"><section class="editor-step"><div class="step-number">1</div><div class="step-body"><h2>${bsky38 ? 'Leaderboard snapshot' : 'Accounts'}</h2>
<p>Previewing for <strong>@${h(account.handle)}</strong>. Choose where this policy finds accounts; the limit is a ceiling, not a target.</p>
${bsky38 ? `<input type="hidden" id="source_type" name="source_type" value="external_snapshot"><p class="source-choice"><strong>Current Bsky38 leaderboard</strong><br><span class="muted">This separate policy uses a pinned 38-account snapshot. It does not change the scope of Poasters Quarantine.</span></p>` : `<label for="source_type">Account source</label><select id="source_type" name="source_type">
<option value="feeds"${guided.sourceType === 'feeds' ? ' selected' : ''}>Timeline + Discover feeds</option>
<option value="labeled_stream"${guided.sourceType === 'labeled_stream' ? ' selected' : ''}>Accounts in Cornell’s public label catalog</option>
<option value="follows"${guided.sourceType === 'follows' ? ' selected' : ''}>People I follow (cleanup review)</option>
<option value="explicit_dids"${guided.sourceType === 'explicit_dids' ? ' selected' : ''}>Specific accounts</option>
${guided.sourceType === 'timeline' ? '<option value="timeline" selected>Recent timeline only (legacy policy)</option>' : ''}</select>`}
<p id="source-hint" class="muted" aria-live="polite"></p>
<div id="limit-field"><label for="limit">Maximum items to scan</label><input id="limit" name="limit" type="number" min="1" max="5000" required value="${h(guided.limit)}"></div>
<div id="subjects-field"><label for="subjects">Account handles or DIDs</label><textarea class="subjects" id="subjects" name="subjects" placeholder="alice.example&#10;did:plc:…">${h(guided.subjects.join('\n'))}</textarea></div>
</div></section><section class="editor-step"><div class="step-number">2</div><div class="step-body"><h2>Conditions</h2>
<div id="bsky38-condition"><p><strong>Included in the Bsky38 leaderboard snapshot.</strong></p><p class="muted">Ranks and vote counts are retained with each preview. Refreshing creates a new snapshot.</p></div><div id="cornell-conditions"><label for="publisher">Observation publisher</label><select id="publisher" name="publisher"><option value="cornell">Cornell Tech account activity labels</option></select>
<p class="muted">These are publisher-defined categories. The app does not calculate posting counts.</p><p>Suggest a mute when any selected condition matches:</p>
<label class="check"><input type="checkbox" name="monthly" value="1"${guided.monthly ? ' checked' : ''}> <span>${h(CORNELL_LABELS.monthly.title)}</span></label>
<label class="check"><input type="checkbox" name="daily_pair" value="1"${guided.dailyPair ? ' checked' : ''}> <span>Both “${h(CORNELL_LABELS.dailyPosts.title)}” and “${h(CORNELL_LABELS.dailyReplies.title)}”</span></label></div></div></section>
<section class="editor-step"><div class="step-number">3</div><div class="step-body"><h2>Review</h2>
<label for="name">Policy name</label><input id="name" name="name" maxlength="80" required value="${h(value.name)}">
<section class="policy-summary" aria-live="polite"><strong>Your policy</strong><p id="policy-summary">${h(summary)}</p></section>
<div class="actions"><button name="after" value="preview">Save and preview</button><button class="quiet" name="editor" value="guided">Save policy</button></div></div></section></div>` : `<div class="advanced-name"><label for="name">Policy name</label><input id="name" name="name" maxlength="80" required value="${h(value.name)}"></div><div class="notice"><strong>Advanced policy</strong><p>${h(guided.reason)}</p><p>The guided editor is read-only for policy features it cannot represent, so nothing is silently discarded.</p></div>`}
<details class="advanced"${guided.supported ? '' : ' open'}><summary>Advanced · View or edit policy YAML</summary>
<p>YAML uses the same server validator. Invalid drafts remain here for repair and cannot be previewed or executed.</p>
<label for="body">Policy YAML</label><textarea id="body" name="body" spellcheck="false" required>${h(value.body)}</textarea>
<div class="actions"><button name="editor" value="advanced">Validate and save YAML</button></div></details></form>
${value.id ? `<form class="preview-again" method="post" action="/policies/${h(value.id)}/preview">
<input type="hidden" name="csrf" value="${h(csrf)}"><h2>Preview current consequences</h2>
<p>This reads configured sources, verified observations, and your current moderation state. It makes no changes.</p>
<button>Build preview</button></form>` : ''}`, account, csrf)
}

function age(observed: string, evaluated: string) {
  const parsed = Date.parse(observed)
  const evaluatedAt = Date.parse(evaluated)
  if (!Number.isFinite(parsed) || !Number.isFinite(evaluatedAt)) return 'age unavailable'
  const seconds = Math.max(0, Math.floor((evaluatedAt - parsed) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

const reasonText: Record<string, string> = {
  quarantine_rule_matched: 'Matched a mute rule', allow_won: 'An allow rule took precedence',
  explicit_allow_override: 'Allowed by your override', quarantine_evidence_expired: 'The earlier evidence expired',
  quarantine_rule_no_longer_matches: 'A previously matching rule no longer matches',
  no_matching_quarantine_rule: 'No matching label found',
  unresolved_precedence: 'A possible allow rule could change the result',
}

function coverageComplete(row: ReceiptRow, receipt: Receipt) {
  const providerCount = Object.keys((receipt.policy as any)?.providers ?? {}).length
  const checks = (receipt.coverage ?? []).filter(item => item.subject === row.subject)
  return providerCount > 0 && checks.length >= providerCount && checks.every(item => item.complete)
}

function currentState(row: ReceiptRow) {
  if (!row.observed.known) return 'Current mute state unavailable'
  if (row.observed.blocked) return 'Blocked on Bluesky'
  if (row.observed.direct) return 'Directly muted on Bluesky'
  if (row.observed.list) return 'Muted through a Bluesky list'
  if (row.observed.only_reposts || row.observed.only_quotes) return 'Some posts already muted'
  if (row.observed.muted) return 'Muted on Bluesky'
  return 'Not currently muted'
}

function exposureText(row: ReceiptRow, receipt: Receipt) {
  const exposures = (receipt.discovery ?? []).flatMap(item => (item as any).exposures ?? [])
    .filter((item: any) => item.subject_did === row.subject)
    .sort((a: any, b: any) => Number(a.position) - Number(b.position))
  const first = exposures[0] as any
  if (!first) return ''
  const surface = first.surface === 'generator' ? 'Discover' : 'Timeline'
  const by = first.introducer_handle ? ` by @${first.introducer_handle}` : ''
  if (first.mechanism === 'repost') return `Reposted into your ${surface} sample${by}.`
  if (first.mechanism === 'quote') return `Quoted in your ${surface} sample${by}.`
  return `Found in your ${surface} sample.`
}

function resultCategory(row: ReceiptRow) {
  if (row.action === 'mute' || row.action === 'release_candidate') return 'proposed'
  if (row.action === 'follow_review_candidate') return 'followed'
  if (row.desired === 'indeterminate') return 'unresolved'
  return 'unchanged'
}

function resultRow(row: ReceiptRow, receipt: Receipt, selectable = false) {
  const evidence = receipt.evidence.filter(item => row.evaluation.evidence_ids.includes(String(item.evidence_id)))
  const bsky38Evidence = evidence.find(item => item.provider === 'did:web:bsky38.com' && item.property === 'member')
  const overrides = (row.overrides ?? {}) as Record<string, boolean>
  const handle = row.observed.handle
  const display = row.observed.display_name
  const title = display || (handle ? `@${handle}` : row.subject)
  const outcome = overrides.exempt ? 'Always exempt' : row.action === 'mute' ? 'New mute proposed' :
    row.action === 'follow_review_candidate' ? 'Followed account matched — review separately' :
    row.action === 'release_candidate' ? 'Unmute available for review' : row.desired === 'indeterminate' ? 'Couldn’t decide safely' :
    row.observed.muted ? 'Already muted; preserved' : 'No change proposed'
  const why = bsky38Evidence ? 'Included in the Bsky38 leaderboard snapshot.' : !coverageComplete(row, receipt) && row.desired === 'indeterminate'
    ? 'We couldn’t obtain usable evidence from every required source.'
    : (row.evaluation.reason_codes ?? []).map(code => reasonText[code] ?? code.replaceAll('_', ' ')).join('. ') || 'No matching rule'
  const evidenceLines = evidence.map(item => {
    if (item.provider === 'did:web:bsky38.com' && item.property === 'member') {
      try {
        const snapshot = JSON.parse(String(item.raw_json)) as { rank: number; voteCount: number }
        return `Bsky38 rank #${snapshot.rank} · ${snapshot.voteCount.toLocaleString('en-US')} votes · snapshot ${age(item.observed_at, receipt.evaluated_at)} old`
      } catch { return `Bsky38 leaderboard membership · snapshot ${age(item.observed_at, receipt.evaluated_at)} old` }
    }
    const known = Object.values(CORNELL_LABELS).find(label => label.value === item.property)?.title ?? item.property ?? 'Publisher observation'
    const expired = item.expires_at && Date.parse(item.expires_at) <= Date.parse(receipt.evaluated_at)
    return `${known} · ${age(item.observed_at, receipt.evaluated_at)} old${expired ? ' · expired' : ''}`
  })
  const found = exposureText(row, receipt)
  const exposures = (receipt.discovery ?? []).flatMap(item => (item as any).exposures ?? [])
    .filter((item: any) => item.subject_did === row.subject)
  const profile = profileUrl(row.subject)
  const avatar = safeAvatarUrl(row.observed.avatar)
  return `<article class="result" data-result-category="${resultCategory(row)}">
  <div class="select">${selectable ? `<input aria-label="Select ${h(row.subject)}" type="checkbox" name="subject" value="${h(row.subject)}">` : ''}</div>
  <div><div class="account-heading">${avatar ? `<img class="avatar" src="${h(avatar)}" alt="">` : '<span class="avatar avatar-placeholder" aria-hidden="true"></span>'}<div><h3>${profile ? `<a href="${h(profile)}" target="_blank" rel="noopener noreferrer">${h(title)}</a>` : h(title)}</h3>${handle && display ? `<p class="handle">${profile ? `<a href="${h(profile)}" target="_blank" rel="noopener noreferrer">@${h(handle)}</a>` : `@${h(handle)}`}</p>` : ''}${profile ? `<p class="profile-link"><a href="${h(profile)}" target="_blank" rel="noopener noreferrer">View profile</a></p>` : ''}</div></div><p><strong>${h(outcome)}</strong> · ${h(why)}</p>
  <dl><div><dt>Current Bluesky state</dt><dd>${h(currentState(row))}</dd></div>
  ${found ? `<div><dt>Found</dt><dd>${h(found)}</dd></div>` : ''}
  <div><dt>Evidence</dt><dd>${evidenceLines.length ? evidenceLines.map(h).join('<br>') : coverageComplete(row, receipt) ? 'No matching evidence found' : 'Required evidence unavailable'}</dd></div></dl>
  ${exposureDetails(exposures)}
  ${row.evaluation.unresolved.length ? `<p class="unresolved">Could not resolve: ${h(row.evaluation.unresolved.join(', '))}</p>` : ''}
  <details class="technical"><summary>Technical decision details</summary><p class="did">${h(row.subject)}</p><pre>${h(JSON.stringify({
    matches: row.evaluation.matches, unresolved: row.evaluation.unresolved,
    observed: row.observed, fingerprint: row.fingerprint,
  }, null, 2))}</pre></details></div></article>`
}

export function previewPage(account: { handle: string; did: string }, csrf: string, previewId: string, receipt: Receipt, query = '') {
  const rows = receipt.rows.filter(row => row.subject !== receipt.account)
  const searchable = (row: ReceiptRow) => [row.subject, row.observed.handle, row.observed.display_name, row.reason,
    row.action, row.desired, row.observed.relationship, ...row.evaluation.matches, ...row.evaluation.unresolved].join(' ').toLowerCase()
  const filtered = rows.filter(row => !query || searchable(row).includes(query.toLowerCase()))
  const mutes = filtered.filter(row => row.action === 'mute')
  const followed = filtered.filter(row => row.action === 'follow_review_candidate')
  const releases = filtered.filter(row => row.action === 'release_candidate')
  const unchanged = filtered.filter(row => !['mute', 'follow_review_candidate', 'release_candidate'].includes(row.action))
  const unresolvedRows = filtered.filter(row => row.desired === 'indeterminate')
  const resolvedUnchanged = unchanged.filter(row => row.desired !== 'indeterminate')
  const unresolved = unresolvedRows.length
  const discoveryRows = receipt.discovery ?? []
  const discoveredSubjects = discoveryRows.flatMap(item => {
    const record = item as any
    return [...(record.subjects ?? []), ...(record.exposures ?? []).map((entry: any) => typeof entry === 'string' ? entry : entry.subject_did ?? entry.subject)]
  }).filter(Boolean)
  const discovered = new Set(discoveredSubjects).size
  const discovery = discoveryRows[0]
  const feedScope = discoveryRows.some(item => (item as any).source === 'feed_exposure' || (item as any).type === 'feed_exposure')
  const scopeHeading = discovery?.source === 'follows' ? `Checked the ${discovered} account${discovered === 1 ? '' : 's'} @${account.handle} follows` :
    feedScope ? `Checked ${discovered} account${discovered === 1 ? '' : 's'} from @${account.handle}’s Timeline and Discover feeds` :
    discovery?.source === 'timeline' ? `Checked ${discovered} account${discovered === 1 ? '' : 's'} from @${account.handle}’s recent timeline` :
    discovery?.source === 'labeled_stream' ? `Checked ${discovered} account${discovered === 1 ? '' : 's'} from Cornell’s label catalog` :
    discovery?.source === 'external_snapshot' ? `Checked the current ${discovered}-account Bsky38 snapshot` :
    `Checked ${discovered} specific account${discovered === 1 ? '' : 's'}`
  const usable = rows.filter(row => coverageComplete(row, receipt)).length
  const summaryParts = [
    mutes.length ? `${mutes.length} new mute${mutes.length === 1 ? '' : 's'} proposed.` : '',
    followed.length ? `${followed.length} followed account${followed.length === 1 ? ' needs' : 's need'} separate review.` : '',
    releases.length ? `${releases.length} account${releases.length === 1 ? '' : 's'} available for separate release review.` : '',
  ].filter(Boolean)
  const summary = summaryParts.join(' ') || 'No changes proposed.'
  const incomplete = receipt.completeness ?? {}
  const sourceNote = discovery?.source === 'external_snapshot' && discovery.retrieved_at
    ? `<p class="muted">Leaderboard snapshot retrieved ${h(new Date(discovery.retrieved_at).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC from <a href="https://bsky38.com/" target="_blank" rel="noreferrer">Bsky38</a>. Membership can change between previews.</p>`
    : feedScope ? '<p class="muted">Timeline is the server’s recent getTimeline result and may differ from every surface Bluesky presents as Home. Found in a sample does not prove you personally saw a post.</p>' : ''
  const feedStanding = feedScope ? `<section class="source-standing" aria-label="Feed source standing"><p><strong>Snapshot from ${h(new Date(receipt.evaluated_at).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC.</strong> Run a new preview when you want current results.</p><ul>${discoveryRows.filter(item => (item as any).source === 'feed_exposure').map(item => {
    const source = item as any
    const name = source.surface === 'generator' ? 'Discover' : 'Timeline'
    const items = Number(source.items_sampled ?? source.items?.length ?? 0)
    return `<li><strong>${h(name)}:</strong> ${source.complete ? `${h(String(items))} feed items sampled` : h(source.reason || 'source unavailable')}</li>`
  }).join('')}</ul></section>` : ''
  const incompleteText = [
    incomplete.discovery === false ? 'The account scan stopped before reaching the end.' : '',
    incomplete.evidence === false ? 'Some evidence-source checks were unavailable.' : '',
    incomplete.evaluation === false ? 'Some policy results could not be decided safely.' : '',
    incomplete.remote_state === false ? 'Some current mute states could not be checked.' : '',
    incomplete.relationship === false ? 'Some follow relationships could not be established.' : '',
  ].filter(Boolean)
  const actionForm = (kind: 'apply' | 'apply_followed' | 'release', actionRows: ReceiptRow[], group = 'proposed') => actionRows.length ? `<form class="result-group" data-result-group="${group}" method="post" action="/previews/${h(previewId)}/approve">
<input type="hidden" name="csrf" value="${h(csrf)}"><div class="selection-tools"><button type="button" class="quiet" data-select="all">Select all ${h(group === 'followed' ? 'followed matches' : group === 'proposed' ? 'proposed changes' : 'releases')}</button><button type="button" class="quiet" data-select="none">Select none</button></div><section class="results">${actionRows.map(row => resultRow(row, receipt, true)).join('')}</section>
<nav class="result-pages" aria-label="${group} result pages"></nav>
<div class="approval"><div><strong>${kind === 'apply_followed' ? `Review ${actionRows.length} followed-account match${actionRows.length === 1 ? '' : 'es'}` : `Review ${actionRows.length} proposed ${kind === 'release' ? `release${actionRows.length === 1 ? '' : 's'}` : `mute${actionRows.length === 1 ? '' : 's'}`}`}</strong><p>Select only accounts you intend to change; leave anyone you enjoy unchecked. The exact batch is rechecked before execution.</p></div>
<button${kind === 'release' ? ' class="danger"' : ''} name="kind" value="${kind}">Approve selected ${kind === 'release' ? 'releases' : kind === 'apply_followed' ? 'followed-account mutes' : 'mutes'}</button></div></form>` : ''
  const followedReview = followed.length ? `<details class="followed-review result-group" data-result-group="followed"><summary><span>Followed accounts that matched</span><strong>${followed.length}</strong></summary>
<div class="notice"><strong>Review these separately</strong><p>You already chose to follow these accounts. A match is shown for context and is never folded into the ordinary mute batch.</p></div>
${actionForm('apply_followed', followed, 'followed')}</details>` : ''
  const defaultView = query ? 'all' : 'proposed'
  const filterButton = (value: string, label: string, count: number) => `<button type="button" class="result-filter${defaultView === value ? ' active' : ''}" data-result-filter="${value}" aria-pressed="${defaultView === value}">${h(label)} <span>${count}</span></button>`
  const filters = `<div class="result-filters" role="group" aria-label="Filter preview results" data-default-filter="${defaultView}">
${filterButton('proposed', 'Proposed changes', mutes.length + releases.length)}
${filterButton('followed', 'Followed review', followed.length)}
${filterButton('unchanged', 'No change', resolvedUnchanged.length)}
${filterButton('unresolved', 'Unresolved', unresolvedRows.length)}
${filterButton('all', 'All results', filtered.length)}</div>`
  return page('Preview', `
<nav><a href="/app">← Dashboard</a></nav><section class="title"><div><p class="eyebrow">Read-only preview</p>
<h1>${h(scopeHeading)}</h1><p>${h(summary)} ${unresolved ? `${unresolved} result${unresolved === 1 ? '' : 's'} need more evidence.` : ''}</p></div>
<span class="status ${receipt.complete ? 'completed' : 'needs_review'}">${receipt.complete ? 'complete' : 'partial'}</span></section>
<div class="metrics"><div><strong>${discovered}</strong><span>unique accounts discovered</span></div><div><strong>${rows.length}</strong><span>accounts checked</span></div><div><strong>${usable}</strong><span>with usable policy evidence</span></div><div><strong>${mutes.length + followed.length + releases.length}</strong><span>changes proposed</span></div></div>
${sourceNote}
${feedStanding}
<p class="muted">Your own account is checked separately and is always exempt from automation.</p>
${incompleteText.length ? `<div role="status" class="notice">${h(incompleteText.join(' '))} Uncertainty never authorizes a new action.</div>` : ''}
<form method="get"><label for="q">Search results</label><div class="search"><input id="q" name="q" value="${h(query)}"><button class="quiet">Search</button></div></form>
${filters}
<div class="filter-empty" role="status" hidden>No accounts in this view.</div>
${actionForm('apply', mutes)}${followedReview}${actionForm('release', releases)}
${resolvedUnchanged.length ? `<section class="result-group" data-result-group="unchanged"><div class="results">${resolvedUnchanged.map(row => resultRow(row, receipt)).join('')}</div><nav class="result-pages" aria-label="No-change result pages"></nav></section>` : ''}
${unresolvedRows.length ? `<section class="result-group" data-result-group="unresolved"><div class="results">${unresolvedRows.map(row => resultRow(row, receipt)).join('')}</div><nav class="result-pages" aria-label="Unresolved result pages"></nav></section>` : ''}
${!filtered.length ? '<p class="empty">No accounts match this search.</p>' : ''}
${!mutes.length && !followed.length && !releases.length ? '<section class="panel no-actions"><h2>No changes to approve</h2><p>This preview is read-only. Adjust the policy or return after its evidence sources change.</p></section>' : ''}
<details class="technical receipt"><summary>Preview receipt details</summary><pre>${h(JSON.stringify({ id: receipt.id, evaluated_at: receipt.evaluated_at, complete: receipt.complete, policy_hash: receipt.policy_hash, effective_config_hash: receipt.effective_config_hash }, null, 2))}</pre></details>
`, account, csrf)
}

export function jobPage(account: { handle: string; did: string }, csrf: string, job: Record<string, unknown>, items: Record<string, unknown>[]) {
  const processed = items.filter(item => !['pending', 'attempting'].includes(String(item.status))).length
  const confirmed = items.filter(item => item.status === 'confirmed').length
  const uncertain = items.filter(item => item.status === 'uncertain').length
  const failed = items.filter(item => String(item.status).startsWith('failed')).length
  const skipped = items.filter(item => String(item.status).startsWith('skipped')).length
  const pending = items.filter(item => ['pending', 'attempting'].includes(String(item.status))).length
  const needsReview = uncertain + failed
  const running = job.status === 'running'
  const queued = job.status === 'queued'
  const resumableReview = job.status === 'needs_review' && pending > 0
  const release = job.approval_kind === 'release'
  const effect = release ? 'released' : 'muted'
  const title = running ? `Applying ${items.length} change${items.length === 1 ? '' : 's'}` :
    queued ? `${items.length} change${items.length === 1 ? '' : 's'} queued` :
    `${confirmed} account${confirmed === 1 ? '' : 's'} ${effect}${needsReview ? ` · ${needsReview} ${needsReview === 1 ? 'needs' : 'need'} review` : ''}`
  const formatTime = (value: unknown) => value ? `${new Date(String(value)).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  })} UTC` : ''
  const updatedAt = formatTime(job.updated_at)
  const approvedAt = formatTime(job.approved_at)
  const statusText: Record<string, string> = {
    pending: 'Waiting', attempting: 'Applying now', confirmed: release ? 'Released' : 'Muted', uncertain: 'Couldn’t confirm',
    failed: 'Failed', failed_permanent: 'Failed', skipped_cancelled: 'Skipped after cancellation', skipped_stale: 'Skipped after recheck',
  }
  const uncertaintyText: Record<string, string> = {
    readback_mismatch: 'The service could not confirm the result after the write. It will not repeat the action automatically.',
    worker_interrupted: 'The worker stopped after this action began. It will not repeat the action automatically.',
    current_state_matches_ownership_uncertain: `The account is currently ${release ? 'not muted' : 'muted'}, but that does not prove this tool owns the current state.`,
    current_state_does_not_match: `The account is currently ${release ? 'muted' : 'not muted'}. The earlier uncertain action was not repeated.`,
    current_state_unavailable: 'The current account state could not be read. Ownership remains uncertain.',
  }
  return page('Action results', `<nav><a href="/app">← Dashboard</a></nav>
<section class="title job-title"><div><p class="eyebrow">${h(job.policy_name || 'Approved changes')}</p><h1>${h(title)}</h1>
<p>${running || queued ? 'Progress continues if you return to the dashboard.' : 'Review the result of each approved account change.'}</p>${updatedAt ? `<p class="last-updated">Last updated ${h(updatedAt)}</p>` : ''}
<div class="job-actions"><a class="button" href="/app">Back to dashboard</a><a href="#outcomes">Review results</a></div></div>
<span class="status job-standing ${h(job.status)}">${h(String(job.status).replaceAll('_', ' '))}</span></section>
${job.approved_at || job.preview_id ? `<section class="job-context">${approvedAt ? `<span>Approved ${h(approvedAt)}</span>` : ''}${job.preview_id ? `<a href="/previews/${h(job.preview_id)}">View approved selection</a>` : ''}</section>` : ''}
${job.error_code ? `<div role="status" class="notice">${job.status === 'needs_review' ? 'At least one account change could not be confirmed. Uncertain actions are never repeated automatically.' : `Standing: ${h(String(job.error_code).replaceAll('_', ' '))}`}</div>` : ''}
<section class="job-progress" aria-label="Execution progress"><div><strong>${processed} of ${items.length}</strong><span>processed</span></div><progress max="${items.length || 1}" value="${processed}">${processed} of ${items.length}</progress>
<p>${confirmed} ${effect}${uncertain ? ` · ${uncertain} couldn’t confirm` : ''}${failed ? ` · ${failed} failed` : ''}${skipped ? ` · ${skipped} skipped` : ''}${pending ? ` · ${pending} waiting` : ''}</p></section>
<section class="panel" id="outcomes"><h2>Account results</h2><ul class="outcomes">${items.map((item, index) => {
  const display = item.display_name ? String(item.display_name) : ''
  const handle = item.handle ? `@${String(item.handle).replace(/^@/, '')}` : ''
  const label = display || handle || `Account ${index + 1}`
  const action = item.action === 'unmute' ? 'Remove private mute' : 'Add private mute'
  const profile = profileUrl(String(item.subject))
  const avatar = safeAvatarUrl(item.avatar)
  const error = item.error_code ? uncertaintyText[String(item.error_code)] ?? String(item.error_code).replaceAll('_', ' ') : ''
  return `<li><div class="outcome-account"><div class="account-heading">${avatar ? `<img class="avatar small" src="${h(avatar)}" alt="">` : ''}<div><strong>${profile ? `<a href="${h(profile)}" target="_blank" rel="noopener noreferrer">${h(label)}</a>` : h(label)}</strong>${display && handle ? `<span>${h(handle)}</span>` : ''}${profile ? `<a class="profile-link" href="${h(profile)}" target="_blank" rel="noopener noreferrer">View profile</a>` : ''}</div></div><span>${h(action)}</span>${exposureDetails((item.exposures as Array<Record<string, unknown>>) ?? [])}</div>
<span class="status ${h(item.status)}">${h(statusText[String(item.status)] ?? String(item.status).replaceAll('_', ' '))}</span>
${error ? `<small>${h(error)}</small>` : ''}
${item.status === 'uncertain' ? `<form class="recheck" method="post" action="/jobs/${h(job.id)}/recheck/${h(encodeURIComponent(String(item.subject)))}"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Check state again</button><span class="muted">Read-only; this will not repeat the action.</span></form>` : ''}
<details class="technical outcome-technical"><summary>Technical details</summary><p class="did">${h(item.subject)}</p><p>Updated ${h(item.updated_at)}</p></details></li>`
}).join('')}</ul></section>
${['queued','running'].includes(String(job.status)) ? `<form method="post" action="/jobs/${h(job.id)}/cancel">
<input type="hidden" name="csrf" value="${h(csrf)}"><button class="danger">Cancel remaining actions</button>
<p class="muted">Accounts already changed will stay as they are.</p></form>` : ''}
${running || queued || resumableReview ? `<span id="job-refresh" data-auto-refresh="true" class="muted" role="status">Checking for new outcomes…</span>` : ''}
<details class="technical"><summary>Technical job details</summary><p class="did">Job ${h(job.id)}</p></details>`, account, csrf)
}
