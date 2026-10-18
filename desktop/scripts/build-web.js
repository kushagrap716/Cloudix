'use strict'

// Builds ../frontend for the desktop app and copies the result to ./app-dist.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const frontend = path.resolve(__dirname, '..', '..', 'frontend')
const target = path.resolve(__dirname, '..', 'app-dist')

function run(command) {
  console.log(`> ${command}`)
  const result = spawnSync(command, { cwd: frontend, stdio: 'inherit', shell: true, env: process.env })
  if (result.status !== 0) {
    console.error(`Command failed: ${command}`)
    process.exit(result.status || 1)
  }
}

if (!fs.existsSync(path.join(frontend, 'node_modules'))) {
  run(fs.existsSync(path.join(frontend, 'package-lock.json')) ? 'npm ci' : 'npm install')
}

// DESKTOP_BUILD turns the PWA/service worker off; the API URL stays relative ("/api") because
// the desktop's local server proxies it; reCAPTCHA is disabled (its key is tied to web domains).
process.env.DESKTOP_BUILD = '1'
process.env.VITE_API_URL = ''
process.env.VITE_RECAPTCHA_SITE_KEY = ''
run('npm run build')

const dist = path.join(frontend, 'dist')
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('Build finished but frontend/dist/index.html was not found.')
  process.exit(1)
}
fs.rmSync(target, { recursive: true, force: true })
fs.cpSync(dist, target, { recursive: true })
console.log(`Copied web build to ${target}`)
