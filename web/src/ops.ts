import { AppDb } from './db.js'
import { createInvite } from './admission.js'

function usage(): never {
  throw new Error('usage: ops <app.db> status | invite create [days] | account-writes <did> <enable|disable> | writes <enable|disable> <operator> <reason> | admissions <enable|disable> <operator> <reason> | resume <job-id>')
}

const [, , path, command, value, operator, ...reasonParts] = process.argv
if (!path || !command) usage()
const db = new AppDb(path)
const now = new Date().toISOString()
try {
  if (command === 'status') {
    const controls = db.sql.prepare('SELECT writes_enabled,admissions_enabled,generation,reason,updated_by,updated_at FROM service_controls WHERE singleton=1').get()
    const jobs = db.sql.prepare("SELECT status,count(*) count FROM jobs GROUP BY status ORDER BY status").all()
    process.stdout.write(JSON.stringify({ controls, jobs }, null, 2) + '\n')
  } else if (command === 'invite') {
    if (value !== 'create') usage()
    const days = operator === undefined ? 14 : Number(operator)
    if (!Number.isSafeInteger(days) || days < 1 || days > 30) throw new Error('invite lifetime must be 1–30 days')
    const invite = createInvite(db, new Date(), days * 24 * 60 * 60 * 1000)
    process.stdout.write(`Invite code (shown once): ${invite.code}\nExpires: ${invite.expiresAt}\n`)
  } else if (command === 'account-writes') {
    if (!value || !['enable', 'disable'].includes(operator ?? '')) usage()
    const changed = db.sql.prepare('UPDATE admissions SET writes_enabled=?,updated_at=? WHERE did=?')
      .run(operator === 'enable' ? 1 : 0, now, value).changes
    if (!changed) throw new Error('admitted account not found')
    db.audit(value, 'account_write_eligibility_changed', { enabled: operator === 'enable' })
    process.stdout.write(`account writes ${operator}d for ${value}\n`)
  } else if (command === 'writes' || command === 'admissions') {
    if (!['enable', 'disable'].includes(value ?? '') || !operator || !reasonParts.length) usage()
    const column = command === 'writes' ? 'writes_enabled' : 'admissions_enabled'
    db.transaction(() => {
      db.sql.prepare(`UPDATE service_controls SET ${column}=?,generation=generation+1,reason=?,updated_by=?,updated_at=? WHERE singleton=1`)
        .run(value === 'enable' ? 1 : 0, reasonParts.join(' ').slice(0, 240), operator.slice(0, 120), now)
      if (command === 'writes' && value === 'disable') {
        db.sql.prepare("UPDATE jobs SET status='paused_by_operator',error_code='writes_paused',updated_at=? WHERE status='queued'").run(now)
      }
    })
    process.stdout.write(`${command} ${value}d\n`)
  } else if (command === 'resume') {
    if (!value) usage()
    const changed = db.sql.prepare(`UPDATE jobs SET status='queued',error_code=NULL,available_at=?,updated_at=?
      WHERE id=? AND status='paused_by_operator' AND EXISTS (
        SELECT 1 FROM approvals a JOIN previews p ON p.id=a.preview_id AND p.did=a.did
        WHERE a.id=jobs.approval_id AND p.expires_at>?
      )`).run(now, now, value, now).changes
    if (!changed) throw new Error('job is not paused or its approval expired')
    process.stdout.write(`resumed ${value}\n`)
  } else usage()
} finally {
  db.close()
}
