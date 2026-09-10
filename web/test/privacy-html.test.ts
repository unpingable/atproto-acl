import assert from 'node:assert/strict'
import test from 'node:test'
import { deleteAccountPage, deletedAccountPage, privacyPage } from '../src/html.js'

test('privacy notice states processors, stored data, retention, backups, and contact', () => {
  const html = privacyPage()
  for (const text of [
    'operated by James Beck', 'Linode/Akamai', 'ATProto PDS', 'Bluesky AppView',
    'OAuth credentials and DPoP material', 'does not retain sampled post bodies',
    'Unapproved previews and measurements expire after 30 days',
    'backup copies expire within 30 days', 'keyed deletion tombstone', '31 days',
    'message @neutral.zone on Bluesky',
  ]) assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
})

test('signed-in privacy notice and account deletion page keep deletion distinct from disconnect', () => {
  const account = { handle: 'person.test', did: 'did:plc:person' }
  const privacy = privacyPage(account, 'csrf-value')
  assert.match(privacy, /Delete my atproto-acl data/)
  assert.match(privacy, /Disconnect is different/)
  const deletion = deleteAccountPage(account, 'csrf-value', {
    activeJobs: 0, queuedJobs: 2, historicallyAttributedMutes: 3,
  })
  assert.match(deletion, /Delete data; leave existing Bluesky mutes unchanged/)
  assert.match(deletion, /Review releases, then delete data/)
  assert.match(deletion, /3 mutes it created/)
  assert.match(deletion, /2 pending jobs will be cancelled/)
  assert.doesNotMatch(deletion, /value="after_releases"/)
  assert.match(deletion, /name="confirm" value="delete" required/)
})

test('review-first deletion becomes available only when no attributed mutes remain', () => {
  const html = deleteAccountPage({ handle: 'person.test', did: 'did:plc:person' }, 'csrf', {
    activeJobs: 0, queuedJobs: 0, historicallyAttributedMutes: 0,
  })
  assert.match(html, /value="after_releases"/)
  assert.match(html, /I have finished reviewing releases/)
  assert.match(deletedAccountPage(), /Existing Bluesky mutes were left as they stood/)
})

