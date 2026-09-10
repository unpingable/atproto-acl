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
<meta name="description" content="Find high-volume accounts in your Bluesky feeds, review the results, and choose what to mute.">
<link rel="canonical" href="https://atproto-acl.neutral.zone/">
<meta property="og:type" content="website"><meta property="og:site_name" content="atproto-acl">
<meta property="og:title" content="atproto-acl · Personal feed policy">
<meta property="og:description" content="Find high-volume accounts in your Bluesky feeds, review the results, and choose what to mute.">
<meta property="og:url" content="https://atproto-acl.neutral.zone/">
<meta property="og:image" content="https://atproto-acl.neutral.zone/social-card.png">
<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1730"><meta property="og:image:height" content="909">
<meta property="og:image:alt" content="atproto-acl finds high-volume accounts in your Bluesky feeds and lets you choose what to mute.">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="atproto-acl · Personal feed policy">
<meta name="twitter:description" content="Find high-volume accounts in your Bluesky feeds, review the results, and choose what to mute.">
<meta name="twitter:image" content="https://atproto-acl.neutral.zone/social-card.png">
<meta name="twitter:image:alt" content="atproto-acl finds high-volume accounts in your Bluesky feeds and lets you choose what to mute.">
<link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body><a class="skip" href="#content">Skip to content</a>
<header class="nz-masthead"><a class="nz-family" href="${account ? '/app' : '/'}">neutral.zone / instruments</a><a class="brand nz-product" href="${account ? '/app' : '/'}">atproto-acl</a>
<nav><a class="header-link" href="/about">About</a><a class="header-link" href="/help">How it works</a><a class="header-link" href="https://github.com/unpingable/atproto-acl">Source</a></nav>
${account ? `<div class="identity"><strong>@${h(account.handle)}</strong></div>
<form method="post" action="/signout"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Sign out</button></form>` : ''}
</header><main id="content" tabindex="-1">${body}</main>
<footer class="nz-footer"><nav><a href="/about">About</a><a href="https://github.com/unpingable/atproto-acl">Source on GitHub</a><a href="/help">Methodology</a><a href="/privacy">Privacy</a><a href="https://bsky.app/profile/neutral.zone">Contact</a></nav><p>Nothing is muted until you approve it. Operated by The Neutral Ambassador (@neutral.zone); source and project history are published by James Beck on GitHub.</p></footer></body></html>`
}

export function aboutPage(account?: { handle: string; did: string }, csrf = '') {
  return page('About', `<nav><a href="${account ? '/app' : '/'}">← ${account ? 'Dashboard' : 'Sign in'}</a></nav>
<section class="title"><div><p class="eyebrow">About this instrument</p><h1>Your rules for your attention.</h1><p>atproto-acl is a personal moderation-policy tool for Bluesky. It finds accounts matching rules you choose, shows every proposed change, and acts only after explicit approval.</p></div></section>
<section class="panel privacy-notice"><h2>Why it exists</h2><p>Your feed policy should remain understandable, inspectable, and yours—not a hidden setting inside a service.</p>
<h2>What it looks at</h2><p>Only the feeds, account relationships, moderation state, and observation providers named by your saved policy.</p>
<h2>What it does not claim</h2><p>A match is not a judgment about a person or their intent. Incomplete evidence never becomes permission to act, and a scan never changes your account.</p>
<h2>Can I verify or leave?</h2><p>Yes. The <a href="https://github.com/unpingable/atproto-acl">source is public</a>, <a href="/help">the method is documented</a>, and every policy can be downloaded as YAML and used with the standalone CLI.</p>
<h2>Who runs it?</h2><p>Operated by The Neutral Ambassador (<a href="https://bsky.app/profile/neutral.zone">@neutral.zone</a>). Source code and project history are published by James Beck on GitHub. Privacy and legal accountability identify James Beck explicitly.</p></section>`, account, csrf)
}

export function helpPage(account?: { handle: string; did: string }, csrf = '') {
  return page('Help', `<nav><a href="${account ? '/app' : '/'}">← ${account ? 'Dashboard' : 'Sign in'}</a></nav>
