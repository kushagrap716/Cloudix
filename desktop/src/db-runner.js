'use strict'

/**
 * Runs a private MariaDB (bundled inside the app) so users do not have to install MySQL.
 * Data lives in the app's own folder, the server only listens on 127.0.0.1, and root has a random password.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const IS_WIN = process.platform === 'win32'

function appendLog(logPath, text) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, text)
  } catch {
    /* logging must never crash the app */
  }
}

function firstExisting(dir, candidates) {
  for (const candidate of candidates) {
    const full = path.join(dir, candidate)
    try {
      if (fs.statSync(full).isFile()) return full
    } catch {
      /* try next */
    }
  }
  return null
}

/** Finds the MariaDB programs inside a bundle (Windows zip layout) or a system install (used by tests). */
function resolveMariadb(dir) {
  if (!dir) return null
  const server = firstExisting(dir, ['bin/mariadbd.exe', 'bin/mysqld.exe', 'bin/mariadbd', 'sbin/mariadbd', 'bin/mysqld', 'sbin/mysqld'])
  const installDb = firstExisting(dir, [
    'bin/mysql_install_db.exe',
    'bin/mariadb-install-db.exe',
    'bin/mariadb-install-db',
    'scripts/mariadb-install-db',
    'bin/mysql_install_db',
    'scripts/mysql_install_db',
  ])
  const client = firstExisting(dir, ['bin/mariadb.exe', 'bin/mysql.exe', 'bin/mariadb', 'bin/mysql'])
  if (!server || !installDb || !client) return null
  return { baseDir: dir, server, installDb, client }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Runs a short-lived tool and collects its output. Arguments are never logged (they can contain passwords). */
function runTool(file, args, { env, logPath, label, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    appendLog(logPath, `\n[${new Date().toISOString()}] ${label || path.basename(file)}\n`)
    let output = ''
    let finished = false
    const child = spawn(file, args, { env: { ...process.env, ...env }, cwd: path.dirname(file), windowsHide: true })
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ code: -1, output: output + '\n(timed out)' })
    }, timeoutMs)
    const onData = (chunk) => {
      const text = chunk.toString()
      output = (output + text).slice(-4000)
      appendLog(logPath, text)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => finish({ code: -1, output: error.message }))
    child.on('close', (code) => finish({ code, output }))
  })
}

function runSql(mariadb, { port, rootPassword, sql, logPath, extraClientArgs = [] }) {
  return runTool(
    mariadb.client,
    ['--no-defaults', '--protocol=TCP', '-h127.0.0.1', `-P${port}`, '-uroot', ...extraClientArgs, '-e', sql],
    { env: { MYSQL_PWD: rootPassword }, logPath, label: 'sql' },
  )
}

async function initDataDir({ mariadb, dataDir, rootPassword, logPath, extraArgs }) {
  if (fs.existsSync(path.join(dataDir, 'mysql'))) return { ok: true, fresh: false }

  // Remove leftovers of a half-finished earlier attempt.
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dataDir), { recursive: true })

  const args = IS_WIN
    ? [`--datadir=${dataDir}`, `--password=${rootPassword}`]
    : ['--no-defaults', `--basedir=${mariadb.baseDir}`, `--datadir=${dataDir}`, '--auth-root-authentication-method=normal', '--skip-test-db', ...extraArgs]
  const result = await runTool(mariadb.installDb, args, { logPath, label: 'initialising database (first start)' })
  if (result.code !== 0 || !fs.existsSync(path.join(dataDir, 'mysql'))) {
    fs.rmSync(dataDir, { recursive: true, force: true })
    return { ok: false, error: `Could not create the database files (exit code ${result.code}).` }
  }
  return { ok: true, fresh: true }
}

