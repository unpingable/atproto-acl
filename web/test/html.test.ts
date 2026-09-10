import assert from 'node:assert/strict'
import test from 'node:test'
import { exposureDetails, profileUrl, safeAvatarUrl, sampledPostUrl } from '../src/html.js'

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
