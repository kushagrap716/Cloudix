'use strict'

/**
 * Runs the bundled Cloudix backend as a child process, using the same executable as the app
 * (Electron in "run as Node" mode), so the user does not need Node.js installed.
 */

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

function childEnv(extra) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    CHECKPOINT_DISABLE: '1',
    ...extra,
  }
}

function appendLog(logPath, text) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, text)
  } catch {
    /* logging must never crash the app */
  }
}

/** Last part of the log file, for error dialogs. */
function readLogTail(logPath, maxChars = 1800) {
  try {
    const text = fs.readFileSync(logPath, 'utf8')
    return text.length > maxChars ? '…' + text.slice(-maxChars) : text
  } catch {
    return ''
  }
}

/** Keeps the log from growing forever: start fresh when it passes ~2 MB. */
function rotateLog(logPath) {
  try {
    if (fs.statSync(logPath).size > 2 * 1024 * 1024) fs.writeFileSync(logPath, '')
  } catch {
    /* no log yet */
  }
}

/** JWT + encryption secrets (and the bundled database's password) are generated once and kept; changing them would lock users out / break stored Drive tokens. */
function loadOrCreateSecrets(secretsPath) {
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) || {}
  } catch {
    saved = {}
  }
  const valid = (value) => typeof value === 'string' && value.length >= 32
  const secrets = {
    JWT_ACCESS_SECRET: valid(saved.JWT_ACCESS_SECRET) ? saved.JWT_ACCESS_SECRET : crypto.randomBytes(48).toString('hex'),
    TOKEN_ENCRYPTION_KEY: valid(saved.TOKEN_ENCRYPTION_KEY) ? saved.TOKEN_ENCRYPTION_KEY : crypto.randomBytes(48).toString('hex'),
    DB_PASSWORD: valid(saved.DB_PASSWORD) ? saved.DB_PASSWORD : crypto.randomBytes(24).toString('hex'),
  }
  const changed = ['JWT_ACCESS_SECRET', 'TOKEN_ENCRYPTION_KEY', 'DB_PASSWORD'].some((key) => secrets[key] !== saved[key])
  if (changed) {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true })
    fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  }
  return secrets
}

/** Applies database migrations (same as `npx prisma migrate deploy`). */
function runMigrations({ backendDir, env, logPath }) {
  return new Promise((resolve) => {
    const cli = path.join(backendDir, 'node_modules', 'prisma', 'build', 'index.js')
    if (!fs.existsSync(cli)) return resolve({ ok: false, error: `Prisma is missing from the app (${cli}).` })

    appendLog(logPath, `\n[${new Date().toISOString()}] prisma migrate deploy\n`)
    let output = ''
    const child = spawn(process.execPath, [cli, 'migrate', 'deploy'], { cwd: backendDir, env: childEnv(env), windowsHide: true })
    const onData = (chunk) => {
      const text = chunk.toString()
      output = (output + text).slice(-4000)
      appendLog(logPath, text)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => resolve({ ok: false, error: error.message }))
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true })
      const hint = /P1003|does not exist/i.test(output)
        ? 'The database does not exist yet. Create it first (for example: CREATE DATABASE cloudix;).'
        : /P1000|Access denied|Authentication failed/i.test(output)
          ? 'MySQL rejected the username or password in the database URL.'
          : /P1001|Can't reach database|ECONNREFUSED/i.test(output)
            ? 'Cannot reach MySQL. Make sure MySQL is running and the address/port are right.'
            : `Database setup failed (exit code ${code}).`
      resolve({ ok: false, error: hint })
    })
  })
}

function pingHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

/**
 * Starts the backend and resolves once /health answers.
 * Resolves { ok: true, stop } or { ok: false, error, stop }.
 */
function startBackend({ backendDir, env, logPath, port, timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    const entry = path.join(backendDir, 'dist', 'server.js')
    if (!fs.existsSync(entry)) return resolve({ ok: false, error: `Backend files are missing (${entry}).`, stop() {} })

    appendLog(logPath, `\n[${new Date().toISOString()}] starting backend on port ${port}\n`)
    const child = spawn(process.execPath, [entry], { cwd: backendDir, env: childEnv({ ...env, APP_PORT: String(port) }), windowsHide: true })
    let exited = false
    let exitCode = null
    const onData = (chunk) => appendLog(logPath, chunk.toString())
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    const stop = () => {
      if (!exited) {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
    }

    child.on('error', (error) => {
      exited = true
      resolve({ ok: false, error: error.message, stop })
    })
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      appendLog(logPath, `\n[${new Date().toISOString()}] backend exited with code ${code}\n`)
    })

    const startedAt = Date.now()
    const poll = async () => {
      if (exited) return resolve({ ok: false, error: `The server stopped right after starting (exit code ${exitCode}).`, stop })
      if (await pingHealth(`http://127.0.0.1:${port}/health`)) return resolve({ ok: true, stop, pid: child.pid })
      if (Date.now() - startedAt > timeoutMs) {
        stop()
        return resolve({ ok: false, error: 'The server did not start in time.', stop })
      }
      setTimeout(poll, 400)
    }
    poll()
  })
}

/** If a previous run was force-killed, its backend may still hold the port. Stop it (only if it is really answering there). */
async function killLeftoverBackend({ pidPath, port }) {
  let pid = NaN
  try {
    pid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10)
  } catch {
    return
  }
  if (Number.isInteger(pid) && pid > 0 && (await pingHealth(`http://127.0.0.1:${port}/health`))) {
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  try {
    fs.rmSync(pidPath, { force: true })
  } catch {
    /* ignore */
  }
}

module.exports = { killLeftoverBackend, pingHealth, loadOrCreateSecrets, runMigrations, startBackend, readLogTail, rotateLog, appendLog }