<section class="title"><div><p class="eyebrow">Help</p><h1>How this works</h1></div></section>
<section class="help privacy-notice">
<h2>What does this app do?</h2><p>It looks through your Bluesky feed for accounts that post an unusually high volume, shows you the list, and mutes the ones you pick. Muting on Bluesky is private — the other account is never told.</p>
<h2>How does it know who posts a lot?</h2><p>It doesn’t count posts itself. It reads labels published by <strong>Cornell Tech</strong>, a university research group that tracks public posting volume on Bluesky and publishes what it finds. This app looks up those labels and applies the rules you chose.</p>
<h2>Does anything happen automatically?</h2><p>No. A scan only reads; it never changes your account. You get a list, you tick the accounts you want muted, and only those are muted. Accounts you already follow are kept in a separate list so you don’t mute a friend by accident.</p>
<h2>What if a scan can’t tell?</h2><p>Some accounts show up as <strong>unresolved</strong> — a data source was down, or the labels were too old to trust. Unresolved never counts as “fine to mute”. Those accounts are left alone. Run a new scan later.</p>
<h2>Can I undo a mute?</h2><p>Yes. Run a scan again and the app will offer to unmute accounts that no longer match. Unmuting is always a separate list you approve on its own, so nothing gets unmuted behind your back.</p>
<h2>How do I stop an account being touched at all?</h2><p>Add it to <strong>Accounts to leave alone</strong> on your dashboard. It’ll be skipped by every scan from then on.</p>
<h2>Sign out vs. disconnect</h2><p><strong>Sign out</strong> just ends this browser session; sign back in any time. <strong>Disconnect</strong> revokes the app’s access to your Bluesky account so it can’t make any more changes. Either way your policies, history, and existing mutes stay as they are. Disconnect lives under <em>Connection and account data</em> on your dashboard.</p>
<h2>How do I delete everything?</h2><p><a href="/account/delete">Delete my atproto-acl data</a> removes your policies, history, and stored credentials. It does not unmute anyone — if you want accounts unmuted, do that first.</p>
<h2>Something’s wrong</h2><p><a href="https://bsky.app/profile/did:plc:dki5xu3vgyo7ubl7vaw55zzq" target="_blank" rel="noopener noreferrer">Message @neutral.zone on Bluesky</a> for ordinary support. Report security problems through <a href="https://github.com/unpingable/atproto-acl/security/advisories/new" target="_blank" rel="noopener noreferrer">GitHub private vulnerability reporting</a>. If that route is unavailable, message @neutral.zone to arrange another private channel; never send credentials, tokens, or exploit details in a Bluesky message.</p></section>`, account, csrf)
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
<h2>Contact</h2><p>For privacy questions or ordinary support, <a href="https://bsky.app/profile/did:plc:dki5xu3vgyo7ubl7vaw55zzq" target="_blank" rel="noopener noreferrer">message @neutral.zone on Bluesky</a>. Security reports should use <a href="https://github.com/unpingable/atproto-acl/security/advisories/new" target="_blank" rel="noopener noreferrer">GitHub private vulnerability reporting</a>.</p>
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
<section class="title"><div><p class="eyebrow">Account data</p><h1>Delete my atproto-acl data</h1><p>This permanently removes everything this app has stored for <strong>@${h(account.handle)}</strong>. It does not unmute anyone.</p></div></section>
${error ? `<div role="alert" class="notice bad">${h(error)}</div>` : ''}
${standing.activeJobs ? `<div role="status" class="notice"><strong>Still finishing up a change.</strong><p>No new changes will start. Deleting is unavailable for another moment, until the app has recorded what happened. Refresh shortly.</p></div>` : ''}
${standing.queuedJobs ? `<div class="notice"><strong>${h(standing.queuedJobs)} change${standing.queuedJobs === 1 ? '' : 's'} still waiting to run will be cancelled.</strong></div>` : ''}
<section class="deletion-choices">
<article class="panel"><h2>Delete my data, leave my mutes alone</h2><p>Your policies, scan results, saved sign-in, history, and exceptions are deleted. Anyone you already muted on Bluesky stays muted.</p>
<form method="post" action="/account/delete"><input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="mode" value="leave_mutes"><label class="confirm"><input type="checkbox" name="confirm" value="delete" required> I understand that accounts I muted will stay muted.</label><button class="danger" ${standing.activeJobs ? 'disabled' : ''}>Delete my data, keep mutes</button></form></article>
<article class="panel"><h2>Unmute people first, then delete</h2><p>${attributed ? `This app has a record of muting ${h(attributed)} account${attributed === 1 ? '' : 's'} for you. It won\u2019t unmute them for you here \u2014 that\u2019s always a separate thing you approve, in case you changed one of them yourself since.` : 'There\u2019s nobody left to unmute.'}</p>
${attributed ? '<p>Go back, run a scan, and approve the unmutes you want. Then come back here to delete \u2014 or just use the other option and leave everyone muted.</p><p><a class="button" href="/app">Go unmute people first</a></p>' : `<form method="post" action="/account/delete"><input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="mode" value="after_releases"><label class="confirm"><input type="checkbox" name="confirm" value="delete" required> I\u2019m done unmuting people.</label><button class="danger" ${standing.activeJobs ? 'disabled' : ''}>Delete my data</button></form>`}
</article></section>
<p><a href="/app">Cancel and keep my data</a></p>`, account, csrf)
}

export function deletedAccountPage() {
  return page('Data deleted', `<section class="title"><div><p class="eyebrow">Account data</p><h1>Your data has been deleted</h1><p>This app can no longer make any changes to your account. Anyone you had muted is still muted.</p><p><a class="button" href="/">Back to sign in</a></p></div></section>`)
}

export function landing(loginToken: string, error = '', admissionMode: 'allowlist' | 'invite' | 'open' = 'allowlist') {
  return page('Sign in', `
<section class="hero"><p class="eyebrow">For Bluesky</p><h1>Choose what earns your attention.</h1>
<p>Some accounts post often enough to take over your feed. This app finds them and shows you the list, so you can choose what to mute.</p>${admissionMode === 'open' ? '<p class="open-preview"><strong>Open limited beta:</strong> Sign in to measure your feeds and inspect every proposed change. This preview is read-only; moderation actions are not yet generally available.</p>' : ''}</section>
<div class="nz-status-rail"><span><strong>Mode</strong> preview first</span><span><strong>Policy</strong> user-owned</span><span><strong>Actions</strong> explicit approval</span></div>
${error ? `<div role="alert" class="notice bad">${h(error)}</div>` : ''}
<div class="landing-grid">
<section class="panel narrow"><h2>Sign in with Bluesky</h2>
<form method="post" action="/oauth/start">
<input type="hidden" name="login_token" value="${h(loginToken)}">
${admissionMode === 'invite' ? '<label for="invite_code">Invite code <span class="muted">(required for first sign-in)</span></label><input id="invite_code" name="invite_code" autocomplete="one-time-code">' : ''}
<label for="handle">Your handle</label><input id="handle" name="handle" autocomplete="username" placeholder="you.bsky.social" required>
<button>Continue</button></form>
<p class="muted">You sign in on Bluesky’s own page. This app never asks for your password or an app password.</p></section>
<section class="landing-steps"><h2>How it works</h2>
<ol><li><strong>Scan.</strong> The app reads a sample of your Following and Discover feeds and checks who’s posting at very high volume.</li>
<li><strong>Look at the list.</strong> Every account shows why it matched and whether you follow them. Nothing has changed yet.</li>
<li><strong>Tick and mute.</strong> Only accounts you check are attempted. The results show what Bluesky confirmed. Muting is private — they’re never notified.</li></ol>
<p class="muted">Posting-volume data comes from labels published by Cornell Tech, not from this app. <a href="/help">More about how this works</a>.</p></section></div>
<section class="portable-callout"><div><p class="eyebrow">No lock-in</p><h2>Your policy is portable.</h2><p>Download human-readable YAML, import it here, or run it with the standalone CLI. If this service disappears, your intended policy—including account-specific rules—still works locally.</p></div><p><code>WEB UI ↔ ACL.YAML ↔ CLI</code></p></section>`)
}

