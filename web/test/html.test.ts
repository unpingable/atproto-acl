import assert from 'node:assert/strict'
import test from 'node:test'
import { aboutPage, exposureDetails, landing, policyImportPage, previewPage, profileUrl, safeAvatarUrl, sampledPostUrl } from '../src/html.js'

test('Bluesky investigation links are DID-bound and safely rendered', () => {
  assert.equal(profileUrl('did:plc:alice'), 'https://bsky.app/profile/did:plc:alice')
  assert.equal(profileUrl('https://attacker.invalid'), '')
  assert.equal(sampledPostUrl('at://did:plc:alice/app.bsky.feed.post/3kfixture'),
    'https://bsky.app/profile/did:plc:alice/post/3kfixture')
  assert.equal(sampledPostUrl('at://did:plc:alice/app.bsky.feed.generator/not-a-post'), '')
  const rendered = exposureDetails([{
    surface: 'generator', mechanism: 'quote',
    post_uri: 'at://did:plc:alice/app.bsky.feed.post/3kfixture',
  }])
  assert.match(rendered, /target="_blank" rel="noopener noreferrer"/)
  assert.match(rendered, /View sampled quoted post/)
})

test('avatars load only from the exact Bluesky CDN avatar path', () => {
  assert.equal(safeAvatarUrl('https://cdn.bsky.app/img/avatar/plain/did:plc:alice/cid@jpeg'),
    'https://cdn.bsky.app/img/avatar/plain/did:plc:alice/cid@jpeg')
  assert.equal(safeAvatarUrl('https://evil.example/img/avatar/plain/alice'), '')
  assert.equal(safeAvatarUrl('https://cdn.bsky.app.evil.example/img/avatar/plain/alice'), '')
  assert.equal(safeAvatarUrl('javascript:alert(1)'), '')
})

test('public furniture and portability are visible before account setup', () => {
  const html = landing('login-token')
  assert.match(html, /neutral\.zone \/ instruments/)
  assert.match(html, /Your policy is portable/)
  assert.match(html, /WEB UI ↔ ACL\.YAML ↔ CLI/)
  assert.match(html, /Source on GitHub/)
  const about = aboutPage()
  assert.match(about, /Operated by The Neutral Ambassador/)
  assert.match(about, /published by James Beck on GitHub/)
  const imported = policyImportPage({ handle: 'person.test', did: 'did:plc:person' }, 'csrf')
  assert.match(imported, /Nothing is replaced until you inspect the changes and confirm/)
  assert.match(imported, /Maximum decoded document size: 512 KiB/)
})

test('lineage preview explains local scope without implying an actor mute', () => {
  const root = 'at://did:plc:alice/app.bsky.feed.post/root'
  const html = previewPage({ handle: 'viewer.test', did: 'did:plc:viewer', writesEnabled: false }, 'csrf', 'preview', {
    id: 'receipt', account: 'did:plc:viewer', policy_hash: 'policy', effective_config_hash: 'effective',
    override_hash: 'override', evaluated_at: '2026-09-09T12:00:00Z', complete: true,
    evidence: [], discovery: [], rows: [], lineage_rows: [{
      post_uri: 'at://did:plc:bob/app.bsky.feed.post/reply', post_cid: 'cid-reply',
      author_did: 'did:plc:bob', surface: 'timeline', lineage_uri: root, lineage_status: 'reply',
      outcome: 'suppress', action: 'suppress', reason_code: 'suppressed_by_exact_lineage',
      reason: `Suppressed because thread root ${root} is in your quenched lineages.`,
      rule: { type: 'suppress_lineage', root_uri: root },
    }],
  } as any)
  assert.match(html, /Quenched conversations/)
  assert.match(html, /local thread-lineage decision/)
  assert.match(html, /author is not muted and remains eligible elsewhere/)
  assert.doesNotMatch(html, /name="subject" value="did:plc:bob"/)
})
