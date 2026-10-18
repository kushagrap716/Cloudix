import { randomUUID } from 'node:crypto'
import { google } from 'googleapis'
import type { ConnectedAccount, File, FilePart, UploadSession } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { applyChunk, currentOffset, OffsetMismatchError, refreshProgress, type EnginePart } from './chunk-engine.js'
import { createGoogleUploader, FatalUploadError } from './google-parts.js'
import { partsAreContiguous, planParts } from './split-plan.js'

export const SPLIT_PROVIDER = 'split'
const PARTS_FOLDER_NAME = 'cloudix-parts'
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'
const STALE_UPLOAD_HOURS = 48

export function isSplitFile(file: Pick<File, 'provider'>) {
  return file.provider === SPLIT_PROVIDER
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>()
/** Runs one job at a time per key, so two requests for the same upload can never interleave. */
async function withLock<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(job)
  locks.set(key, run)
  try {
    return await run
  } finally {
    if (locks.get(key) === run) locks.delete(key)
  }
}

function toEngine(part: FilePart): EnginePart {
  return {
    id: part.id,
    index: part.partIndex,
    accountId: part.connectedAccountId,
    start: Number(part.startByte),
    size: Number(part.sizeBytes),
    uploaded: Number(part.uploadedBytes),
    status: part.status === 'complete' ? 'complete' : part.status === 'uploading' ? 'uploading' : 'pending',
    sessionUri: part.googleSessionUri,
    providerFileId: part.providerFileId,
    md5: part.md5Checksum,
  }
}

async function persistPart(part: EnginePart) {
  await prisma.filePart.update({
    where: { id: part.id },
    data: {
      status: part.status,
      uploadedBytes: BigInt(part.uploaded),
      googleSessionUri: part.sessionUri,
      providerFileId: part.providerFileId,
      md5Checksum: part.md5,
    },
  })
}

async function loadEngineParts(fileId: string) {
  const parts = await prisma.filePart.findMany({ where: { fileId }, orderBy: { partIndex: 'asc' } })
  return parts.map(toEngine)
}

function safeName(name: string) {
  return name.replace(/[\\/\u0000-\u001f\u007f]+/g, '-').slice(0, 120) || 'file'
}

