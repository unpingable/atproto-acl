import { createHash } from 'node:crypto'

export const BSKY38_URL = 'https://bsky38.com/'

export type Bsky38Member = {
  did: string
  rank: number
  voteCount: number
  handle: string
  displayName: string
}
export type Bsky38Members = Bsky38Member[] & { retrievalDigest?: string }

const decode = (value: string) => JSON.parse(`"${value}"`) as string

export function parseBsky38(html: string): Bsky38Member[] {
  const pattern = /\{did:"(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)",rank:(\d+),voteCount:(\d+),handle:"((?:\\.|[^"\\])*)",displayName:"((?:\\.|[^"\\])*)"/g
  const members: Bsky38Member[] = []
  for (const match of html.matchAll(pattern)) {
    const rank = Number(match[2])
    if (rank <= 38) members.push({
      did: match[1]!, rank, voteCount: Number(match[3]),
      handle: decode(match[4]!), displayName: decode(match[5]!),
    })
  }
  members.sort((a, b) => a.rank - b.rank)
  if (members.length !== 38 || members[0]?.rank !== 1 || members.at(-1)?.rank !== 38 || members.some((item, index) =>
      !Number.isSafeInteger(item.rank) || !Number.isSafeInteger(item.voteCount) || item.rank < 1 || item.rank > 38 ||
      (index > 0 && item.rank !== members[index - 1]!.rank && item.rank !== index + 1)) ||
      new Set(members.map(item => item.did)).size !== 38) {
    throw new Error('Bsky38 leaderboard structure changed')
  }
  return members
}

export async function fetchBsky38(): Promise<Bsky38Members> {
  const response = await fetch(BSKY38_URL, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'text/html' },
  })
  if (!response.ok || !(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    throw new Error('Bsky38 leaderboard unavailable')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Bsky38 leaderboard unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 512 * 1024) {
      await reader.cancel()
      throw new Error('Bsky38 leaderboard exceeded the response limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const members = parseBsky38(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Bsky38Members
  members.retrievalDigest = createHash('sha256').update(bytes).digest('hex')
  return members
}
