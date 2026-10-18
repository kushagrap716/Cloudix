'use strict'

/**
 * Local server for the Cloudix desktop app.
 *
 * It does the same job as frontend/nginx.conf in the Docker setup:
 *   - serves the built React app (with SPA fallback to index.html)
 *   - proxies /api/* to the real Cloudix backend (the /api prefix is stripped)
 *
 * It also catches the Google OAuth return trip. Google sign-in is opened in the
 * user's normal browser (Google blocks sign-in inside embedded windows). When the
 * backend redirects that browser to FRONTEND_URL/google-auth?token=..., the request
 * lands here, and we hand it over to the desktop window instead.
 */

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

// Routes the backend redirects the *system browser* to after Google OAuth.
const EXTERNAL_CALLBACK_PATHS = new Set(['/google-auth', '/google-connected'])

const RETURN_TO_APP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cloudix</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a}
  .card{max-width:380px;padding:32px;text-align:center;background:#fff;border:1px solid #e2e8f0;border-radius:16px}
  h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#64748b;font-size:14px;line-height:1.5}
</style></head>
<body><div class="card"><h1>Back to Cloudix</h1>
<p>You can close this tab and return to the Cloudix desktop app.</p></div></body></html>`

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * @param {object} options
 * @param {string} options.distDir                 folder with the built frontend (contains index.html)
 * @param {() => string} options.getBackendUrl     returns the backend base URL (read on every request)
 * @param {string} options.desktopHeaderName       request header that marks requests coming from the desktop window
 * @param {string} options.desktopToken            secret value for that header
 * @param {(pathAndQuery: string) => boolean} options.onExternalCallback  called when the system browser hits an OAuth callback route
 */
function createLocalServer({ distDir, getBackendUrl, desktopHeaderName, desktopToken, onExternalCallback }) {
  const root = path.resolve(distDir)
  const headerName = desktopHeaderName.toLowerCase()

  function serveFile(req, res, filePath, stat, cacheControl) {
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') return res.end()
    const stream = fs.createReadStream(filePath)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      return res.end()
    }

    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      res.writeHead(400)
      return res.end('Bad request')
    }
    if (decoded.includes('\0')) {
      res.writeHead(400)
      return res.end('Bad request')
    }

    const candidate = path.resolve(root, '.' + path.sep + decoded.replace(/^\/+/, ''))
    const insideRoot = candidate === root || candidate.startsWith(root + path.sep)

    const tryIndex = () => {
      const indexPath = path.join(root, 'index.html')
      fs.stat(indexPath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('The Cloudix app files are missing. Rebuild the desktop app.')
        }
        serveFile(req, res, indexPath, stat, 'no-cache')
      })
    }

    if (!insideRoot) return tryIndex()

    fs.stat(candidate, (err, stat) => {
      if (!err && stat.isFile()) {
        const immutable = decoded.startsWith('/assets/')
        return serveFile(req, res, candidate, stat, immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      }
      // Missing hashed assets should 404 instead of returning HTML (clearer errors, no MIME confusion).
      if (decoded.startsWith('/assets/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('Not found')
      }
      tryIndex()
    })
  }

  function proxyToBackend(req, res, backendPath) {
    let base
    try {
      base = new URL(getBackendUrl())
    } catch {
      return sendJson(res, 502, { code: 'BAD_SERVER_URL', message: 'The Cloudix server URL is not valid. Check Server Settings.' })
    }

    const transport = base.protocol === 'https:' ? https : http
    const basePath = base.pathname.replace(/\/+$/, '')
    const headers = { ...req.headers, host: base.host }
    delete headers.connection

    const upstream = transport.request(
      {
        protocol: base.protocol,
        hostname: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: basePath + backendPath,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => res.destroy())
      },
    )

    upstream.on('error', () => {
      if (res.headersSent) return res.destroy()
      sendJson(res, 502, {
        code: 'BACKEND_UNREACHABLE',
        message: `Cannot reach the Cloudix server at ${base.origin}. Check that it is running, or change it in Server Settings.`,
      })
    })

    // If the app cancels the request (closed tab, cancelled upload), stop the upstream one too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })

    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  }

  const server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400)
      return res.end('Bad request')
    }
    const pathname = url.pathname

    // /api/* -> backend /* (same as nginx `location /api/ { proxy_pass http://backend:4000/; }`)
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const backendPath = (pathname.slice('/api'.length) || '/') + url.search
      return proxyToBackend(req, res, backendPath)
    }

    // OAuth return trip arriving from the system browser (no desktop header) -> hand over to the app window.
    if (EXTERNAL_CALLBACK_PATHS.has(pathname) && !safeEqual(req.headers[headerName], desktopToken)) {
      const handled = onExternalCallback(pathname + url.search)
      res.writeHead(handled ? 200 : 503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(
        handled
          ? RETURN_TO_APP_PAGE
          : RETURN_TO_APP_PAGE.replace('You can close this tab and return to the Cloudix desktop app.', 'Open the Cloudix desktop app first, then try again.'),
      )
    }

    serveStatic(req, res, pathname)
  })

  // Uploads can take hours; do not let Node time the sockets out.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 30_000

  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error)
        server.once('error', onError)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError)
          resolve(server.address().port)
        })
      })
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

module.exports = { createLocalServer }
