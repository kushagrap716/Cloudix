import type { Response } from 'express'
import { ZipArchive } from 'archiver'
import { getProviderFileReadable, type FileWithAccount } from './get-file-stream.js'

export type ZipEntry = {
  file: FileWithAccount
  zipPath: string
}

export async function streamZipArchive(res: Response, archiveName: string, entries: ZipEntry[]) {
  const safeArchiveName = archiveName.replace(/["\r\n\/\\]/g, '_') || 'download'
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${safeArchiveName}.zip"`)

  const archive = new ZipArchive({
    zlib: { level: 5 },
  })

  archive.on('warning', (err: any) => {
    console.warn('Archiver warning:', err)
  })

  archive.on('error', (err: any) => {
    console.error('Archiver error:', err)
    if (!res.headersSent) {
      res.status(500).json({ code: 'ARCHIVE_CREATION_FAILED', message: err.message })
    } else {
      res.destroy(err)
    }
  })

  archive.pipe(res)

  // Append each file one by one
  for (const entry of entries) {
    try {
      const { stream, fileName } = await getProviderFileReadable(entry.file)
      const targetPath = entry.zipPath || fileName
      archive.append(stream, { name: targetPath })
    } catch (err: any) {
      console.error(`Skipping file ${entry.file.name} in ZIP due to error:`, err)
      archive.append(`Could not retrieve file ${entry.file.name}: ${err?.message || 'Unknown error'}`, {
        name: `${entry.zipPath}.error.txt`,
      })
    }
  }

  await archive.finalize()
}
