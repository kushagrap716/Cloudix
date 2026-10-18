import { Router } from 'express'
import { exec, spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { requireAuth, resetLocalUserCache } from '../../middleware/auth.middleware.js'
import { assertLooksLikeDump, backupDirectory, dumpDatabase, restoreDatabase, tempSqlPath } from '../../utils/database-backup.js'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import Busboy from 'busboy'

export const systemRouter = Router()


systemRouter.post('/update', requireAuth, (req, res, next) => {
  const projectRoot = path.resolve(process.cwd(), '..')
  const updateScript = path.join(projectRoot, 'update.sh')

  // Check if git is installed
  exec('git --version', (gitError) => {
    if (gitError) {
      return res.status(400).json({
        code: 'GIT_NOT_FOUND',
        message: 'Git is not installed inside the app container. If running Cloudix in Docker, please update via your host terminal:\n\n1. cd cloudix\n2. git pull\n3. docker compose down && docker compose up -d --build'
      })
    }

    if (fs.existsSync(updateScript)) {
      try {
        // Clear old update log to prevent race conditions on frontend polling
        const logFile = path.join(projectRoot, 'update.log')
        fs.writeFileSync(logFile, 'Initiating update...\n')

        const child = spawn('bash', ['update.sh'], {
          cwd: projectRoot,
          detached: true,
          stdio: 'ignore'
        })
        child.unref()

        return res.json({
          status: 'success',
          message: 'System update initiated. Rebuilding and restarting backend & frontend in the background. Please wait ~1 minute and refresh the page.'
        })
      } catch (err: any) {
        return res.status(500).json({
          code: 'UPDATE_FAILED',
          message: 'Failed to start update script.',
          error: err.message
        })
      }
    } else {
      // Fallback to simple git pull if update.sh doesn't exist
      exec('git pull', { cwd: projectRoot }, (error, stdout, stderr) => {
        if (error) {
          console.error('System update failed:', error)
          return res.status(500).json({
            code: 'UPDATE_FAILED',
            message: 'Failed to run git pull. Make sure git is installed and configured.',
            error: error.message,
            stderr
          })
        }

        console.log('System update stdout:', stdout)
        if (stderr) {
          console.warn('System update stderr:', stderr)
        }

        return res.json({
          status: 'success',
          message: 'System code updated successfully. Dev servers will auto-restart.',
          stdout,
          stderr
        })
      })
    }
  })
})

systemRouter.get('/update-log', requireAuth, (req, res) => {
  const projectRoot = path.resolve(process.cwd(), '..')
  const logFile = path.join(projectRoot, 'update.log')

  if (!fs.existsSync(logFile)) {
    return res.json({
      log: 'No update history found.'
    })
  }

  try {
    const logContent = fs.readFileSync(logFile, 'utf8')
    return res.json({
      log: logContent
    })
  } catch (error: any) {
    return res.status(500).json({
      code: 'READ_LOG_FAILED',
      message: 'Failed to read update log file.',
      error: error.message
    })
  }
})

systemRouter.get('/google-config', requireAuth, async (req, res, next) => {
  try {
    const config = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' }
    })

    const defaultRedirect = `${req.protocol}://${req.get('host')}/connected-accounts/google/callback`

    if (!config) {
      return res.json({
        exists: false,
        defaultRedirectUri: defaultRedirect
      })
    }

    let clientId = ''
    try {
      clientId = decryptText(config.clientIdEncrypted)
    } catch {
      clientId = ''
    }

    return res.json({
      exists: true,
      clientId,
      redirectUri: config.redirectUri,
      hasSecret: !!config.clientSecretEncrypted,
      defaultRedirectUri: defaultRedirect
    })
  } catch (error) {
    return next(error)
  }
})

