#!/usr/bin/env node
// Contain initialization and acquisition exceptions at the CLI boundary.
try {
  const [{ AppDb }, { OAuthAccounts }, { runCapture }] = await Promise.all([
    import('../dist/db.js'), import('../dist/oauth.js'), import('./quench-capture-runner.mjs'),
  ])
  process.exitCode = await runCapture({
    env: process.env, openDb: path => new AppDb(path), createAccounts: (config, db) => OAuthAccounts.create(config, db),
    stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
  })
} catch {
  process.stderr.write('quench capture refusal {"phase":"entry","reason":"capture_refused","status":null}\n')
  process.exitCode = 2
}
