'use strict'

// Needs a MariaDB install at /usr (or MARIADB_DIR). Skips itself when there is none (e.g. on Windows).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { resolveMariadb, prepareDatabase, killLeftoverDatabase, canConnect } = require('../src/db-runner')

async function main() {
  const dir = process.env.MARIADB_DIR || '/usr'
  const mariadb = resolveMariadb(dir)
  if (!mariadb || process.platform === 'win32') return console.log('db-runner test skipped (no MariaDB at ' + dir + ')')
  assert.equal(resolveMariadb(path.join(os.tmpdir(), 'nothing-here')), null)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-'))
  const dataDir = path.join(tmp, 'mariadb-data')
  const logPath = path.join(tmp, 'logs', 'db.log')
  const pw = 'abc123def456abc123def456abc123de'
  const opts = { mariadbDir: dir, dataDir, rootPassword: pw, dbName: 'cloudix_test', logPath, extraArgs: ['--user=root'] }

  const sql = (port, query, password = pw) =>
    spawnSync(mariadb.client, ['--no-defaults', '--protocol=TCP', '-h127.0.0.1', `-P${port}`, '-uroot', '-N', '-e', query], { env: { ...process.env, MYSQL_PWD: password }, encoding: 'utf8' })

  // first start: initialises, secures, creates schema
  let db = await prepareDatabase(opts)
  assert.equal(db.ok, true, db.error)
  let r = sql(db.port, 'SHOW DATABASES')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /cloudix_test/)
  r = sql(db.port, 'SELECT 1', 'wrong-password')
  assert.notEqual(r.status, 0) // password is enforced
  sql(db.port, 'CREATE TABLE cloudix_test.t (id INT); INSERT INTO cloudix_test.t VALUES (42)')
  await db.stop()
  assert.equal(await canConnect(db.port), false)

  // second start: reuses data, keeps it
  db = await prepareDatabase(opts)
  assert.equal(db.ok, true, db.error)
  r = sql(db.port, 'SELECT id FROM cloudix_test.t')
  assert.equal(r.stdout.trim(), '42')

  // simulated force-quit: leftover server is found via pid file and stopped
  const pidPath = path.join(tmp, 'db.pid')
  fs.writeFileSync(pidPath, JSON.stringify({ pid: db.pid, port: db.port }))
  await killLeftoverDatabase(pidPath)
  assert.equal(await canConnect(db.port), false)
  assert.equal(fs.existsSync(pidPath), false)
  await new Promise((res) => setTimeout(res, 1000))

  // recovers after the unclean stop
  db = await prepareDatabase(opts)
  assert.equal(db.ok, true, db.error)
  assert.equal(sql(db.port, 'SELECT id FROM cloudix_test.t').stdout.trim(), '42')
  await db.stop()

  // bad dir / bad name
  assert.equal((await prepareDatabase({ ...opts, mariadbDir: path.join(tmp, 'x') })).ok, false)
  assert.equal((await prepareDatabase({ ...opts, dbName: 'a;b' })).ok, false)

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('All db-runner tests passed')
}
main().catch((e) => { console.error(e); process.exit(1) })
