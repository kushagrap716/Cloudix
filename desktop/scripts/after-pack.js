'use strict'

// electron-builder skips "node_modules" folders when it copies extraResources, so the bundled server
// would ship without Prisma and its other libraries. Copy them in explicitly after packing,
// and refuse to build an installer that is still missing Prisma.
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const source = path.resolve(__dirname, '..', 'backend-dist', 'node_modules')
  if (!fs.existsSync(source)) throw new Error(`backend-dist/node_modules not found (${source}). Run "npm run build:app" first.`)

  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
  const target = path.join(resources, 'backend', 'node_modules')

  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })

  const prisma = path.join(target, 'prisma', 'build', 'index.js')
  if (!fs.existsSync(prisma)) throw new Error(`Packaging check failed: ${prisma} is missing.`)
  console.log(`  • backend node_modules copied into ${target}`)
}