function guidedSummary(guided: GuidedPolicy) {
  const scope = guided.sourceType === 'feeds' ? 'accounts from your Following and Discover feeds' :
    guided.sourceType === 'timeline' ? 'accounts from your recent Following feed' :
    guided.sourceType === 'follows' ? 'accounts you follow' :
    guided.sourceType === 'labeled_stream' ? 'accounts from Cornell’s public list' :
    guided.sourceType === 'external_snapshot' ? 'accounts in the current Bsky38 leaderboard' :
    `${guided.subjects.length} account${guided.subjects.length === 1 ? '' : 's'} you listed`
  const conditions = [
    guided.monthly ? 'averages more than 20 posts a day this month' : '',
    guided.dailyPair ? 'posted more than 30 times and replied more than 30 times yesterday' : '',
  ].filter(Boolean)
  if (guided.sourceType === 'external_snapshot') return 'Suggests muting the accounts in the current Bsky38 leaderboard.'
  if (guided.sourceType === 'labeled_stream') return `Reads up to ${guided.limit} entries from Cornell’s public list and checks the accounts named there. ${
    conditions.length ? `Suggests muting anyone who ${conditions.join(' or ')}.` : 'No conditions chosen yet.'}`
  const bound = guided.sourceType === 'explicit_dids' ? `Checks the ${scope}. ` : `Checks up to ${guided.limit} ${scope}. `
  return `${bound}${conditions.length ? `Suggests muting anyone who ${conditions.join(' or ')}.` : 'No conditions chosen yet.'}`
}

