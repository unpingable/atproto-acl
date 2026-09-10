import { JoseKey } from '@atproto/jwk-jose'
import { randomBytes } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.argv[2]
if (!directory) throw new Error('usage: node scripts/generate-secrets.mjs DIRECTORY')
await mkdir(directory, { recursive: true, mode: 0o700 })
const key = await JoseKey.generate(['ES256'], 'atproto-acl-2026-01')
const files = [
  [join(directory, 'oauth-signing-key.jwk'), JSON.stringify(key.jwk) + '\n'],
  [join(directory, 'session-secret'), randomBytes(48).toString('base64url') + '\n'],
  [join(directory, 'tombstone-secret'), randomBytes(48).toString('base64url') + '\n'],
]
for (const [path, content] of files) {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(content) } finally { await file.close() }
}
process.stdout.write('created owner-only OAuth, session, and deletion-tombstone secret files\n')
