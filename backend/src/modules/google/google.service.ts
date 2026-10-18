import { google, type drive_v3 } from 'googleapis'
import type { ConnectedAccount, ProviderConfig } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

const googleDriveFolderMimeType = 'application/vnd.google-apps.folder'
const appFolderName = 'cloudix'
// Must match PARTS_FOLDER_NAME in split.service.ts (kept here to avoid a circular import).
const partsFolderName = 'cloudix-parts'
const parentsPerQuery = 40
const defaultFolderColor = '#3b82f6'
const defaultFolderIconUrl = 'https://api.iconify.design/lucide:folder.svg'

export function createOAuthClient(config: ProviderConfig) {
  return new google.auth.OAuth2(decryptText(config.clientIdEncrypted), decryptText(config.clientSecretEncrypted), config.redirectUri)
}

export async function getAuthedGoogleClient(account: ConnectedAccount) {
  if (!account.accessTokenEncrypted || !account.refreshTokenEncrypted || !account.tokenExpiresAt) throw new Error('Google account tokens are missing.')
  if (!account.providerConfigId) throw new Error('Google provider config is missing.')
  const config = await prisma.providerConfig.findUniqueOrThrow({ where: { id: account.providerConfigId } })
  const client = createOAuthClient(config)
  client.setCredentials({
    access_token: decryptText(account.accessTokenEncrypted),
    refresh_token: decryptText(account.refreshTokenEncrypted),
    expiry_date: account.tokenExpiresAt.getTime(),
  })

  if (account.tokenExpiresAt.getTime() < Date.now() + 60_000) {
    try {
      const result = await client.refreshAccessToken()
      const credentials = result.credentials
      if (credentials.access_token) {
        await prisma.connectedAccount.update({
          where: { id: account.id },
          data: {
            accessTokenEncrypted: encryptText(credentials.access_token),
            tokenExpiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600_000),
            status: 'connected',
          },
        })
        client.setCredentials(credentials)
      }
    } catch (error: any) {
      if (error?.message?.includes('invalid_grant') || error?.code === 400 || error?.code === 401) {
        await prisma.connectedAccount.update({
          where: { id: account.id },
          data: { status: 'needs_reconnect' },
        }).catch(() => undefined)
      }
      throw error
    }
  }

  return client
}

