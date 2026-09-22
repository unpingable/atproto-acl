#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { analyzeCapture, assertBodyFreeCapture } from '../dist/quench-observation.js'

const path = process.argv[2]
if (!path) throw new Error('usage: analyze-quench-capture.mjs CAPTURE.json')
const bytes = await readFile(path)
const capture = JSON.parse(bytes.toString('utf8'))
assertBodyFreeCapture(capture)
const analysis = analyzeCapture(capture)
const receipt = {
  schema: 'atproto-acl.quench-capture-receipt.v1',
  capture_started_at: capture.capture_started_at,
  capture_ended_at: capture.capture_ended_at,
  feeds: ['home', 'discover'],
  requested_bounds: capture.requested_bounds,
  actual_item_counts: {
    home: capture.observations.filter(item => item.feed === 'home').length,
    discover: capture.observations.filter(item => item.feed === 'discover').length,
  },
  determinate_lineage_counts: {
    home: analysis.home.determinate_exposures,
    discover: analysis.discover.determinate_exposures,
  },
  indeterminate_lineage_counts: {
    home: analysis.home.indeterminate_exposures,
    discover: analysis.discover.indeterminate_exposures,
  },
  capture_sha256: createHash('sha256').update(bytes).digest('hex'),
  capture_schema: capture.schema,
  auth_mechanism: capture.auth_mechanism,
  writes_performed: capture.writes_performed,
  privacy: 'body-free structural AT URI and DID observations only',
}
process.stdout.write(`${JSON.stringify({ receipt, analysis }, null, 2)}\n`)
