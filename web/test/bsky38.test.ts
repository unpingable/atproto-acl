import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBsky38 } from '../src/bsky38.js'

const record = (rank: number) => `{did:"did:plc:member${rank}",rank:${rank},voteCount:${1000-rank},handle:"member${rank}.example",displayName:"Member ${rank}"}`

test('Bsky38 parser accepts one exact ranked snapshot', () => {
  const members = parseBsky38(`data:{nominees:[${Array.from({ length: 38 }, (_, index) => record(index + 1)).join(',')}],cursor:"next"}`)
  assert.equal(members.length, 38)
  assert.deepEqual(members[0], {
    did: 'did:plc:member1', rank: 1, voteCount: 999, handle: 'member1.example', displayName: 'Member 1',
  })
})

test('Bsky38 parser accepts tied display ranks and fails closed on partial or duplicate membership', () => {
  const tied = Array.from({ length: 38 }, (_, index) => record(index === 23 ? 23 : index + 1)).join(',')
    .replace('did:plc:member23",rank:23,voteCount:977,handle:"member23.example',
      'did:plc:tied23",rank:23,voteCount:977,handle:"tied23.example')
  assert.equal(parseBsky38(`nominees:[${tied}]`).length, 38)
  assert.throws(() => parseBsky38(`nominees:[${record(1)}]`), /structure changed/)
  assert.throws(() => parseBsky38(`nominees:[${Array.from({ length: 38 }, () => record(1)).join(',')}]`), /structure changed/)
  const implausibleRanks = Array.from({ length: 38 }, (_, index) => record(index < 37 ? 1 : 38)).join(',')
  assert.throws(() => parseBsky38(`nominees:[${implausibleRanks}]`), /structure changed/)
})