export function dashboard(
  account: { handle: string; did: string; pds?: string; reconnectRequired?: boolean; writeReconnectRequired?: boolean; writesEnabled?: boolean },
  csrf: string,
  policies: Record<string, unknown>[],
  jobs: Record<string, unknown>[],
  yieldReports: Record<string, unknown>[] = [],
  exceptions: Record<string, unknown>[] = [],
  exceptionsAvailable = true,
) {
  const policyRows = policies.map(p => {
    const guided = readGuidedPolicy(String(p.body))
    const summary = guided.supported ? guidedSummary(guided) : 'A hand-written policy. Open it to see its sources and rules.'
    let standing = 'Not run yet'
    if (p.latest_receipt) {
      const receipt = JSON.parse(String(p.latest_receipt)) as Receipt
      const rows = receipt.rows.filter(row => row.subject !== receipt.account)
      const proposed = rows.filter(row => ['mute', 'follow_review_candidate', 'release_candidate'].includes(row.action)).length
      const unresolved = rows.filter(row => row.desired === 'indeterminate').length
      standing = proposed ? `Last scan found ${proposed} account${proposed === 1 ? '' : 's'} to review` :
        unresolved ? `Last scan couldn’t decide about ${unresolved} account${unresolved === 1 ? '' : 's'}` : 'Last scan found nothing to change'
    }
    return `<article class="policy-card"><div class="policy-copy"><h2>${h(p.name)}</h2>
      <p>${h(summary)}</p><p class="policy-standing">${h(standing)}</p></div>
      <div class="policy-actions"><form method="post" action="/policies/${h(p.id)}/preview"><input type="hidden" name="csrf" value="${h(csrf)}"><button>Scan my feed</button></form>
      <a href="/policies/${h(p.id)}">Edit</a>${p.latest_preview_id ? `<a href="/previews/${h(p.latest_preview_id)}">Last results</a>` : ''}</div></article>`
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
  }).join('') : '<li class="empty">Nothing yet. Approved changes and their outcomes will appear here.</li>'
  const exceptionKinds: Record<string, string> = {
    exempt: 'Never touch this account', allow: 'Always keep in my feed', keep_muted: 'Never offer to unmute',
  }
  const exceptionRows = exceptions.length ? exceptions.map(item => {
    const handle = String(item.handle ?? '')
    const subject = String(item.subject ?? '')
    const profile = profileUrl(subject)
    const label = handle ? `@${handle}` : subject
    return `<li class="exception-row"><div><strong>${profile ? `<a href="${h(profile)}" target="_blank" rel="noopener noreferrer">${h(label)}</a>` : h(label)}</strong>
      <span>${h(exceptionKinds[String(item.kind)] ?? String(item.kind))}</span></div>
      <form method="post" action="/overrides"><input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="subject" value="${h(subject)}">
      <input type="hidden" name="kind" value="${h(item.kind)}"><button class="quiet" name="enabled" value="0">Remove</button></form></li>`
  }).join('') : '<li class="empty">No accounts on this list yet.</li>'
  const workspace = policies.length ? `<section class="policy-list" aria-labelledby="policies-heading"><div class="section-head"><h2 id="policies-heading">Your policies</h2><div class="policy-create"><a href="/policies/import">Import YAML</a><a href="/policies/new?example=bsky38">Add Bsky38 quiet mode</a><a href="/policies/new">Add a policy</a></div></div>${policyRows}</section>` : `
<section class="panel onboarding"><p class="eyebrow">Get started</p><h2>Set up your first scan</h2>
<ol><li>Pick which feeds to look through and what counts as posting too much.</li><li>See the list of accounts that matched, and why.</li><li>Tick the ones you want muted. Nothing else changes.</li></ol>
<div class="actions"><a class="button" href="/policies/new?example=poasters">Set up a scan</a><a href="/policies/import">Import portable YAML</a><a href="/policies/new?example=bsky38">Or try Bsky38 quiet mode</a></div></section>`
  return page('Dashboard', `
<section class="dashboard-intro"><p class="eyebrow">@${h(account.handle)}</p><h1>Your feed policies</h1>
<p>A policy is a saved set of rules for finding noisy accounts. Running one only builds a list — you decide who actually gets muted.</p></section>
${account.writesEnabled === false && !account.writeReconnectRequired ? '<section class="notice preview-only"><strong>Preview access</strong><p>You can measure your feeds and inspect every proposed change. This preview is read-only; moderation actions are not yet generally available.</p></section>' : ''}
${account.writeReconnectRequired ? `<section class="notice" aria-labelledby="moderation-connection-heading"><h2 id="moderation-connection-heading">Reconnect to enable moderation</h2><p>Your account is eligible for moderation actions, but this session has read-only authority. Sign in again to explicitly grant mute and unmute access.</p><form method="post" action="/reconnect"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Grant moderation access</button></form></section>` : ''}
${account.reconnectRequired ? `<section class="notice" aria-labelledby="connection-heading"><h2 id="connection-heading">Sign in again to include Discover</h2><p>Your Following feed works fine, but Discover needs a permission that wasn’t granted when you first signed in. Your policies, history, and existing mutes are unaffected.</p><form method="post" action="/reconnect"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Sign in again</button></form></section>` : ''}
${workspace}
<section class="portable-callout"><div><p class="eyebrow">Built-in escape hatch</p><h2>Your policy is portable.</h2><p>Download YAML, import it again, or use the same file with the standalone <code>atproto-acl</code> CLI. Policy settings and account-specific rules travel together; scan history and service jobs do not.</p></div><a class="button quiet" href="/policies/import">Import YAML</a></section>
<section class="coverage-check" aria-labelledby="coverage-heading"><div><h2 id="coverage-heading">Not sure yet? Take a look first</h2>
<p>Reads a sample of your Following and Discover feeds and shows how many accounts would match, without saving a policy or changing anything on your account.</p></div>
<div><form method="post" action="/diagnostics/yield"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Take a look</button></form>
${yieldReports[0] ? (() => { try { const report = JSON.parse(String(yieldReports[0].report)); const label = report.status === 'running' ? 'Scan in progress' : ['failed','interrupted'].includes(report.status) ? 'Last look didn’t finish' : 'See the last one' ; return `<p><a href="/diagnostics/yield/${h(yieldReports[0].id)}">${h(label)}</a></p>` } catch { return '' } })() : ''}</div></section>
<div class="lower-grid"><section><h2>Recent activity</h2><ul class="rows compact-rows">${jobRows}</ul></section>
<section><h2>Account-specific rules</h2>
<p>Accounts on this list are handled by a fixed rule instead of the scan results.</p>
${exceptionsAvailable ? '' : '<div role="status" class="notice">Account-specific rules could not be loaded. The app has not treated that as an empty list.</div>'}
<ul class="rows exception-list">${exceptionRows}</ul>
<form method="post" action="/overrides"><input type="hidden" name="csrf" value="${h(csrf)}">
<label for="subject">Add an account</label><input id="subject" name="subject" required placeholder="friend.bsky.social">
<label for="kind">What should happen</label><select id="kind" name="kind"><option value="exempt">Never touch this account</option><option value="allow">Always keep in my feed, even if it matches</option><option value="keep_muted">Never offer to unmute this account</option></select>
<div class="actions"><button name="enabled" value="1">Add to list</button></div></form></section></div>
<details class="account-details technical"><summary>Connection and account data</summary><p>Signed in as @${h(account.handle)}. The app reads your chosen feeds and your current mute list. It only changes mutes you have ticked and approved.</p>
<p><strong>Disconnect</strong> revokes this app’s access to your Bluesky account. Your policies, history, and existing mutes stay as they are, and you can sign in again later.</p>
<form method="post" action="/disconnect"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="danger">Disconnect this app</button></form>
<p><a href="/account/delete">Delete my atproto-acl data</a> removes everything this app has stored about you.</p>
<p class="did">${h(account.did)}</p>${account.pds ? `<p class="did">PDS: ${h(account.pds)}</p>` : ''}</details>
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
<h1>${value.id ? h(value.name) : 'Set up a scan'}</h1>
<p>Set the rules here. Running them just builds a list — you tick who actually gets muted.</p>
${value.id ? `<div class="actions"><form method="post" action="/policies/${h(value.id)}/export"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Download portable YAML</button></form><a href="/policies/${h(value.id)}/import">Replace from YAML</a></div>` : ''}</div></section>
${error ? `<div role="alert" class="notice bad">${h(error)}</div>` : ''}
<form class="panel editor" method="post" action="/policies/save">
<input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="id" value="${h(value.id ?? '')}">
${guided.supported ? `<div class="builder"><section class="editor-step"><div class="step-number">1</div><div class="step-body"><h2>${bsky38 ? 'Leaderboard snapshot' : 'Where to look'}</h2>
<p>Scanning as <strong>@${h(account.handle)}</strong>.</p>
${bsky38 ? `<input type="hidden" id="source_type" name="source_type" value="external_snapshot"><p class="source-choice"><strong>Current Bsky38 leaderboard</strong><br><span class="muted">An unauthenticated third-party snapshot of the 38 accounts on the leaderboard at the moment you scan. It doesn’t affect your other policies.</span></p>` : `<label for="source_type">Which accounts to check</label><select id="source_type" name="source_type">
<option value="feeds"${guided.sourceType === 'feeds' ? ' selected' : ''}>Accounts in my Following and Discover feeds</option>
<option value="labeled_stream"${guided.sourceType === 'labeled_stream' ? ' selected' : ''}>Every account on Cornell’s public list</option>
<option value="follows"${guided.sourceType === 'follows' ? ' selected' : ''}>Only accounts I follow</option>
<option value="explicit_dids"${guided.sourceType === 'explicit_dids' ? ' selected' : ''}>Only accounts I name below</option>
${guided.sourceType === 'timeline' ? '<option value="timeline" selected>Following feed only (older setting)</option>' : ''}</select>`}
<p id="source-hint" class="muted" aria-live="polite"></p>
<div id="limit-field"><label for="limit">Stop after this many</label><input id="limit" name="limit" type="number" min="1" max="5000" required value="${h(guided.limit)}">
<p class="muted">A ceiling on how much to read, so a scan stays quick. Fewer is faster.</p></div>
<div id="subjects-field"><label for="subjects">Handles, one per line</label><textarea class="subjects" id="subjects" name="subjects" placeholder="alice.example&#10;did:plc:…">${h(guided.subjects.join('\n'))}</textarea></div>
</div></section><section class="editor-step"><div class="step-number">2</div><div class="step-body"><h2>${bsky38 ? 'What counts as a match' : 'What counts as too much'}</h2>
<div id="bsky38-condition"><p><strong>Being on the Bsky38 leaderboard.</strong></p><p class="muted">Each scan saves the ranks and vote counts it saw. Scanning again takes a fresh snapshot.</p></div><div id="cornell-conditions"><label for="publisher">Where the posting data comes from</label><select id="publisher" name="publisher"><option value="cornell">Cornell Tech account activity labels</option></select>
<p class="muted">Cornell Tech is a university research group that tracks how often public Bluesky accounts post and publishes what it finds. This app reads those published labels; it doesn’t count posts itself.</p><p>Suggest a mute when any of these is true:</p>
<label class="check"><input type="checkbox" name="monthly" value="1"${guided.monthly ? ' checked' : ''}> <span>${h(CORNELL_LABELS.monthly.title)}</span></label>
<label class="check"><input type="checkbox" name="daily_pair" value="1"${guided.dailyPair ? ' checked' : ''}> <span>Both “${h(CORNELL_LABELS.dailyPosts.title)}” and “${h(CORNELL_LABELS.dailyReplies.title)}”</span></label></div></div></section>
<section class="editor-step"><div class="step-number">3</div><div class="step-body"><h2>Name it and check</h2>
<label for="name">Policy name</label><input id="name" name="name" maxlength="80" required value="${h(value.name)}">
<section class="policy-summary" aria-live="polite"><strong>What this will do</strong><p id="policy-summary">${h(summary)}</p></section>
<div class="actions"><button name="after" value="preview">Save and scan now</button><button class="quiet" name="editor" value="guided">Save for later</button></div></div></section></div>` : `<div class="advanced-name"><label for="name">Policy name</label><input id="name" name="name" maxlength="80" required value="${h(value.name)}"></div><div class="notice"><strong>Hand-written policy</strong><p>${h(guided.reason)}</p><p>The simple editor can’t show this one without changing what it does, so edit the YAML below instead.</p></div>`}
<details class="advanced"${guided.supported ? '' : ' open'}><summary>Advanced · View or edit the YAML</summary>
<p>Checked by the same validator as the form above. If it doesn’t validate, your draft stays here so you can fix it, and the scan won’t run.</p>
<label for="body">Policy YAML</label><textarea id="body" name="body" spellcheck="false" required>${h(value.body)}</textarea>
<div class="actions"><button name="editor" value="advanced">Check and save YAML</button></div></details></form>
${value.id ? `<form class="preview-again" method="post" action="/policies/${h(value.id)}/preview">
<input type="hidden" name="csrf" value="${h(csrf)}"><h2>Run this now</h2>
<p>Reads your feeds, the published posting labels, and who you currently have muted. It changes nothing.</p>
<button>Scan my feed</button></form>` : ''}`, account, csrf)
}

