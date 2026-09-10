import { join } from 'node:path'
import { loadConfig } from './config.js'
import { AppDb } from './db.js'
import { Engine } from './engine.js'
import { OAuthAccounts } from './oauth.js'
import { AclService } from './service.js'
import { Worker } from './worker.js'
import { ServiceControls } from './controls.js'

const config = loadConfig()
const db = new AppDb(join(config.dataDir, 'app.db'))
const controls = new ServiceControls(db, config)
const engine = new Engine(config, controls)
await engine.health(true)
if (process.env.ATPROTO_ACL_STARTUP_CHECK === '1') {
  db.close()
  process.exit(0)
}
const accounts = await OAuthAccounts.create(config, db)
const service = new AclService(db, engine, accounts, undefined, undefined, controls)
const worker = new Worker(db, service, undefined, controls)
process.on('SIGTERM', () => worker.stop())
process.on('SIGINT', () => worker.stop())
await worker.loop()
db.close()
