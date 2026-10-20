'use strict'

// Builds ../backend and copies a production-only copy to ./backend-dist,
// which electron-builder ships inside the app as resources/backend.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const backend = path.resolve(__dirname, '..', '..', 'backend')
const target = path.resolve(__dirname, '..', 'backend-dist')

function run(command, cwd) {
  console.log(`> ${command}   (${path.basename(cwd)})`)
  const result = spawnSync(command, { cwd, stdio: 'inherit', shell: true, env: process.env })
  if (result.status !== 0) {
    console.error(`Command failed: ${command}`)
    process.exit(result.status || 1)
  }
}

// 1. Build the backend from source (needs its dev dependencies for TypeScript).
const prismaBin = path.join('node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma')
// Install when node_modules is missing OR incomplete (e.g. a half-finished earlier install without the Prisma CLI).
if (!fs.existsSync(path.join(backend, prismaBin))) {
  run(fs.existsSync(path.join(backend, 'package-lock.json')) ? 'npm ci' : 'npm install', backend)
}
run('npx --no-install prisma generate', backend) // TypeScript needs the generated Prisma types
run('npm run build', backend)

if (!fs.existsSync(path.join(backend, 'dist', 'server.js'))) {
  console.error('Backend build finished but backend/dist/server.js was not found.')
  process.exit(1)
}

// 2. Copy only what is needed at runtime.
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
fs.cpSync(path.join(backend, 'dist'), path.join(target, 'dist'), { recursive: true })
fs.cpSync(path.join(backend, 'prisma'), path.join(target, 'prisma'), { recursive: true })
for (const file of ['package.json', 'package-lock.json']) {
  if (fs.existsSync(path.join(backend, file))) fs.copyFileSync(path.join(backend, file), path.join(target, file))
}

// 3. Production dependencies + the Prisma client/engines for THIS operating system.
run(fs.existsSync(path.join(target, 'package-lock.json')) ? 'npm ci --omit=dev' : 'npm install --omit=dev', target)
if (fs.existsSync(path.join(backend, 'node_modules', '.prisma'))) {
  fs.cpSync(path.join(backend, 'node_modules', '.prisma'), path.join(target, 'node_modules', '.prisma'), { recursive: true })
}
const generateRes = spawnSync('npx --no-install prisma generate', { cwd: target, stdio: 'inherit', shell: true, env: process.env })
if (generateRes.status !== 0 && !fs.existsSync(path.join(target, 'node_modules', '.prisma', 'client'))) {
  console.error('Command failed: npx --no-install prisma generate')
  process.exit(generateRes.status || 1)
}

if (!fs.existsSync(path.join(target, 'node_modules', 'prisma', 'build', 'index.js'))) {
  console.error('The Prisma CLI is missing from backend-dist/node_modules. The app could not set up its database.')
  process.exit(1)
}
console.log(`Backend bundled in ${target}`)