export function policyImportPage(account: { handle: string; did: string }, csrf: string,
  target?: { id: string; name: string }, error = '', document = '') {
  return page('Import policy', `<nav><a href="${target ? `/policies/${h(target.id)}` : '/app'}">← Back</a></nav>
<section class="title"><div><p class="eyebrow">Portable policy</p><h1>${target ? `Replace ${h(target.name)}` : 'Import a policy'}</h1>
<p>Paste or choose an atproto-acl YAML file. Nothing is replaced until you inspect the changes and confirm.</p></div></section>
${error ? `<div role="alert" class="notice bad">${h(error)}</div>` : ''}
<form class="panel editor portable-import" method="post" action="/policies/import/validate">
<input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="target" value="${h(target?.id ?? '')}">
${target ? '' : '<label for="import_name">Policy name <span class="muted">(optional)</span></label><input id="import_name" name="name" maxlength="120" placeholder="Name from file">'}
<label for="policy_file">Choose YAML file</label><input id="policy_file" type="file" accept=".yaml,.yml,text/yaml,application/yaml">
<label for="document">Policy YAML</label><textarea id="document" name="document" rows="22" required>${h(document)}</textarea>
<p class="muted">Maximum decoded document size: 512 KiB. The file stays in your browser until you submit it.</p>
<button>Validate and preview changes</button></form>`, account, csrf)
}

export function policyImportReviewPage(account: { handle: string; did: string }, csrf: string,
  draft: Record<string, unknown>) {
  const diff = JSON.parse(String(draft.diff)) as any
  const created = draft.target_policy_id ? 'replace this policy' : 'create a new policy'
  const removedRules = Object.fromEntries(Object.entries(diff.account_rule_changes as Record<string, any>)
    .filter(([, change]) => change.removed.length).map(([kind, change]) => [kind, change.removed]))
  return page('Review policy import', `<nav><a href="${draft.target_policy_id ? `/policies/${h(draft.target_policy_id)}` : '/app'}">← Cancel import</a></nav>
<section class="title"><div><p class="eyebrow">Validated portable policy</p><h1>Review before you ${h(created)}</h1>
<p><strong>${diff.policy_changed ? 'Policy settings will change.' : 'Policy settings are unchanged.'}</strong>
 ${h(diff.account_rules_added)} account-specific rule${diff.account_rules_added === 1 ? '' : 's'} added · ${h(diff.account_rules_removed)} removed.</p></div></section>
<section class="panel"><h2>Policy</h2><p>${diff.policy_changed ? `The evaluator policy differs in ${diff.policy_sections_changed.length} section${diff.policy_sections_changed.length === 1 ? '' : 's'}: ${h(diff.policy_sections_changed.join(', '))}.` : 'The evaluator policy is behaviorally unchanged.'}</p>
<details><summary>View imported policy YAML</summary><pre>${h(draft.policy_body)}</pre></details></section>
<section class="panel"><h2>Account-specific rules</h2><p>These three sets are independent. The same account may intentionally appear in more than one.</p>
${diff.account_rules_removed ? `<div class="notice bad"><strong>${h(diff.account_rules_removed)} rule${diff.account_rules_removed === 1 ? '' : 's'} will be removed.</strong><pre>${h(JSON.stringify(removedRules, null, 2))}</pre></div>` : ''}
<div class="rule-diff"><div><h3>Before</h3><pre>${h(JSON.stringify(diff.before_account_rules, null, 2))}</pre></div><div><h3>After</h3><pre>${h(JSON.stringify(diff.after_account_rules, null, 2))}</pre></div></div></section>
<details class="panel"><summary>View exact submitted YAML</summary><pre>${h(draft.source_document)}</pre></details>
<section class="panel"><h2>Optional live preview</h2><p>Run this imported policy against your feeds before confirming. This contacts current sources and retains normal preview evidence; it is not required for validation.</p>
<form method="post" action="/policy-imports/${h(draft.id)}/preview"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Preview against my feeds now</button></form></section>
<form method="post" action="/policy-imports/${h(draft.id)}/confirm"><input type="hidden" name="csrf" value="${h(csrf)}">
<label class="confirm"><input type="checkbox" name="confirm" value="replace" required> I understand this will ${h(created)} and replace all three account-specific rule sets.</label>
<button>Confirm import</button></form>`, account, csrf)
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
  quarantine_rule_matched: 'Posts more than your rules allow', allow_won: 'A keep rule outranked the mute rule',
  explicit_allow_override: 'You told the app to always keep this account',
  quarantine_evidence_expired: 'The posting data is too old to rely on',
  quarantine_rule_no_longer_matches: 'Used to match, but doesn’t any more',
  no_matching_quarantine_rule: 'Posts less than your rules allow',
  unresolved_precedence: 'A keep rule might apply, so the app won’t guess',
}

