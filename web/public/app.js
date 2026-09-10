const source = document.querySelector('#source_type')
const limit = document.querySelector('#limit')
const subjects = document.querySelector('#subjects')
const monthly = document.querySelector('input[name="monthly"]')
const daily = document.querySelector('input[name="daily_pair"]')
const summary = document.querySelector('#policy-summary')
const limitField = document.querySelector('#limit-field')
const subjectsField = document.querySelector('#subjects-field')
const sourceHint = document.querySelector('#source-hint')
const cornellConditions = document.querySelector('#cornell-conditions')
const bsky38Condition = document.querySelector('#bsky38-condition')
const skip = document.querySelector('.skip')

skip?.addEventListener('click', () => document.querySelector('#content')?.focus())

const hints = {
  feeds: 'Combines recent authors from your Timeline and Discover feed. Accounts you follow are held for a separate review.',
  timeline: 'Includes authors who appear in your recent home timeline, whether or not you follow them.',
  labeled_stream: 'Scans Cornell’s public label catalog in bounded pages. The publisher may expose only part of its history.',
  follows: 'Checks only accounts you follow and keeps every match in a separate cleanup review.',
  explicit_dids: 'Checks only the handles or DIDs you enter.',
  external_snapshot: 'Fetches the current top 38 from bsky38.com. Membership can change between previews.',
}

function updatePolicySummary() {
  if (!source || !summary) return
  const kind = source.value
  const specific = kind === 'explicit_dids'
  const bsky38 = kind === 'external_snapshot'
  if (limitField) limitField.hidden = specific || bsky38
  if (subjectsField) subjectsField.hidden = !specific
  if (cornellConditions) cornellConditions.hidden = bsky38
  if (bsky38Condition) bsky38Condition.hidden = !bsky38
  if (sourceHint) sourceHint.textContent = hints[kind] || ''
  if (limit) {
    limit.required = !specific && !bsky38
    limit.max = String(kind === 'feeds' ? 500 : kind === 'timeline' ? 1000 : 5000)
  }
  if (subjects) {
    subjects.required = specific
    subjects.setCustomValidity(specific && !subjects.value.trim() ? 'Enter at least one account handle or DID.' : '')
  }
  const choices = []
  if (monthly?.checked) choices.push('averaging more than 20 posts a day this month')
  if (daily?.checked) choices.push('making both more than 30 posts and more than 30 replies yesterday')
  monthly?.setCustomValidity(!bsky38 && choices.length === 0 ? 'Choose at least one activity label condition.' : '')
  if (bsky38) {
    summary.textContent = 'Suggest muting accounts included in the current Bsky38 leaderboard snapshot.'
    return
  }
  const scope = kind === 'follows' ? 'you follow' : kind === 'feeds' ? 'appearing in your Timeline and Discover feeds' : kind === 'timeline' ? 'appearing in your recent timeline' :
    kind === 'labeled_stream' ? 'found in Cornell’s public label catalog' : 'you list'
  const prefix = specific ? `Check the specific accounts ${scope}.` : kind === 'labeled_stream' ?
    `Scan up to ${limit?.value || '…'} public Cornell label records and check the accounts they name.` :
    `Check up to ${limit?.value || '…'} accounts ${scope}.`
  summary.textContent = `${prefix} ${choices.length ? `Suggest muting accounts Cornell labels as ${choices.join(' or ')}.` : 'Choose at least one condition.'}`
}

for (const control of [source, limit, subjects, monthly, daily]) control?.addEventListener('input', updatePolicySummary)
updatePolicySummary()

const longRunningForms = [...document.querySelectorAll('form')].filter(form => {
  const action = form.getAttribute('action') || ''
  return action === '/diagnostics/yield' || action.endsWith('/preview') || action === '/policies/save'
})

