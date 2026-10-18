import { createHash } from 'node:crypto'

/**
 * Reads a byte range of a split file by reading the needed pieces of each part in order.
 * Provider-agnostic: the caller supplies `open`, which returns the bytes of one part range.
 *
 * Guarantees:
 *  - exactly (end - start + 1) bytes are produced, or an error is thrown (never a silently short result)
 *  - temporary failures (network, 5xx) are retried and continue from the byte where they stopped
 *  - when a whole part is read, its MD5 is compared with the checksum stored at upload time
 */

export type ReadablePart = {
  index: number
  /** First byte of this part inside the whole file. */
  start: number
  size: number
  /** Hex MD5 reported by the storage provider when the part was uploaded (optional). */
  md5?: string | null
}

export type OpenPart<P extends ReadablePart> = (part: P, from: number, to: number, signal?: AbortSignal) => Promise<AsyncIterable<Uint8Array>>

export class PartReadError extends Error {
  constructor(message: string, readonly partIndex: number, readonly cause?: unknown) {
    super(message)
    this.name = 'PartReadError'
  }
}

export class PartIntegrityError extends PartReadError {
  constructor(partIndex: number) {
    super(`Part ${partIndex + 1} failed its integrity check (checksum mismatch).`, partIndex)
    this.name = 'PartIntegrityError'
  }
}

/** Errors thrown by `open` can set `retriable = false` to stop retrying (for example "file not found"). */
export function isRetriable(error: unknown) {
  return !(error && typeof error === 'object' && (error as { retriable?: boolean }).retriable === false)
}

type ReadOptions = {
  maxAttempts?: number
  retryDelayMs?: number
  verifyChecksums?: boolean
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function* readParts<P extends ReadablePart>(parts: P[], start: number, end: number, open: OpenPart<P>, options: ReadOptions = {}): AsyncGenerator<Buffer> {
  const { maxAttempts = 5, retryDelayMs = 500, verifyChecksums = true, signal, sleep = defaultSleep } = options
  if (end < start) return

  let produced = 0
  const wanted = end - start + 1

  for (const part of parts) {
    const partEnd = part.start + part.size - 1
    if (partEnd < start || part.start > end) continue

    const relFrom = Math.max(start, part.start) - part.start
    const relTo = Math.min(end, partEnd) - part.start
    const wholePart = relFrom === 0 && relTo === part.size - 1
    const hash = verifyChecksums && wholePart && part.md5 ? createHash('md5') : null

    let position = relFrom
    let failures = 0

    while (position <= relTo) {
      if (signal?.aborted) throw new PartReadError('Download was cancelled.', part.index)
      const before = position
      try {
        const source = await open(part, position, relTo, signal)
        for await (const raw of source) {
          if (signal?.aborted) throw new PartReadError('Download was cancelled.', part.index)
          let chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          const room = relTo - position + 1
          if (chunk.length > room) chunk = chunk.subarray(0, room) // never hand out more than was asked for
          if (chunk.length === 0) continue
          hash?.update(chunk)
          position += chunk.length
          produced += chunk.length
          yield chunk
          if (position > relTo) break
        }
        if (position <= relTo) throw new Error(`Storage returned too few bytes (${position - relFrom} of ${relTo - relFrom + 1}).`)
      } catch (error) {
        if (error instanceof PartReadError) throw error
        if (position > before) failures = 0 // progress was made, so this is a fresh failure
        failures += 1
        if (!isRetriable(error) || failures >= maxAttempts) {
          throw new PartReadError(`Could not read part ${part.index + 1}: ${error instanceof Error ? error.message : 'unknown error'}`, part.index, error)
        }
        await sleep(retryDelayMs * failures)
      }
    }

    if (hash && hash.digest('hex') !== part.md5!.toLowerCase()) throw new PartIntegrityError(part.index)
  }

  if (produced !== wanted) throw new PartReadError(`Expected ${wanted} bytes but produced ${produced}.`, -1)
}