function isNotFound(error: unknown) {
  const e = error as { code?: number | string; status?: number; response?: { status?: number } }
  return e?.code === 404 || e?.status === 404 || e?.response?.status === 404
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------

const partsFolderCache = new Map<string, string>()

async function getPartsFolderId(account: ConnectedAccount) {
  const appFolderId = await ensureGoogleAppFolder(account)
  const cacheKey = `${account.id}:${appFolderId}`
  const cached = partsFolderCache.get(cacheKey)
  if (cached) return cached

  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const existing = await drive.files.list({
    q: `name = '${PARTS_FOLDER_NAME}' and mimeType = '${DRIVE_FOLDER_MIME}' and '${appFolderId}' in parents and trashed = false`,
    spaces: 'drive',
    fields: 'files(id)',
    pageSize: 1,
  })
  const id =
    existing.data.files?.[0]?.id ??
    (await drive.files.create({ requestBody: { name: PARTS_FOLDER_NAME, mimeType: DRIVE_FOLDER_MIME, parents: [appFolderId] }, fields: 'id' })).data.id
  if (!id) throw new Error('Could not create the parts folder in Google Drive.')
  partsFolderCache.set(cacheKey, id)
  return id
}

function createUploaderFor(fileId: string, fileName: string, partCount: number, accounts: Map<string, ConnectedAccount>) {
  const clients = new Map<string, Awaited<ReturnType<typeof getAuthedGoogleClient>>>()
  const accountOf = (accountId: string) => {
    const account = accounts.get(accountId)
    if (!account) throw new FatalUploadError('A drive that holds a part of this file is no longer available.', 409)
    return account
  }
  return createGoogleUploader({
    fileId,
    getAccessToken: async (accountId) => {
      let client = clients.get(accountId)
      if (!client) {
        client = await getAuthedGoogleClient(accountOf(accountId))
        clients.set(accountId, client)
      }
      const token = await client.getAccessToken()
      if (!token.token) throw new FatalUploadError('Could not get a Google access token. Reconnect the account.', 401)
      return token.token
    },
    getPartsFolderId: async (accountId) => getPartsFolderId(accountOf(accountId)),
    partName: (part) => `${safeName(fileName)}.cloudix-part-${String(part.index + 1).padStart(3, '0')}-of-${String(partCount).padStart(3, '0')}`,
  })
}

async function accountsForParts(parts: Array<{ accountId?: string; connectedAccountId?: string }>) {
  const ids = [...new Set(parts.map((p) => p.accountId ?? p.connectedAccountId!))]
  const accounts = await prisma.connectedAccount.findMany({ where: { id: { in: ids } } })
  return new Map(accounts.map((account) => [account.id, account]))
}

// ---------------------------------------------------------------------------
// Creating a split upload
// ---------------------------------------------------------------------------

/**
 * Called when no single drive has room for the file. Returns the new upload session, or null when even
 * all connected Google drives together cannot hold it.
 */
export async function tryCreateSplitUpload(args: { userId: string; fileName: string; mimeType: string; sizeBytes: bigint; folderId: string | null }) {
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId: args.userId, provider: 'google_drive', status: 'connected' },
    include: { storageAccount: true },
  })

  // Space already promised to other uploads that are still running.
  const pending = await prisma.filePart.findMany({
    where: { connectedAccountId: { in: accounts.map((a) => a.id) }, status: { not: 'complete' }, file: { status: 'uploading' } },
    select: { connectedAccountId: true, sizeBytes: true, uploadedBytes: true },
  })
  const reserved = new Map<string, bigint>()
  for (const p of pending) reserved.set(p.connectedAccountId, (reserved.get(p.connectedAccountId) ?? 0n) + (p.sizeBytes - p.uploadedBytes))

  const pool = accounts
    .filter((a) => a.storageAccount?.availableBytes !== null && a.storageAccount?.availableBytes !== undefined)
    .map((a) => ({ id: a.id, availableBytes: a.storageAccount!.availableBytes! - (reserved.get(a.id) ?? 0n) }))

  const plan = planParts({ sizeBytes: args.sizeBytes, accounts: pool })
  if (!plan || plan.length < 2) return null

  const fileId = randomUUID()
  const session = await prisma.$transaction(async (tx) => {
    await tx.file.create({
      data: {
        id: fileId,
        userId: args.userId,
        connectedAccountId: plan[0].accountId,
        folderId: args.folderId,
        provider: SPLIT_PROVIDER,
        providerFileId: `split:${fileId}`,
        name: args.fileName,
        mimeType: args.mimeType,
        sizeBytes: args.sizeBytes,
        status: 'uploading',
      },
    })
    await tx.filePart.createMany({
      data: plan.map((p) => ({ fileId, partIndex: p.partIndex, connectedAccountId: p.accountId, startByte: p.startByte, sizeBytes: p.sizeBytes })),
    })
    return tx.uploadSession.create({
      data: {
        userId: args.userId,
        targetConnectedAccountId: plan[0].accountId,
        folderId: args.folderId,
        fileName: args.fileName,
        mimeType: args.mimeType,
        sizeBytes: args.sizeBytes,
        status: 'uploading',
        splitFileId: fileId,
      },
    })
  })
  return { session, partCount: plan.length }
}

/** Total free space across the user's Google drives (used for a clear "not enough space" message). */
export async function poolAvailableBytes(userId: string) {
  const accounts = await prisma.connectedAccount.findMany({ where: { userId, provider: 'google_drive', status: 'connected' }, include: { storageAccount: true } })
  return accounts.reduce((sum, a) => sum + (a.storageAccount?.availableBytes ?? 0n), 0n)
}

// ---------------------------------------------------------------------------
// Receiving chunks
// ---------------------------------------------------------------------------

type SplitProgress = { status: 'uploading'; offset: string } | { status: 'completed'; offset: string; file: Record<string, unknown> }

async function finishUpload(session: UploadSession, userId: string): Promise<SplitProgress> {
  const fileId = session.splitFileId!
  const parts = await prisma.filePart.findMany({ where: { fileId }, orderBy: { partIndex: 'asc' } })
  const allDone = parts.length > 0 && parts.every((p) => p.status === 'complete' && p.providerFileId && p.uploadedBytes === p.sizeBytes)
  if (!allDone || !partsAreContiguous(parts, session.sizeBytes)) throw new Error('The uploaded parts do not add up to the file. The upload was not completed.')

  const [file] = await prisma.$transaction([
    prisma.file.update({ where: { id: fileId }, data: { status: 'active' } }),
    prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date(), errorMessage: null } }),
  ])
  await createAuditLog(userId, 'UPLOAD_FILE', 'file', file.id, { name: file.name, size: file.sizeBytes.toString(), parts: parts.length })
  for (const accountId of new Set(parts.map((p) => p.connectedAccountId))) syncGoogleQuota(accountId).catch(() => undefined)
  return { status: 'completed', offset: session.sizeBytes.toString(), file: { ...file, sizeBytes: file.sizeBytes.toString() } }
}