for (const form of longRunningForms) {
  form.addEventListener('submit', event => {
    if (!form.checkValidity()) return
    const submitter = event.submitter
    if (form.getAttribute('action') === '/policies/save' && submitter?.value !== 'preview') return
    document.body.setAttribute('aria-busy', 'true')
    let busy = document.querySelector('#busy-status')
    if (!busy) {
      busy = document.createElement('div')
      busy.id = 'busy-status'
      busy.className = 'busy-status'
      busy.setAttribute('role', 'status')
      busy.setAttribute('aria-live', 'assertive')
      const measurement = form.getAttribute('action') === '/diagnostics/yield'
      busy.innerHTML = measurement
        ? '<span class="busy-spinner" aria-hidden="true"></span><div><strong>Starting a fresh measurement…</strong><p>You’ll be taken to a progress page. You can return to the dashboard while the read-only check continues.</p></div>'
        : '<span class="busy-spinner" aria-hidden="true"></span><div><strong>Building a fresh result…</strong><p>Please keep this page open and do not refresh. This can take a moment while account sources and evidence are checked.</p></div>'
      document.body.append(busy)
    }
    busy.hidden = false
    form.classList.add('submitting')
    if (submitter) {
      submitter.classList.add('submitting-button')
      submitter.setAttribute('aria-disabled', 'true')
      submitter.textContent = 'Working…'
    }
  })
}

const filterBar = document.querySelector('.result-filters')
const resultGroups = [...document.querySelectorAll('[data-result-group]')]
const emptyFilter = document.querySelector('.filter-empty')
let activeFilter = filterBar?.dataset.defaultFilter || 'proposed'
const pageSize = 20

function paginate(group) {
  if (!group || group.matches('details') || group.parentElement?.closest('[data-result-group]')) return
  const results = [...group.querySelectorAll(':scope .results > .result')]
  const pager = group.querySelector(':scope > .result-pages')
  if (!pager || !results.length) return
  let page = Number(group.dataset.page || '1')
  const pages = Math.ceil(results.length / pageSize)
  page = Math.max(1, Math.min(page, pages))
  group.dataset.page = String(page)
  results.forEach((row, index) => { row.hidden = index < (page - 1) * pageSize || index >= page * pageSize })
  if (pages <= 1) { pager.replaceChildren(); return }
  pager.innerHTML = `<button type="button" class="quiet" data-page="previous"${page === 1 ? ' disabled' : ''}>Previous</button><span>Page ${page} of ${pages}</span><button type="button" class="quiet" data-page="next"${page === pages ? ' disabled' : ''}>Next</button>`
}

function applyFilter(filter) {
  activeFilter = filter
  let visible = 0
  for (const group of resultGroups) {
    const show = filter === 'all' || group.dataset.resultGroup === filter
    group.hidden = !show
    if (show && !group.matches('details')) {
      visible += group.querySelectorAll(':scope .results > .result').length
      paginate(group)
    }
  }
  for (const button of filterBar?.querySelectorAll('[data-result-filter]') || []) {
    const selected = button.dataset.resultFilter === filter
    button.classList.toggle('active', selected)
    button.setAttribute('aria-pressed', String(selected))
  }
  if (emptyFilter) {
    emptyFilter.hidden = visible > 0 || (filter === 'followed' && document.querySelector('[data-result-group="followed"] .result'))
  }
}

filterBar?.addEventListener('click', event => {
  const button = event.target.closest('[data-result-filter]')
  if (button) applyFilter(button.dataset.resultFilter)
})

document.addEventListener('click', event => {
  const button = event.target.closest('[data-page]')
  if (!button) return
  const group = button.closest('[data-result-group]')
  const move = button.dataset.page === 'next' ? 1 : -1
  group.dataset.page = String(Number(group.dataset.page || '1') + move)
  paginate(group)
  group.scrollIntoView({ behavior: 'smooth', block: 'start' })
})

if (filterBar) applyFilter(activeFilter)

if (document.querySelector('#job-refresh[data-auto-refresh="true"]')) {
  window.setTimeout(() => window.location.reload(), 3000)
}

for (const button of document.querySelectorAll('[data-select]')) {
  button.addEventListener('click', () => {
    const form = button.closest('form')
    for (const checkbox of form?.querySelectorAll('input[type="checkbox"][name="subject"]') || []) {
      checkbox.checked = button.dataset.select === 'all'
    }
  })
}

if (document.querySelector('#measurement-refresh[data-auto-refresh="true"]')) {
  window.setTimeout(() => window.location.reload(), 2000)
}
