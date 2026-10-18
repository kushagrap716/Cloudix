'use strict'

// Downloads the official MariaDB Windows zip and unpacks it to ./vendor/mariadb so the app can ship its own database.
// Only done when building on Windows (the bundle is Windows-only). Re-uses an earlier download.
//
// Offline / blocked network? Download "mariadb-<version>-winx64.zip" yourself from https://mariadb.org/download/
// (Windows, ZIP file), put it in desktop/vendor/ and run the build again.
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const SERIES = '11.4' // long-term-support series
const vendor = path.resolve(__dirname, '..', 'vendor')
const target = path.join(vendor, 'mariadb')
const API = 'https://downloads.mariadb.org/rest-api/mariadb'

function hasBundle() {
  return ['mariadbd.exe', 'mysqld.exe'].some((name) => fs.existsSync(path.join(target, 'bin', name)))
}

function skipWithEmptyFolder(reason) {
  console.log(`Skipping the bundled database: ${reason}`)
  fs.mkdirSync(target, { recursive: true }) // electron-builder expects the folder to exist
}

async function latestVersion() {
  const response = await fetch(`${API}/${SERIES}/`)
  if (!response.ok) throw new Error(`MariaDB version lookup failed (HTTP ${response.status})`)
  const text = await response.text()
  const versions = [...text.matchAll(new RegExp(`\\b${SERIES.replace('.', '\\.')}\\.(\\d+)\\b`, 'g'))].map((m) => Number(m[1]))
  if (!versions.length) throw new Error('Could not find a MariaDB version in the API reply')
  return `${SERIES}.${Math.max(...versions)}`
}

async function expectedChecksum(version, fileName) {
  try {
    const response = await fetch(`${API}/${version}/${fileName}/checksum/`)
    if (!response.ok) return null
    const match = (await response.text()).match(/"sha256sum"\s*:\s*"([0-9a-fA-F]{64})"/)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

async function download(url, file) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length')) || 0
  let done = 0
  let lastPrint = 0
  const hash = crypto.createHash('sha256')
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    hash.update(chunk)
    done += chunk.length
    if (Date.now() - lastPrint > 1500) {
      lastPrint = Date.now()
      process.stdout.write(`\r  ${(done / 1048576).toFixed(0)} MB${total ? ' / ' + (total / 1048576).toFixed(0) + ' MB' : ''}   `)
    }
  })
  await pipeline(source, fs.createWriteStream(file))
  process.stdout.write('\n')
  return hash.digest('hex')
}

function extract(zipFile, destination) {
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  const attempts = [
    ['tar', ['-xf', zipFile, '-C', destination]], // built into Windows 10+
    ['powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipFile}' -DestinationPath '${destination}'`]],
    ['unzip', ['-q', zipFile, '-d', destination]],
  ]
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: 'inherit' })
    if (result.status === 0) return
  }
  throw new Error('Could not unpack the MariaDB zip (tried tar, PowerShell and unzip).')
}

function prune(root) {
  for (const name of ['include', 'docs', 'mysql-test', 'sql-bench', 'data']) fs.rmSync(path.join(root, name), { recursive: true, force: true })
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.toLowerCase().endsWith('.pdb')) fs.rmSync(full, { force: true })
    }
  }
  walk(root)
}

async function main() {
  if (process.platform !== 'win32') return skipWithEmptyFolder('only Windows builds include the database')
  if (hasBundle()) return console.log('Bundled database already present: vendor/mariadb')

  fs.mkdirSync(vendor, { recursive: true })
  let zipFile = fs.readdirSync(vendor).map((f) => path.join(vendor, f)).find((f) => /^mariadb-.*winx64\.zip$/i.test(path.basename(f)))

  if (!zipFile) {
    const version = await latestVersion()
    const fileName = `mariadb-${version}-winx64.zip`
    zipFile = path.join(vendor, fileName)
    console.log(`Downloading MariaDB ${version} (about 90 MB)…`)
    const actual = await download(`${API}/${version}/${fileName}`, zipFile)
    const expected = await expectedChecksum(version, fileName)
    if (expected && expected !== actual) {
      fs.rmSync(zipFile, { force: true })
      throw new Error('The downloaded MariaDB file failed its checksum check. Try again.')
    }
    console.log(expected ? 'Checksum OK.' : 'Warning: could not fetch the official checksum; skipped verification.')
  }

  const tmp = path.join(vendor, '_extract')
  extract(zipFile, tmp)
  const inner = fs.readdirSync(tmp, { withFileTypes: true }).find((e) => e.isDirectory() && /^mariadb-/i.test(e.name))
  if (!inner) throw new Error('Unexpected MariaDB zip layout.')
  fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(path.join(tmp, inner.name), target)
  fs.rmSync(tmp, { recursive: true, force: true })
  prune(target)

  if (!hasBundle()) throw new Error('MariaDB was unpacked but bin/mariadbd.exe was not found.')
  console.log('Bundled database ready: vendor/mariadb')
}

main().catch((error) => {
  console.error('\nCould not prepare the bundled database:', error.message)
  console.error('The app can still be built; it will then ask for your own MySQL instead.')
  skipWithEmptyFolder('see error above')
})
