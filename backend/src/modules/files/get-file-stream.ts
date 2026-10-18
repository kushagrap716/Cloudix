import { Readable } from 'node:stream'
import type { ConnectedAccount, File } from '@prisma/client'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'
import { createSplitReadable } from './stream-split-file.js'
import { googleDownloadExportMimeTypes, normalizeHeaders, withExtension } from './stream-google-file.js'

export type FileWithAccount = File & { connectedAccount: ConnectedAccount }

export async function getProviderFileReadable(file: FileWithAccount): Promise<{ stream: Readable; fileName: string }> {
  if (file.provider === 'split') {
    const stream = await createSplitReadable(file)
    return { stream, fileName: file.name }
  }

  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId)
    const client = createS3Client(config)
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
    const body = response.Body as Readable
    if (!body) throw new Error(`Empty body returned for S3 object: ${file.name}`)
    return { stream: body, fileName: file.name }
  }

  // Google Drive
  const auth = await getAuthedGoogleClient(file.connectedAccount)
  const headers = normalizeHeaders(await auth.getRequestHeaders())
  const exportTarget = googleDownloadExportMimeTypes[file.mimeType]
  const responseFileName = exportTarget ? withExtension(file.name, exportTarget.extension) : file.name
  const url = exportTarget
    ? `https://www.googleapis.com/drive/v3/files/${file.providerFileId}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
    : `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`

  const response = await fetch(url, { headers })
  if (!response.ok || !response.body) {
    throw new Error(`Google Drive stream failed for ${file.name}: ${response.statusText}`)
  }

  return {
    stream: Readable.fromWeb(response.body as any),
    fileName: responseFileName,
  }
}