export async function syncGoogleQuota(accountId: string) {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
  try {
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const about = await drive.about.get({ fields: 'storageQuota,user' })
    const quota = about.data.storageQuota
    const total = quota?.limit ? BigInt(quota.limit) : null
    const used = quota?.usage ? BigInt(quota.usage) : 0n
    return await prisma.storageAccount.upsert({
      where: { connectedAccountId: accountId },
      create: {
        connectedAccountId: accountId,
        totalBytes: total,
        usedBytes: used,
        availableBytes: total === null ? null : total - used,
        trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
        lastSyncedAt: new Date(),
      },
      update: {
        totalBytes: total,
        usedBytes: used,
        availableBytes: total === null ? null : total - used,
        trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
        lastSyncedAt: new Date(),
      },
    })
  } catch (error: any) {
    if (error?.message?.includes('invalid_grant') || error?.code === 400 || error?.code === 401) {
      await prisma.connectedAccount.update({
        where: { id: accountId },
        data: { status: 'needs_reconnect' },
      }).catch(() => undefined)
    }
    throw error
  }
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function ensureGoogleAppFolder(account: ConnectedAccount) {
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const queryName = escapeDriveQueryValue(appFolderName)
  const existing = await drive.files.list({
    q: `name = '${queryName}' and mimeType = '${googleDriveFolderMimeType}' and 'root' in parents and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 1,
  })
  const folderId = existing.data.files?.[0]?.id ?? (await drive.files.create({
    requestBody: { name: appFolderName, mimeType: googleDriveFolderMimeType, parents: ['root'] },
    fields: 'id',
  })).data.id

  if (!folderId) throw new Error('Failed to create Google Drive app folder.')
  return folderId
}

export type GoogleAppFolderSyncResult = {
  accountId: string
  created: number
  updated: number
  deleted: number
  foldersCreated: number
  foldersUpdated: number
  foldersRemoved: number
  /** Split files that lost a part on Drive; the caller should remove their remaining parts. */
  orphanedSplitFileIds: string[]
}

type DriveFileMetadata = {
  id: string
  name: string
  mimeType: string
  sizeBytes: bigint
  parentId: string
}

type DriveFolderMetadata = { id: string; name: string; parentId: string }

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}

/** Lists everything directly inside the given Drive folders (batched so the query never gets too long). */
async function listDriveChildren(drive: drive_v3.Drive, parentIds: string[], extraQuery: string, fields: string) {
  const results: drive_v3.Schema$File[] = []
  for (const group of chunk(parentIds, parentsPerQuery)) {
    const parents = group.map((id) => `'${escapeDriveQueryValue(id)}' in parents`).join(' or ')
    let pageToken: string | undefined
    do {
      const response = await drive.files.list({
        q: `(${parents}) and ${extraQuery} and trashed = false`,
        spaces: 'drive',
        fields: `nextPageToken,files(${fields})`,
        pageSize: 1000,
        pageToken,
      })
      results.push(...(response.data.files ?? []))
      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken)
  }
  return results
}

/** Walks the whole folder tree under the cloudix folder, parents before children. Throws if any level cannot be read. */
async function discoverDriveFolders(drive: drive_v3.Drive, appFolderId: string, skipIds: Set<string>) {
  const found: DriveFolderMetadata[] = []
  const seen = new Set<string>([appFolderId])
  let level = [appFolderId]
  for (let depth = 0; level.length > 0 && depth < 50; depth += 1) {
    const children = await listDriveChildren(drive, level, `mimeType = '${googleDriveFolderMimeType}'`, 'id,name,parents')
    const next: string[] = []
    for (const child of children) {
      if (!child.id || !child.name || seen.has(child.id) || skipIds.has(child.id)) continue
      const parentId = child.parents?.find((id) => seen.has(id)) ?? appFolderId
      if (parentId === appFolderId && child.name === partsFolderName) continue // internal storage for split files
      seen.add(child.id)
      found.push({ id: child.id, name: child.name, parentId })
      next.push(child.id)
    }
    level = next
  }
  return found
}

export async function syncGoogleAppFolderFiles(accountId: string, userId: string): Promise<GoogleAppFolderSyncResult> {
  const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId, provider: 'google_drive', status: 'connected' } })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const appFolderId = await ensureGoogleAppFolder(account)

  // ---- 1. Folders: mirror the folder tree that currently exists on Drive ----
  const dbFolders = await prisma.folder.findMany({ where: { userId, connectedAccountId: account.id, providerFolderId: { not: null } } })
  // Folders deleted in the app must not come back just because Drive still has them.
  const skipIds = new Set(dbFolders.filter((f) => f.deletedAt !== null).map((f) => f.providerFolderId as string))
  const driveFolders = await discoverDriveFolders(drive, appFolderId, skipIds)
  const liveFolderIds = new Set(driveFolders.map((f) => f.id))
  const dbFolderByProviderId = new Map(dbFolders.filter((f) => f.deletedAt === null).map((f) => [f.providerFolderId as string, f]))
  const folderIdMap = new Map<string, string>([...dbFolderByProviderId].map(([providerId, folder]) => [providerId, folder.id]))
  let foldersCreated = 0
  let foldersUpdated = 0
  let foldersRemoved = 0

  for (const driveFolder of driveFolders) {
    const parentDbId = driveFolder.parentId === appFolderId ? null : (folderIdMap.get(driveFolder.parentId) ?? null)
    const existing = dbFolderByProviderId.get(driveFolder.id)
    if (!existing) {
      const created = await prisma.folder.create({
        data: { userId, connectedAccountId: account.id, provider: 'google_drive', providerFolderId: driveFolder.id, name: driveFolder.name, parentId: parentDbId, color: defaultFolderColor, iconUrl: defaultFolderIconUrl },
      })
      folderIdMap.set(driveFolder.id, created.id)
      foldersCreated += 1
    } else if (existing.name !== driveFolder.name || existing.parentId !== parentDbId) {
      await prisma.folder.update({ where: { id: existing.id }, data: { name: driveFolder.name, parentId: parentDbId } })
      foldersUpdated += 1
    }
  }

  const goneFolderIds = [...dbFolderByProviderId].filter(([providerId]) => !liveFolderIds.has(providerId)).map(([, folder]) => folder.id)
  if (goneFolderIds.length > 0) {
    const result = await prisma.folder.updateMany({ where: { id: { in: goneFolderIds }, userId }, data: { deletedAt: new Date() } })
    foldersRemoved = result.count
  }

  // ---- 2. Files: everything directly inside the cloudix folder or any live folder under it ----
  const driveFiles: DriveFileMetadata[] = []
  const listed = await listDriveChildren(drive, [appFolderId, ...liveFolderIds], `mimeType != '${googleDriveFolderMimeType}'`, 'id,name,mimeType,size,parents')
  for (const file of listed) {
    if (!file.id || !file.name || !file.mimeType) continue
    const parentId = file.parents?.find((id) => id === appFolderId || liveFolderIds.has(id)) ?? appFolderId
    driveFiles.push({ id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: BigInt(file.size ?? 0), parentId })
  }

  const existingFiles = await prisma.file.findMany({ where: { userId, connectedAccountId: account.id, provider: 'google_drive' } })
  const existingByProviderId = new Map(existingFiles.map((file) => [file.providerFileId, file]))
  const driveFileIds = new Set(driveFiles.map((file) => file.id))
  let created = 0
  let updated = 0
  let deleted = 0

  for (const driveFile of driveFiles) {
    const dbFolderId = driveFile.parentId === appFolderId ? null : (folderIdMap.get(driveFile.parentId) ?? null)
    const existing = existingByProviderId.get(driveFile.id)
    if (!existing) {
      await prisma.file.create({
        data: { userId, connectedAccountId: account.id, provider: 'google_drive', providerFileId: driveFile.id, name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, status: 'active', folderId: dbFolderId },
      })
      created += 1
      continue
    }

    const needsUpdate = existing.name !== driveFile.name || existing.mimeType !== driveFile.mimeType || existing.sizeBytes !== driveFile.sizeBytes || existing.status !== 'active' || existing.deletedAt !== null || existing.folderId !== dbFolderId
    if (needsUpdate) {
      await prisma.file.update({
        where: { id: existing.id },
        data: { name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, status: 'active', deletedAt: null, folderId: dbFolderId },
      })
      updated += 1
    }
  }

  const missingActiveIds = existingFiles.filter((file) => file.status === 'active' && !driveFileIds.has(file.providerFileId)).map((file) => file.id)
  if (missingActiveIds.length > 0) {
    const result = await prisma.file.updateMany({ where: { id: { in: missingActiveIds }, userId }, data: { status: 'deleted', deletedAt: new Date() } })
    deleted = result.count
  }

  // ---- 3. Split files: a file is only usable while every part still exists on Drive ----
  const orphanedSplitFileIds: string[] = []
  const splitParts = await prisma.filePart.findMany({
    where: { connectedAccountId: account.id, providerFileId: { not: null }, file: { userId, provider: 'split', status: 'active' } },
    select: { fileId: true, providerFileId: true },
  })
  if (splitParts.length > 0) {
    const partsFolder = await drive.files.list({
      q: `name = '${escapeDriveQueryValue(partsFolderName)}' and mimeType = '${googleDriveFolderMimeType}' and '${escapeDriveQueryValue(appFolderId)}' in parents and trashed = false`,
      spaces: 'drive',
      fields: 'files(id)',
      pageSize: 1,
    })
    const partsFolderId = partsFolder.data.files?.[0]?.id
    const livePartIds = new Set<string>()
    if (partsFolderId) {
      for (const part of await listDriveChildren(drive, [partsFolderId], `mimeType != '${googleDriveFolderMimeType}'`, 'id')) if (part.id) livePartIds.add(part.id)
    }
    const brokenFileIds = [...new Set(splitParts.filter((part) => !livePartIds.has(part.providerFileId as string)).map((part) => part.fileId))]
    if (brokenFileIds.length > 0) {
      const result = await prisma.file.updateMany({ where: { id: { in: brokenFileIds }, userId, provider: 'split', status: 'active' }, data: { status: 'deleted', deletedAt: new Date() } })
      deleted += result.count
      orphanedSplitFileIds.push(...brokenFileIds)
    }
  }

  await syncGoogleQuota(account.id).catch(() => undefined)
  return { accountId: account.id, created, updated, deleted, foldersCreated, foldersUpdated, foldersRemoved, orphanedSplitFileIds }
}
