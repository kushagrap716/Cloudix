'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const crypto = require('node:crypto')
const { createLocalServer } = require('../src/local-server')
const { normalizeServerUrl } = require('../src/config')

function request(port, { method = 'GET', pathName = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function main() {
  // --- config normalisation
  assert.equal(normalizeServerUrl('localhost:4000'), 'http://localhost:4000')
  assert.equal(normalizeServerUrl(' https://drive.me/api/ '), 'https://drive.me/api')
  assert.equal(normalizeServerUrl('ftp://x'), null)
  assert.equal(normalizeServerUrl(''), null)
  assert.equal(normalizeServerUrl('http://'), null)
  assert.equal(normalizeServerUrl(42), null)

  // --- mock backend
  const seen = []
  const backend = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization, size: body.length, hash: crypto.createHash('sha256').update(body).digest('hex') })
      if (req.url === '/video') {
        const range = req.headers.range
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/10', 'Accept-Ranges': 'bytes' })
        return res.end('abcd')
      }
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
    })
  })
  await new Promise((r) => backend.listen(0, '127.0.0.1', r))
  const backendPort = backend.address().port

  const callbacks = []
  let handled = true
  const token = 'secret-token'
  const ls = createLocalServer({
    distDir: path.join(__dirname, 'fixture'),
    getBackendUrl: () => `http://127.0.0.1:${backendPort}`,
    desktopHeaderName: 'X-Cloudix-Desktop',
    desktopToken: token,
    onExternalCallback: (p) => { callbacks.push(p); return handled },
  })
  const port = await ls.listen(0)

  // --- static + SPA fallback
  let r = await request(port, { pathName: '/' })
  assert.equal(r.status, 200); assert.match(r.body.toString(), /INDEX/)
  r = await request(port, { pathName: '/all-files' })
  assert.equal(r.status, 200); assert.match(r.body.toString(), /INDEX/)
  r = await request(port, { pathName: '/public/files/abc.def' })
  assert.match(r.body.toString(), /INDEX/)
  r = await request(port, { pathName: '/assets/app.js' })
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /javascript/); assert.match(r.headers['cache-control'], /immutable/)
  r = await request(port, { pathName: '/assets/missing.js' })
  assert.equal(r.status, 404)
  r = await request(port, { pathName: '/%2e%2e/%2e%2e/etc/passwd' })
  assert.match(r.body.toString(), /INDEX/)
  r = await request(port, { pathName: '/..%2f..%2fpackage.json' })
  assert.match(r.body.toString(), /INDEX/)
  r = await request(port, { pathName: '/%E0%A4%A' })
  assert.equal(r.status, 400)
  r = await request(port, { method: 'POST', pathName: '/all-files' })
  assert.equal(r.status, 405)

  // --- proxy: prefix stripped, query kept, headers + body forwarded
  r = await request(port, { pathName: '/api/files?x=1&y=2', headers: { Authorization: 'Bearer t' } })
  assert.equal(r.status, 201)
  assert.equal(seen.at(-1).url, '/files?x=1&y=2')
  assert.equal(seen.at(-1).auth, 'Bearer t')
  assert.equal(seen.at(-1).host, `127.0.0.1:${backendPort}`)
  r = await request(port, { pathName: '/api/api/v1/uploads' })
  assert.equal(seen.at(-1).url, '/api/v1/uploads')
  r = await request(port, { pathName: '/api' })
  assert.equal(seen.at(-1).url, '/')

  const big = crypto.randomBytes(20 * 1024 * 1024)
  r = await request(port, { method: 'POST', pathName: '/api/uploads', headers: { 'Content-Length': big.length }, body: big })
  assert.equal(r.status, 201)
  assert.equal(seen.at(-1).size, big.length)
  assert.equal(seen.at(-1).hash, crypto.createHash('sha256').update(big).digest('hex'))

  r = await request(port, { pathName: '/api/video', headers: { Range: 'bytes=0-3' } })
  assert.equal(r.status, 206); assert.equal(r.headers['content-range'], 'bytes 0-3/10'); assert.equal(r.body.toString(), 'abcd')

  // --- OAuth callback routing
  r = await request(port, { pathName: '/google-auth?token=abc' })
  assert.equal(r.status, 200); assert.match(r.body.toString(), /Back to Cloudix/)
  assert.deepEqual(callbacks, ['/google-auth?token=abc'])
  r = await request(port, { pathName: '/google-connected?status=success', headers: { 'X-Cloudix-Desktop': 'wrong' } })
  assert.equal(callbacks.length, 2)
  r = await request(port, { pathName: '/google-auth?token=abc', headers: { 'X-Cloudix-Desktop': token } })
  assert.match(r.body.toString(), /INDEX/); assert.equal(callbacks.length, 2)
  handled = false
  r = await request(port, { pathName: '/google-auth?status=error' })
  assert.equal(r.status, 503)

  // --- backend down -> clean 502 JSON
  await new Promise((r2) => backend.close(r2))
  r = await request(port, { pathName: '/api/auth/login', method: 'POST', body: '{}' , headers: { 'Content-Length': 2 }})
  assert.equal(r.status, 502)
  assert.equal(JSON.parse(r.body.toString()).code, 'BACKEND_UNREACHABLE')

  await ls.close()
  console.log('All local-server tests passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
