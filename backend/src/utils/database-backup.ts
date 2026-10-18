import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// Backup / restore for the MySQL / MariaDB database, using the dump and client programs that ship with
// the desktop app (MARIADB_BASE_DIR), or the ones on PATH when running somewhere else.

export type DatabaseTarget = { host: string; port: string; user: string; password: string; database: string }

export function parseDatabaseUrl(rawUrl: string = process.env.DATABASE_URL ?? ''): DatabaseTarget {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('DATABASE_URL is not a valid database address.')
  }
  if (!url.protocol.startsWith('mysql')) throw new Error('Backup and restore need a MySQL or MariaDB database.')
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port || '3306',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  }
}

const IS_WIN = process.platform === 'win32'

function toolCandidates(names: string[]): string[] {
  const candidates: string[] = []
  const baseDir = process.env.MARIADB_BASE_DIR
  if (baseDir) {
    for (const name of names) {
      const full = path.join(baseDir, 'bin', IS_WIN ? `${name}.exe` : name)
      if (fs.existsSync(full)) candidates.push(full)
    }
  }
  return [...candidates, ...names]
}

type RunResult = { code: number | null; stderr: string; missing?: boolean }
type RunOptions = { args: string[]; password: string; stdinFile?: string; stdoutFile?: string }

function runOnce(command: string, options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = spawn(command, options.args, {
      env: { ...process.env, MYSQL_PWD: options.password },
      windowsHide: true,
      stdio: [options.stdinFile ? 'pipe' : 'ignore', options.stdoutFile ? 'pipe' : 'ignore', 'pipe'],
    })
    child.on('error', (error: NodeJS.ErrnoException) => finish({ code: -1, stderr: error.message, missing: error.code === 'ENOENT' }))
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    let out: fs.WriteStream | undefined
    if (options.stdoutFile && child.stdout) {
      out = fs.createWriteStream(options.stdoutFile)
      child.stdout.pipe(out)
    }
    if (options.stdinFile && child.stdin) {
      child.stdin.on('error', () => undefined)
      const input = fs.createReadStream(options.stdinFile)
      input.on('error', (error) => finish({ code: -1, stderr: error.message }))
      input.pipe(child.stdin)
    }
    child.on('close', (code) => {
      if (out) out.end(() => finish({ code, stderr }))
      else finish({ code, stderr })
    })
  })
}

async function runTool(candidates: string[], options: RunOptions): Promise<RunResult> {
  for (const command of candidates) {
    const result = await runOnce(command, options)
    if (!result.missing) return result
  }
  return { code: -1, stderr: '', missing: true }
}

function describeFailure(result: RunResult, toolName: string) {
  if (result.missing) return `The database tool "${toolName}" was not found. Reinstall Cloudix, or install the MariaDB command-line tools.`
  return result.stderr.trim() || `${toolName} stopped with exit code ${result.code}.`
}

export function backupDirectory() {
  const dir = process.env.BACKUP_DIR || os.tmpdir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function tempSqlPath(label: string) {
  return path.join(os.tmpdir(), `cloudix-${label}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sql`)
}

function connectionArgs(target: DatabaseTarget) {
  return ['--no-defaults', '--protocol=TCP', `--host=${target.host}`, `--port=${target.port}`, `--user=${target.user}`, '--default-character-set=utf8mb4']
}

export async function dumpDatabase(outFile: string) {
  const target = parseDatabaseUrl()
  const args = [...connectionArgs(target), '--single-transaction', '--skip-lock-tables', '--hex-blob', '--add-drop-table', target.database]
  const result = await runTool(toolCandidates(['mariadb-dump', 'mysqldump']), { args, password: target.password, stdoutFile: outFile })
  if (result.code !== 0) {
    fs.rmSync(outFile, { force: true })
    throw new Error(describeFailure(result, 'mariadb-dump'))
  }
}

export function assertLooksLikeDump(file: string) {
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(4096)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, read).toString('utf8')
    if (!/--\s*(MariaDB|MySQL) dump/i.test(head)) throw new Error('That file is not a Cloudix backup (.sql). Choose a file created by "Download Backup".')
  } finally {
    fs.closeSync(fd)
  }
}

export async function restoreDatabase(inFile: string) {
  const target = parseDatabaseUrl()
  const args = [...connectionArgs(target), target.database]
  const result = await runTool(toolCandidates(['mariadb', 'mysql']), { args, password: target.password, stdinFile: inFile })
  if (result.code !== 0) throw new Error(describeFailure(result, 'mariadb'))
}