function startServer({ mariadb, dataDir, port, logPath, extraArgs, timeoutMs }) {
  return new Promise((resolve) => {
    const args = [
      '--no-defaults',
      `--datadir=${dataDir}`,
      `--port=${port}`,
      '--bind-address=127.0.0.1',
      '--console',
      '--character-set-server=utf8mb4',
      '--collation-server=utf8mb4_unicode_ci',
      ...(IS_WIN ? [] : [`--basedir=${mariadb.baseDir}`, `--socket=${path.join(dataDir, 'mysql.sock')}`, `--pid-file=${path.join(dataDir, 'mysqld.pid')}`]),
      ...extraArgs,
    ]
    appendLog(logPath, `\n[${new Date().toISOString()}] starting database on port ${port}\n`)
    const child = spawn(mariadb.server, args, { cwd: path.dirname(mariadb.server), windowsHide: true })
    let exited = false
    let exitCode = null
    const onData = (chunk) => appendLog(logPath, chunk.toString())
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => {
      exited = true
      resolve({ ok: false, error: error.message, child })
    })
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      appendLog(logPath, `\n[${new Date().toISOString()}] database exited with code ${code}\n`)
    })

    const startedAt = Date.now()
    const poll = async () => {
      if (exited) {
        const hint = IS_WIN && exitCode === 3221225781 ? ' (a Windows component is missing: install "Microsoft Visual C++ Redistributable 2015-2022 x64")' : ''
        return resolve({ ok: false, error: `The database stopped right after starting (exit code ${exitCode})${hint}.`, child })
      }
      if (await canConnect(port)) return resolve({ ok: true, child })
      if (Date.now() - startedAt > timeoutMs) {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        return resolve({ ok: false, error: 'The database did not start in time.', child })
      }
      setTimeout(poll, 400)
    }
    poll()
  })
}

/**
 * Makes sure the bundled database is initialised, running, and that the Cloudix schema exists.
 * Resolves { ok:true, port, pid, stop() } or { ok:false, error }.
 */
async function prepareDatabase({ mariadbDir, dataDir, rootPassword, dbName, logPath, port, extraArgs = [], extraClientArgs = [], startTimeoutMs = 90000 }) {
  const mariadb = resolveMariadb(mariadbDir)
  if (!mariadb) return { ok: false, error: `The bundled database files are missing (${mariadbDir}).` }
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) return { ok: false, error: 'Invalid database name.' }

  // Linux/containers: the database server refuses to run as root unless told to.
  if (!IS_WIN && typeof process.getuid === 'function' && process.getuid() === 0 && !extraArgs.some((a) => a.startsWith('--user='))) {
    extraArgs = [...extraArgs, '--user=root']
  }

  const init = await initDataDir({ mariadb, dataDir, rootPassword, logPath, extraArgs })
  if (!init.ok) return init

  const usePort = port || (await findFreePort())
  const started = await startServer({ mariadb, dataDir, port: usePort, logPath, extraArgs, timeoutMs: startTimeoutMs })
  const child = started.child

  const stopHard = () => {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  // Ask the server to shut down cleanly (keeps the data safe), then fall back to killing it.
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    await runSql(mariadb, { port: usePort, rootPassword, sql: 'SHUTDOWN', logPath, extraClientArgs, }).catch(() => undefined)
    const timeout = new Promise((resolve) => setTimeout(resolve, 15000, 'timeout'))
    if ((await Promise.race([exited, timeout])) === 'timeout') stopHard()
  }

  if (!started.ok) {
    stopHard()
    return { ok: false, error: started.error }
  }

  // Linux/macOS builds create root without a password; set it before anything else connects.
  if (init.fresh && !IS_WIN) {
    const socket = path.join(dataDir, 'mysql.sock')
    const set = await runTool(
      mariadb.client,
      ['--no-defaults', `--socket=${socket}`, '-uroot', ...extraClientArgs, '-e', `ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}'; FLUSH PRIVILEGES;`],
      { logPath, label: 'securing database' },
    )
    if (set.code !== 0) {
      stopHard()
      return { ok: false, error: 'Could not secure the database.' }
    }
  }

  const created = await runSql(mariadb, {
    port: usePort,
    rootPassword,
    sql: `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    logPath,
    extraClientArgs,
  })
  if (created.code !== 0) {
    stopHard()
    const denied = /Access denied/i.test(created.output)
    return {
      ok: false,
      error: denied
        ? 'The database rejected the saved password. Delete the "mariadb-data" folder in the settings folder to recreate it (this erases stored data).'
        : `Could not prepare the Cloudix database (exit code ${created.code}).`,
    }
  }

  return { ok: true, port: usePort, pid: child.pid, stop, stopHard }
}

/** A database from a previous run can survive a force-quit and keep the data files locked. Stop it. */
async function killLeftoverDatabase(pidPath) {
  let info = null
  try {
    info = JSON.parse(fs.readFileSync(pidPath, 'utf8'))
  } catch {
    return
  }
  if (info && Number.isInteger(info.pid) && info.pid > 0 && Number.isInteger(info.port) && (await canConnect(info.port))) {
    try {
      process.kill(info.pid)
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 40 && (await canConnect(info.port)); i += 1) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    fs.rmSync(pidPath, { force: true })
  } catch {
    /* ignore */
  }
}

module.exports = { resolveMariadb, prepareDatabase, killLeftoverDatabase, findFreePort, canConnect }
