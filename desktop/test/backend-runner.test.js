'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadOrCreateSecrets, runMigrations, startBackend, readLogTail } = require('../src/backend-runner')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'))
  const logPath = path.join(dir, 'logs', 'backend.log')

  // fake backend: prisma CLI + server
  fs.mkdirSync(path.join(dir, 'node_modules', 'prisma', 'build'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'prisma', 'build', 'index.js'),
    `if (process.env.FAKE_FAIL==='denied'){console.error('P1000 Authentication failed');process.exit(1)}
     if (process.argv.slice(2).join(' ')!=='migrate deploy') process.exit(9)
     console.log('migrations ok')`)
  fs.writeFileSync(path.join(dir, 'dist', 'server.js'),
    `if (process.env.FAKE_CRASH) { console.error('boom'); process.exit(3) }
     require('http').createServer((q,s)=>{s.writeHead(q.url==='/health'?200:404);s.end(process.env.DATABASE_URL+'|'+process.env.FRONTEND_URL)}).listen(Number(process.env.APP_PORT),'127.0.0.1')`)

  // secrets: created once, then stable
  const sp = path.join(dir, 'secrets.json')
  const s1 = loadOrCreateSecrets(sp)
  assert.ok(s1.JWT_ACCESS_SECRET.length >= 32 && s1.TOKEN_ENCRYPTION_KEY.length >= 32)
  assert.notEqual(s1.JWT_ACCESS_SECRET, s1.TOKEN_ENCRYPTION_KEY)
  assert.deepEqual(loadOrCreateSecrets(sp), s1)
  fs.writeFileSync(sp, 'not json')
  assert.ok(loadOrCreateSecrets(sp).JWT_ACCESS_SECRET.length >= 32)

  // migrations
  let r = await runMigrations({ backendDir: dir, env: {}, logPath })
  assert.equal(r.ok, true)
  r = await runMigrations({ backendDir: dir, env: { FAKE_FAIL: 'denied' }, logPath })
  assert.equal(r.ok, false); assert.match(r.error, /username or password/)
  r = await runMigrations({ backendDir: path.join(dir, 'nope'), env: {}, logPath })
  assert.equal(r.ok, false)

  // start / health / stop
  const port = 47999
  let b = await startBackend({ backendDir: dir, env: { DATABASE_URL: 'mysql://x', FRONTEND_URL: 'http://f' }, logPath, port })
  assert.equal(b.ok, true)
  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).text()
  assert.equal(body, 'mysql://x|http://f')
  b.stop()
  await new Promise((res) => setTimeout(res, 500))
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`))

  // crash on start
  b = await startBackend({ backendDir: dir, env: { FAKE_CRASH: '1' }, logPath, port })
  assert.equal(b.ok, false); assert.match(b.error, /exit code 3/)
  assert.match(readLogTail(logPath), /boom/)

  // missing files
  b = await startBackend({ backendDir: path.join(dir, 'nope'), env: {}, logPath, port })
  assert.equal(b.ok, false)

  fs.rmSync(dir, { recursive: true, force: true })
  console.log('All backend-runner tests passed')
}
main().catch((e) => { console.error(e); process.exit(1) })