export async function handleSplitChunk(session: UploadSession, userId: string, startByte: number, body: Buffer): Promise<SplitProgress> {
  return withLock(session.id, async () => {
    const fileId = session.splitFileId!
    if (session.status === 'completed') return { status: 'completed', offset: session.sizeBytes.toString(), file: await completedFile(fileId) }

    const parts = await loadEngineParts(fileId)
    const accounts = await accountsForParts(parts)
    const uploader = createUploaderFor(fileId, session.fileName, parts.length, accounts)

    try {
      const outcome = await applyChunk(parts, startByte, body, uploader, persistPart)
      if (outcome.complete) return await finishUpload(session, userId)
      return { status: 'uploading', offset: String(outcome.offset) }
    } catch (error) {
      if (error instanceof OffsetMismatchError) return { status: 'uploading', offset: String(error.expectedOffset) }
      await prisma.uploadSession.update({ where: { id: session.id }, data: { errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Upload failed' } }).catch(() => undefined)
      throw error
    }
  })
}

async function completedFile(fileId: string) {
  const file = await prisma.file.findUniqueOrThrow({ where: { id: fileId } })
  return { ...file, sizeBytes: file.sizeBytes.toString() }
}

/** Where should the client continue? Asks Google so the answer is what is really stored. */
export async function getSplitStatus(session: UploadSession, userId: string): Promise<SplitProgress> {
  return withLock(session.id, async () => {
    const fileId = session.splitFileId!
    if (session.status === 'completed') return { status: 'completed', offset: session.sizeBytes.toString(), file: await completedFile(fileId) }
    const parts = await loadEngineParts(fileId)
    const accounts = await accountsForParts(parts)
    const uploader = createUploaderFor(fileId, session.fileName, parts.length, accounts)
    await refreshProgress(parts, uploader, persistPart)
    if (parts.every((p) => p.status === 'complete')) return await finishUpload(session, userId)
    return { status: 'uploading', offset: String(currentOffset(parts)) }
  })
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

/** Removes every stored part of a split file from the drives. Missing parts count as removed. */
export async function deleteSplitParts(fileId: string) {
  const parts = await prisma.filePart.findMany({ where: { fileId }, orderBy: { partIndex: 'asc' } })
  const accounts = await accountsForParts(parts)
  const touchedAccountIds = new Set<string>()
  const failed: string[] = []

  for (const part of parts) {
    try {
      if (part.providerFileId) {
        const account = accounts.get(part.connectedAccountId)
        if (!account) throw new Error('drive not available')
        const drive = google.drive({ version: 'v3', auth: await getAuthedGoogleClient(account) })
        try {
          await drive.files.delete({ fileId: part.providerFileId })
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
        touchedAccountIds.add(part.connectedAccountId)
      }
      await prisma.filePart.delete({ where: { id: part.id } })
    } catch (error) {
      failed.push(`part ${part.partIndex + 1}: ${error instanceof Error ? error.message : 'delete failed'}`)
    }
  }
  return { failed, touchedAccountIds: [...touchedAccountIds] }
}

/** Uploads that were abandoned halfway would otherwise keep using space in the drives forever. */
export async function cleanupStaleSplitUploads() {
  const cutoff = new Date(Date.now() - STALE_UPLOAD_HOURS * 3600_000)
  const stale = await prisma.file.findMany({ where: { provider: SPLIT_PROVIDER, status: 'uploading', createdAt: { lt: cutoff } }, select: { id: true } })
  for (const { id } of stale) {
    const result = await deleteSplitParts(id)
    if (result.failed.length === 0) {
      await prisma.uploadSession.updateMany({ where: { splitFileId: id }, data: { status: 'failed', errorMessage: 'Upload abandoned and cleaned up.' } })
      await prisma.file.delete({ where: { id } }).catch(() => undefined)
    }
    for (const accountId of result.touchedAccountIds) syncGoogleQuota(accountId).catch(() => undefined)
  }
  return stale.length
}

export function startSplitCleanupSchedule() {
  const run = () => cleanupStaleSplitUploads().catch((error) => console.error('[split] cleanup failed:', error instanceof Error ? error.message : error))
  setTimeout(run, 60_000).unref()
  setInterval(run, 6 * 3600_000).unref()
}
