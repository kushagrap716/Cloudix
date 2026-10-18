import { Readable } from 'node:stream'
import type { ConnectedAccount, File } from '@prisma/client'
import type { Response } from 'express'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { parseByteRange } from '../split/byte-range.js'
import { readParts, type OpenPart, type ReadablePart } from '../split/read-parts.js'
import { partsAreContiguous } from '../split/split-plan.js'

type StreamOptions = { disposition?: 'inline' | 'attachment' }
type SplitPart = ReadablePart & { accountId: string; providerFileId: string }

export class SplitFileIncompleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SplitFileIncompleteError'
  }
}

function contentDisposition(type: 'inline' | 'attachment', fileName: string) {
  const clean = fileName.replaceAll('"', '').replace(/[\r\n]+/g, ' ')
  return `${type}; filename="${clean.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(clean)}`
}

/** Loads the parts of a split file and refuses to continue if anything is missing or does not add up. */
export async function loadSplitParts(file: Pick<File, 'id' | 'sizeBytes'>) {
  const rows = await prisma.filePart.findMany({ where: { fileId: file.id }, orderBy: { partIndex: 'asc' } })
  if (rows.length === 0) throw new SplitFileIncompleteError('This file has no stored parts.')
  rows.forEach((row, index) => {
    if (row.partIndex !== index) throw new SplitFileIncompleteError(`Part ${index + 1} of this file is missing.`)
    if (row.status !== 'complete' || !row.providerFileId) throw new SplitFileIncompleteError(`Part ${index + 1} of this file was never fully uploaded.`)
  })
  if (!partsAreContiguous(rows, file.sizeBytes)) throw new SplitFileIncompleteError('The stored parts do not add up to the file size.')

  const accounts = new Map<string, ConnectedAccount>()
  for (const account of await prisma.connectedAccount.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.connectedAccountId))] } } })) accounts.set(account.id, account)
  for (const row of rows) if (!accounts.has(row.connectedAccountId)) throw new SplitFileIncompleteError(`The drive holding part ${row.partIndex + 1} is no longer available.`)

  const parts: SplitPart[] = rows.map((row) => ({
    index: row.partIndex,
    start: Number(row.startByte),
    size: Number(row.sizeBytes),
    md5: row.md5Checksum,
    accountId: row.connectedAccountId,
    providerFileId: row.providerFileId!,
  }))
  return { parts, accounts }
}

async function* dropAndLimit(source: AsyncIterable<Uint8Array>, skip: number, take: number): AsyncGenerator<Uint8Array> {
  let toSkip = skip
  let left = take
  for await (const chunk of source) {
    if (left <= 0) return
    let piece = chunk
    if (toSkip > 0) {
      if (piece.length <= toSkip) {
        toSkip -= piece.length
        continue
      }
      piece = piece.subarray(toSkip)
      toSkip = 0
    }
    if (piece.length > left) piece = piece.subarray(0, left)
    left -= piece.length
    yield piece
  }
}

function createGoogleOpener(accounts: Map<string, ConnectedAccount>): OpenPart<SplitPart> {
  return async (part, from, to, signal) => {
    const account = accounts.get(part.accountId)!
    const auth = await getAuthedGoogleClient(account)
    const headers = await auth.getRequestHeaders()
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${part.providerFileId}?alt=media`, {
      headers: { ...(headers as unknown as Record<string, string>), Range: `bytes=${from}-${to}` },
      signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const temporary = response.status === 429 || response.status >= 500 || (response.status === 403 && /rateLimit|backendError/i.test(text))
      throw Object.assign(new Error(`Google Drive answered ${response.status} for part ${part.index + 1}.`), { retriable: temporary })
    }
    if (!response.body) throw new Error('Google Drive sent an empty answer.')

    const body = Readable.fromWeb(response.body as never) as AsyncIterable<Uint8Array>
    // 206 = exactly the requested bytes. 200 = Google ignored the range, so cut it ourselves.
    return response.status === 206 ? body : dropAndLimit(body, from, to - from + 1)
  }
}

/** A plain Readable of the whole file (used for zip downloads). Errors surface as stream errors. */
export async function createSplitReadable(file: Pick<File, 'id' | 'sizeBytes'>) {
  const { parts, accounts } = await loadSplitParts(file)
  return Readable.from(readParts(parts, 0, Number(file.sizeBytes) - 1, createGoogleOpener(accounts)))
}

export async function streamSplitFile(file: File, rangeHeader: string | undefined, res: Response, options: StreamOptions = {}) {
  const total = Number(file.sizeBytes)
  let loaded: Awaited<ReturnType<typeof loadSplitParts>>
  try {
    loaded = await loadSplitParts(file)
  } catch (error) {
    return res.status(500).json({ code: 'SPLIT_FILE_INCOMPLETE', message: error instanceof Error ? error.message : 'This file cannot be read.' })
  }

  const range = parseByteRange(rangeHeader, total)
  if (range === 'invalid') {
    res.status(416).setHeader('Content-Range', `bytes */${total}`)
    return res.end()
  }
  const start = range?.start ?? 0
  const end = range?.end ?? total - 1

  const abort = new AbortController()
  res.on('close', () => abort.abort())

  const iterator = readParts(loaded.parts, start, end, createGoogleOpener(loaded.accounts), { signal: abort.signal })[Symbol.asyncIterator]()

  // Read the first bytes BEFORE sending headers, so an early failure becomes a clear error instead of a broken download.
  let first: IteratorResult<Buffer>
  try {
    first = await iterator.next()
  } catch (error) {
    abort.abort()
    return res.status(502).json({ code: 'SPLIT_FILE_READ_FAILED', message: error instanceof Error ? error.message : 'Could not read the file from storage.' })
  }

  res.status(range ? 206 : 200)
  res.setHeader('Content-Type', file.mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', String(end - start + 1))
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
  if (options.disposition) res.setHeader('Content-Disposition', contentDisposition(options.disposition, file.name))

  const write = async (chunk: Buffer) => {
    if (res.destroyed) throw new Error('Client disconnected.')
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }

  try {
    let step = first
    while (!step.done) {
      await write(step.value)
      step = await iterator.next()
    }
    res.end()
  } catch (error) {
    // Headers are already out: cut the connection so the client sees a failed download, never a file that looks complete but is not.
    console.error(`[split] download of ${file.id} aborted:`, error instanceof Error ? error.message : error)
    abort.abort()
    res.destroy()
  }
}