function coverageComplete(row: ReceiptRow, receipt: Receipt) {
  const providerCount = Object.keys((receipt.policy as any)?.providers ?? {}).length
  const checks = (receipt.coverage ?? []).filter(item => item.subject === row.subject)
  return providerCount > 0 && checks.length >= providerCount && checks.every(item => item.complete)
}

function currentState(row: ReceiptRow) {
  if (!row.observed.known) return 'Couldn’t check'
  if (row.observed.blocked) return 'You have them blocked'
  if (row.observed.direct) return 'Already muted by you'
  if (row.observed.list) return 'Muted through one of your lists'
  if (row.observed.only_reposts || row.observed.only_quotes) return 'Partly muted already'
  if (row.observed.muted) return 'Already muted'
  return 'Not muted'
}

function exposureText(row: ReceiptRow, receipt: Receipt) {
  const exposures = (receipt.discovery ?? []).flatMap(item => (item as any).exposures ?? [])
    .filter((item: any) => item.subject_did === row.subject)
    .sort((a: any, b: any) => Number(a.position) - Number(b.position))
  const first = exposures[0] as any
  if (!first) return ''
  const surface = first.surface === 'generator' ? 'Discover' : 'Following'
  const by = first.introducer_handle ? ` by @${first.introducer_handle}` : ''
  if (first.mechanism === 'repost') return `Reposted into your ${surface} feed${by}.`
  if (first.mechanism === 'quote') return `Quoted in your ${surface} feed${by}.`
  return `In your ${surface} feed.`
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
  const outcome = overrides.exempt ? 'On your leave-alone list' : row.action === 'mute' ? 'Mute this account?' :
    row.action === 'follow_review_candidate' ? 'You follow them — mute anyway?' :
    row.action === 'release_candidate' ? 'Unmute this account?' : row.desired === 'indeterminate' ? 'Not enough information' :
    row.observed.muted ? 'Already muted — leaving as is' : 'Leaving alone'
  const why = bsky38Evidence ? 'On the Bsky38 leaderboard when you scanned.' : !coverageComplete(row, receipt) && row.desired === 'indeterminate'
    ? 'One of the data sources didn’t answer, so the app won’t guess.'
    : (row.evaluation.reason_codes ?? []).map(code => reasonText[code] ?? code.replaceAll('_', ' ')).join('. ') || 'Nothing matched'
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
  <dl><div><dt>Right now</dt><dd>${h(currentState(row))}</dd></div>
  ${found ? `<div><dt>Where you saw them</dt><dd>${h(found)}</dd></div>` : ''}
  <div><dt>Posting data</dt><dd>${evidenceLines.length ? evidenceLines.map(h).join('<br>') : coverageComplete(row, receipt) ? 'Nothing on record' : 'Couldn’t be fetched'}</dd></div></dl>
  ${exposureDetails(exposures)}
  ${row.evaluation.unresolved.length ? `<p class="unresolved">Still unknown: ${h(row.evaluation.unresolved.join(', '))}</p>` : ''}
  <details class="technical"><summary>Technical decision details</summary><p class="did">${h(row.subject)}</p><pre>${h(JSON.stringify({
    matches: row.evaluation.matches, unresolved: row.evaluation.unresolved,
    observed: row.observed, fingerprint: row.fingerprint,
  }, null, 2))}</pre></details></div></article>`
}

export function previewPage(account: { handle: string; did: string; writesEnabled?: boolean }, csrf: string, previewId: string, receipt: Receipt, query = '') {
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
  const scopeHeading = discovery?.source === 'follows' ? `Looked at the ${discovered} account${discovered === 1 ? '' : 's'} you follow` :
    feedScope ? `Looked at ${discovered} account${discovered === 1 ? '' : 's'} from your Following and Discover feeds` :
    discovery?.source === 'timeline' ? `Looked at ${discovered} account${discovered === 1 ? '' : 's'} from your Following feed` :
    discovery?.source === 'labeled_stream' ? `Looked at ${discovered} account${discovered === 1 ? '' : 's'} from Cornell’s public list` :
    discovery?.source === 'external_snapshot' ? `Looked at the ${discovered} accounts on the Bsky38 leaderboard` :
    `Looked at ${discovered} account${discovered === 1 ? '' : 's'} you named`
  const usable = rows.filter(row => coverageComplete(row, receipt)).length
  const toReview = mutes.length + followed.length + releases.length
  const decisionHeading = toReview
    ? `${toReview} account${toReview === 1 ? '' : 's'} to review`
    : unresolved ? 'Nothing to change yet' : 'Nothing to change'
  const summaryParts = [
    mutes.length ? `${mutes.length} to mute.` : '',
    followed.length ? `${followed.length} you follow, listed separately.` : '',
    releases.length ? `${releases.length} you could unmute.` : '',
  ].filter(Boolean)
  const summary = summaryParts.join(' ') || 'None of these accounts match your rules right now.'
  const incomplete = receipt.completeness ?? {}
  const sourceNote = discovery?.source === 'external_snapshot' && discovery.retrieved_at
    ? `<p class="muted">Unauthenticated third-party leaderboard snapshot read ${h(new Date(discovery.retrieved_at).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC from <a href="https://bsky38.com/" target="_blank" rel="noreferrer">Bsky38</a>. Who’s on it changes between scans. Retrieval digest: <code>${h(discovery.retrieval_digest ?? 'unavailable')}</code>.</p>`
    : feedScope ? '<details class="technical sample-note"><summary>How the feed sample was taken</summary><p>“Following” is what Bluesky’s API returns for your following timeline. Your Home tab may mix in other posts, so this sample won’t match it exactly. An account appearing here means it was in the sample, not that you definitely read the post.</p></details>' : ''
  const feedStanding = feedScope ? `<section class="source-standing" aria-label="Feed sources"><p><strong>Scanned ${h(new Date(receipt.evaluated_at).toLocaleString('en-US', { timeZone: 'UTC' }))} UTC.</strong> Scan again for up-to-date results.</p><ul>${discoveryRows.filter(item => (item as any).source === 'feed_exposure').map(item => {
    const source = item as any
    const name = source.surface === 'generator' ? 'Discover' : 'Following'
    const items = Number(source.items_sampled ?? source.items?.length ?? 0)
    return `<li><strong>${h(name)}:</strong> ${source.complete ? `read ${h(String(items))} post${items === 1 ? '' : 's'}` : h(source.reason || 'couldn’t be read')}</li>`
  }).join('')}</ul></section>` : ''
  const incompleteText = [
    incomplete.discovery === false ? 'The scan stopped early, so some accounts weren’t looked at.' : '',
    incomplete.evidence === false ? 'Some posting data couldn’t be fetched.' : '',
    incomplete.evaluation === false ? 'Some accounts couldn’t be decided one way or the other.' : '',
    incomplete.remote_state === false ? 'Some accounts’ current mute status couldn’t be checked.' : '',
    incomplete.relationship === false ? 'For some accounts the app couldn’t tell whether you follow them.' : '',
  ].filter(Boolean)
  const actionForm = (kind: 'apply' | 'apply_followed' | 'release', actionRows: ReceiptRow[], group = 'proposed') => {
    if (!actionRows.length) return ''
    if (account.writesEnabled === false) return `<section class="result-group" data-result-group="${group}"><section class="results">${actionRows.map(row => resultRow(row, receipt)).join('')}</section><nav class="result-pages" aria-label="${group} result pages"></nav></section>`
    return `<form class="result-group" data-result-group="${group}" method="post" action="/previews/${h(previewId)}/approve">
<input type="hidden" name="csrf" value="${h(csrf)}"><div class="selection-tools"><button type="button" class="quiet" data-select="all">Tick all ${actionRows.length}</button><button type="button" class="quiet" data-select="none">Clear</button></div><section class="results">${actionRows.map(row => resultRow(row, receipt, true)).join('')}</section>
<nav class="result-pages" aria-label="${group} result pages"></nav>
<div class="approval"><div><strong>${kind === 'release' ? 'Unmute the ones you ticked' : 'Mute the ones you ticked'}</strong><p>${kind === 'release' ? 'Only ticked accounts are considered for unmuting.' : 'Only ticked accounts are attempted, and muting is private — they’re never notified.'} Each one is checked again just before the change is made.</p></div>
<button${kind === 'release' ? ' class="danger"' : ''} name="kind" value="${kind}" data-approve="${h(kind === 'release' ? 'Unmute' : 'Mute')}">${kind === 'release' ? 'Unmute selected' : 'Mute selected'}</button></div></form>`
  }
  const followedReview = followed.length ? `<details class="followed-review result-group" data-result-group="followed"><summary><span>Accounts you follow</span><strong>${followed.length}</strong></summary>
<div class="notice"><strong>These are people you chose to follow</strong><p>They matched your rules, but they’re kept out of the main list so you don’t mute a friend by accident. Mute them from here if you want to.</p></div>
${actionForm('apply_followed', followed, 'followed')}</details>` : ''
  const defaultView = query ? 'all' : mutes.length ? 'proposed' : releases.length ? 'release' : followed.length ? 'followed' : 'all'
  // A chip with nothing behind it is noise, so only show the ones that lead somewhere.
  const filterButton = (value: string, label: string, count: number) => !count && value !== 'all' ? '' :
    `<button type="button" class="result-filter${defaultView === value ? ' active' : ''}" data-result-filter="${value}" aria-pressed="${defaultView === value}">${h(label)} <span>${count}</span></button>`
  const filters = `<div class="result-filters" role="group" aria-label="Filter results" data-default-filter="${defaultView}">
${filterButton('proposed', 'To mute', mutes.length)}
${filterButton('followed', 'People you follow', followed.length)}
${filterButton('release', 'To unmute', releases.length)}
${filterButton('unchanged', 'Leaving alone', resolvedUnchanged.length)}
${filterButton('unresolved', 'Couldn’t tell', unresolvedRows.length)}
${filterButton('all', 'Everyone', filtered.length)}</div>`
  return page('Scan results', `
<nav><a href="/app">← Dashboard</a></nav><section class="title"><div><p class="eyebrow">Nothing has changed yet</p>
<h1>${h(decisionHeading)}</h1><p>${h(summary)}${unresolved ? ` The app couldn’t tell about ${unresolved} more.` : ''}</p>
<p class="scope-line">${h(scopeHeading)}. Your own account is never touched.</p></div>
${receipt.complete ? '' : '<span class="status needs_review">partial scan</span>'}</section>
<div class="metrics"><div><strong>${rows.length}</strong><span>accounts checked</span></div><div><strong>${usable}</strong><span>had posting data</span></div><div><strong>${toReview}</strong><span>for you to review</span></div></div>
${incompleteText.length ? `<div role="status" class="notice">${h(incompleteText.join(' '))} When the app isn’t sure, it leaves the account alone.</div>` : ''}
${feedStanding}
${sourceNote}
${account.writesEnabled === false && toReview ? '<div class="notice preview-only"><strong>This is a preview.</strong><p>You can inspect every result, but this beta account cannot approve mute or unmute actions.</p></div>' : ''}
<form method="get"><label for="q">Search these results</label><div class="search"><input id="q" name="q" value="${h(query)}"><button class="quiet">Search</button></div></form>
${filters}
<div class="filter-empty" role="status" hidden>Nothing in this view.</div>
${actionForm('apply', mutes)}${followedReview}${actionForm('release', releases, 'release')}
${resolvedUnchanged.length ? `<section class="result-group" data-result-group="unchanged"><div class="results">${resolvedUnchanged.map(row => resultRow(row, receipt)).join('')}</div><nav class="result-pages" aria-label="No-change result pages"></nav></section>` : ''}
${unresolvedRows.length ? `<section class="result-group" data-result-group="unresolved"><div class="results">${unresolvedRows.map(row => resultRow(row, receipt)).join('')}</div><nav class="result-pages" aria-label="Unresolved result pages"></nav></section>` : ''}
${!filtered.length ? '<p class="empty">Nothing matches that search.</p>' : ''}
${!mutes.length && !followed.length && !releases.length ? '<section class="panel no-actions"><h2>Nothing for you to approve</h2><p>Nobody in this scan matched your rules. Loosen the rules, scan more of your feed, or come back after a while.</p><p><a class="button" href="/app">Back to dashboard</a></p></section>' : ''}
<details class="technical receipt"><summary>Technical scan details</summary><pre>${h(JSON.stringify({ id: receipt.id, evaluated_at: receipt.evaluated_at, complete: receipt.complete, policy_hash: receipt.policy_hash, effective_config_hash: receipt.effective_config_hash }, null, 2))}</pre></details>
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
  const title = running ? `${release ? 'Unmuting' : 'Muting'} ${items.length} account${items.length === 1 ? '' : 's'}…` :
    queued ? `${items.length} account${items.length === 1 ? '' : 's'} waiting to be ${effect}` :
    `${confirmed} account${confirmed === 1 ? '' : 's'} ${effect}${needsReview ? ` · ${needsReview} to check` : ''}`
  const formatTime = (value: unknown) => value ? `${new Date(String(value)).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  })} UTC` : ''
  const updatedAt = formatTime(job.updated_at)
  const approvedAt = formatTime(job.approved_at)
  const statusText: Record<string, string> = {
    pending: 'Waiting', attempting: 'Working on it', confirmed: release ? 'Unmuted' : 'Muted', uncertain: 'Couldn’t confirm',
    failed: 'Didn’t work', failed_permanent: 'Didn’t work', skipped_cancelled: 'Skipped — you cancelled', skipped_stale: 'Skipped — no longer matched',
  }
  const uncertaintyText: Record<string, string> = {
    readback_mismatch: `The app couldn’t confirm this one afterwards. Check the account on Bluesky. It won’t retry on its own.`,
    worker_interrupted: 'The app stopped partway through this one. Check the account on Bluesky. It won’t retry on its own.',
    current_state_matches_ownership_uncertain: `This account is currently ${release ? 'not muted' : 'muted'}, which is what you asked for — but the app can’t be certain it was the one that changed it.`,
    current_state_does_not_match: `This account is currently ${release ? 'muted' : 'not muted'}, so the change didn’t stick. The app did not try again.`,
    current_state_unavailable: 'The app couldn’t read this account’s current state, so it can’t say what happened.',
  }
  return page('Results', `<nav><a href="/app">← Dashboard</a></nav>
<section class="title job-title"><div><p class="eyebrow">${h(job.policy_name || 'Approved changes')}</p><h1>${h(title)}</h1>
<p>${running || queued ? 'This keeps going if you leave the page — come back any time.' : `Here’s what happened to each account you approved.${release ? '' : ' Muting is private; none of them were notified.'}`}</p>${updatedAt ? `<p class="last-updated">Last updated ${h(updatedAt)}</p>` : ''}
<div class="job-actions"><a href="/app">Back to dashboard</a>${job.preview_id ? `<a href="/previews/${h(job.preview_id)}">See the list you approved</a>` : ''}</div></div>
<span class="status job-standing ${h(job.status)}">${h(String(job.status).replaceAll('_', ' '))}</span></section>
${approvedAt ? `<section class="job-context"><span>Approved ${h(approvedAt)}</span></section>` : ''}
${job.error_code ? `<div role="status" class="notice">${job.status === 'needs_review' ? 'The app couldn’t confirm what happened to at least one account. It never silently tries again — check those below.' : `What happened: ${h(String(job.error_code).replaceAll('_', ' '))}`}</div>` : ''}
<section class="job-progress" aria-label="Progress"><div><strong>${processed} of ${items.length}</strong><span>done</span></div><progress max="${items.length || 1}" value="${processed}">${processed} of ${items.length}</progress>
<p>${confirmed} ${effect}${uncertain ? ` · ${uncertain} couldn’t confirm` : ''}${failed ? ` · ${failed} didn’t work` : ''}${skipped ? ` · ${skipped} skipped` : ''}${pending ? ` · ${pending} waiting` : ''}</p></section>
<section class="panel" id="outcomes"><h2>Account by account</h2><ul class="outcomes">${items.map((item, index) => {
  const display = item.display_name ? String(item.display_name) : ''
  const handle = item.handle ? `@${String(item.handle).replace(/^@/, '')}` : ''
  const label = display || handle || `Account ${index + 1}`
  const action = item.action === 'unmute' ? 'Unmute' : 'Mute (private)'
  const profile = profileUrl(String(item.subject))
  const avatar = safeAvatarUrl(item.avatar)
  const error = item.error_code ? uncertaintyText[String(item.error_code)] ?? String(item.error_code).replaceAll('_', ' ') : ''
  return `<li><div class="outcome-account"><div class="account-heading">${avatar ? `<img class="avatar small" src="${h(avatar)}" alt="">` : ''}<div><strong>${profile ? `<a href="${h(profile)}" target="_blank" rel="noopener noreferrer">${h(label)}</a>` : h(label)}</strong>${display && handle ? `<span>${h(handle)}</span>` : ''}${profile ? `<a class="profile-link" href="${h(profile)}" target="_blank" rel="noopener noreferrer">View profile</a>` : ''}</div></div><span>${h(action)}</span>${exposureDetails((item.exposures as Array<Record<string, unknown>>) ?? [])}</div>
<span class="status ${h(item.status)}">${h(statusText[String(item.status)] ?? String(item.status).replaceAll('_', ' '))}</span>
${error ? `<small>${h(error)}</small>` : ''}
${item.status === 'uncertain' ? `<form class="recheck" method="post" action="/jobs/${h(job.id)}/recheck/${h(encodeURIComponent(String(item.subject)))}"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="quiet">Check again</button><span class="muted">Just looks; it won’t redo the change.</span></form>` : ''}
<details class="technical outcome-technical"><summary>Technical details</summary><p class="did">${h(item.subject)}</p><p>Updated ${h(item.updated_at)}</p></details></li>`
}).join('')}</ul></section>
${['queued','running'].includes(String(job.status)) ? `<form method="post" action="/jobs/${h(job.id)}/cancel">
<input type="hidden" name="csrf" value="${h(csrf)}"><button class="danger">Stop the rest</button>
<p class="muted">Accounts already changed stay as they are.</p></form>` : ''}
${running || queued || resumableReview ? `<span id="job-refresh" data-auto-refresh="true" class="muted" role="status">Checking for updates…</span>` : ''}
<details class="technical"><summary>Technical job details</summary><p class="did">Job ${h(job.id)}</p></details>`, account, csrf)
}
