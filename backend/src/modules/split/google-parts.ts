import type { EnginePart, PartUploader, PutResult } from './chunk-engine.js'

/** HTTP side of uploading parts to Google Drive (resumable upload protocol). */

export class FatalUploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'FatalUploadError'
  }
}

class TransientUploadError extends Error {}

export type GoogleUploaderDeps = {
  getAccessToken: (accountId: string) => Promise<string>
  getPartsFolderId: (accountId: string) => Promise<string>
  /** File name used for a part inside the drive (so leftovers can be recognised). */
  partName: (part: EnginePart) => string
  /** Identifies which Cloudix file a part belongs to (stored as a Drive app property). */
  fileId: string
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504])

function committedFromRange(header: string | null) {
  if (!header) return 0
  const match = /bytes=0-(\d+)/.exec(header)
  return match ? Number(match[1]) + 1 : 0
}

async function readResult(response: Response): Promise<PutResult> {
  if (response.status === 200 || response.status === 201) {
    const json = (await response.json().catch(() => null)) as { id?: string; size?: string; md5Checksum?: string } | null
    if (!json?.id) throw new FatalUploadError('Google Drive did not return the stored file id.', response.status)
    return { kind: 'complete', providerFileId: json.id, size: Number(json.size ?? NaN), md5: json.md5Checksum ? json.md5Checksum.toLowerCase() : null }
  }
  if (response.status === 308) return { kind: 'partial', committed: committedFromRange(response.headers.get('range')) }
  if (response.status === 404 || response.status === 410) return { kind: 'expired' }
  const text = await response.text().catch(() => '')
  if (TRANSIENT_STATUSES.has(response.status)) throw new TransientUploadError(`Google Drive answered ${response.status}`)
  throw new FatalUploadError(googleErrorMessage(response.status, text), response.status)
}

function googleErrorMessage(status: number, body: string) {
  if (/storageQuotaExceeded|quotaExceeded|Quota/i.test(body)) return 'A connected Google Drive ran out of space during the upload.'
  if (status === 401 || status === 403) return `Google Drive refused the upload (${status}). Reconnect the account and try again.`
  return `Google Drive upload failed (${status}): ${body.slice(0, 200)}`
}

export function createGoogleUploader(deps: GoogleUploaderDeps): PartUploader {
  const fetchImpl = deps.fetchImpl ?? fetch
  const baseUrl = deps.baseUrl ?? 'https://www.googleapis.com'
  const maxAttempts = deps.maxAttempts ?? 4
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function withRetry<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await action()
      } catch (error) {
        if (error instanceof FatalUploadError) throw error
        if (attempt >= maxAttempts) throw new FatalUploadError('Google Drive could not be reached. Check your connection and retry; the upload continues where it stopped.', 503)
        await sleep(500 * attempt)
      }
    }
  }

  const uploader: PartUploader = {
    async startSession(part) {
      return withRetry(async () => {
        const token = await deps.getAccessToken(part.accountId)
        const folderId = await deps.getPartsFolderId(part.accountId)
        const response = await fetchImpl(`${baseUrl}/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'application/octet-stream',
            'X-Upload-Content-Length': String(part.size),
          },
          body: JSON.stringify({ name: deps.partName(part), parents: [folderId], appProperties: { cloudixFileId: deps.fileId, cloudixPart: String(part.index) } }),
        })
        if (response.status === 200) {
          const location = response.headers.get('location')
          if (!location) throw new FatalUploadError('Google Drive did not return an upload address.', 502)
          return location
        }
        const text = await response.text().catch(() => '')
        if (TRANSIENT_STATUSES.has(response.status)) throw new TransientUploadError(`Google Drive answered ${response.status}`)
        throw new FatalUploadError(googleErrorMessage(response.status, text), response.status)
      })
    },

    async query(part) {
      if (!part.sessionUri) return { kind: 'partial', committed: 0 }
      const sessionUri = part.sessionUri
      return withRetry(async () => {
        const token = await deps.getAccessToken(part.accountId)
        const response = await fetchImpl(sessionUri, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0', 'Content-Range': `bytes */${part.size}` },
        })
        return readResult(response)
      })
    },

    async put(part, bytes, offsetInPart) {
      if (!part.sessionUri) throw new FatalUploadError('Upload session is missing.', 500)
      const sessionUri = part.sessionUri
      let data = bytes
      let offset = offsetInPart

      for (let attempt = 1; ; attempt += 1) {
        try {
          const token = await deps.getAccessToken(part.accountId)
          const response = await fetchImpl(sessionUri, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Length': String(data.length),
              'Content-Range': `bytes ${offset}-${offset + data.length - 1}/${part.size}`,
            },
            body: data as unknown as BodyInit,
          })
          return await readResult(response)
        } catch (error) {
          if (error instanceof FatalUploadError) throw error
          if (attempt >= maxAttempts) throw new FatalUploadError('Google Drive could not be reached. Check your connection and retry; the upload continues where it stopped.', 503)
          await sleep(500 * attempt)
          // Find out what Google really stored before sending anything again.
          let state: PutResult
          try {
            state = await uploader.query(part)
          } catch (queryError) {
            if (queryError instanceof FatalUploadError) throw queryError
            continue
          }
          if (state.kind !== 'partial') return state
          if (state.committed >= offset + data.length) return state
          if (state.committed < offset) return state // Google has less than expected: the caller restarts from there
          if (state.committed > offset) {
            data = data.subarray(state.committed - offset)
            offset = state.committed
          }
        }
      }
    },
  }
  return uploader
}