systemRouter.post('/google-config', requireAuth, async (req, res, next) => {
  try {
    const { clientId, clientSecret, redirectUri } = req.body

    if (!clientId) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'Client ID is required.' })
    }

    const defaultRedirect = `${req.protocol}://${req.get('host')}/connected-accounts/google/callback`
    const finalRedirectUri = redirectUri || defaultRedirect

    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]

    // Disable old global active config
    await prisma.providerConfig.updateMany({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      data: { status: 'disabled' }
    })

    // Retrieve the old config to see if we need to reuse the secret if it was not provided in the request
    let finalSecret = clientSecret
    if (!finalSecret) {
      const oldConfig = await prisma.providerConfig.findFirst({
        where: { userId: null, provider: 'google_drive', status: 'disabled' },
        orderBy: { createdAt: 'desc' }
      })
      if (oldConfig) {
        try {
          finalSecret = decryptText(oldConfig.clientSecretEncrypted)
        } catch {
          // ignore
        }
      }
    }

    if (!finalSecret) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'Client Secret is required for first-time setup.' })
    }

    const config = await prisma.providerConfig.create({
      data: {
        userId: null,
        provider: 'google_drive',
        clientIdEncrypted: encryptText(clientId),
        clientSecretEncrypted: encryptText(finalSecret),
        redirectUri: finalRedirectUri,
        scopes,
        status: 'active'
      }
    })

    return res.status(201).json({
      status: 'success',
      message: 'Global Google OAuth configuration updated successfully.',
      id: config.id
    })
  } catch (error) {
    return next(error)
  }
})

systemRouter.get('/backup', requireAuth, async (_req, res, next) => {
  const file = tempSqlPath('backup')
  try {
    await dumpDatabase(file)
    const stamp = new Date().toISOString().slice(0, 10)
    return res.download(file, `cloudix-backup-${stamp}.sql`, () => fs.rm(file, { force: true }, () => undefined))
  } catch (error) {
    fs.rmSync(file, { force: true })
    return next(error)
  }
})

systemRouter.post('/restore', requireAuth, (req, res, next) => {
  const contentType = req.headers['content-type']
  if (!contentType?.includes('multipart/form-data')) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'multipart/form-data required.' })
  }

  const busboy = Busboy({ headers: req.headers, limits: { files: 1 } })
  let uploadedFile: string | null = null
  let uploadDone: Promise<void> | null = null

  busboy.on('file', (_name, fileStream) => {
    const target = tempSqlPath('restore')
    uploadedFile = target
    const out = fs.createWriteStream(target)
    uploadDone = new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve())
      out.on('error', reject)
      fileStream.on('error', reject)
    })
    fileStream.pipe(out)
  })

  busboy.on('error', (error) => {
    if (!res.headersSent) next(error)
  })

  busboy.on('finish', async () => {
    if (!uploadedFile || !uploadDone) return res.status(400).json({ code: 'BAD_REQUEST', message: 'No file uploaded.' })
    const restoreFile = uploadedFile
    const safetyFile = path.join(backupDirectory(), `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`)
    try {
      await uploadDone
      assertLooksLikeDump(restoreFile)

      // Keep a copy of the current data first, so a bad restore can be undone.
      await dumpDatabase(safetyFile)
      try {
        await restoreDatabase(restoreFile)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error'
        const rolledBack = await restoreDatabase(safetyFile).then(() => true).catch(() => false)
        resetLocalUserCache()
        return res.status(500).json({
          code: 'RESTORE_FAILED',
          message: `Restore failed: ${reason}. ${rolledBack ? 'Your previous data was put back.' : `Could not put your previous data back automatically; a copy is saved at ${safetyFile}.`}`,
        })
      }

      resetLocalUserCache()
      return res.json({ status: 'success', message: `Backup restored. A copy of your previous data was saved at ${safetyFile}. Reloading...` })
    } catch (error) {
      fs.rmSync(safetyFile, { force: true })
      const message = error instanceof Error ? error.message : 'Failed to restore database.'
      return res.status(500).json({ code: 'RESTORE_FAILED', message })
    } finally {
      fs.rmSync(restoreFile, { force: true })
    }
  })

  req.pipe(busboy)
})
