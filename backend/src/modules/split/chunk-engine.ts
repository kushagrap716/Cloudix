/**
 * Turns the client's sequential upload chunks (positions in the WHOLE file) into uploads of the right
 * piece of the right part. Knows nothing about databases or HTTP: those are passed in, so the logic can be tested.
 *
 * Rules it enforces:
 *  - a chunk may start before the expected position (a retry): the already-stored bytes are skipped
 *  - a chunk may start after it: refused, the client is told where to continue
 *  - a chunk may cross a part boundary: it is cut there
 *  - Google only accepts non-final pieces in multiples of 256 KiB, so a leftover tail is not sent;
 *    the client is told to continue from the last stored byte and sends it again
 */

export const GOOGLE_ALIGN_BYTES = 256 * 1024

export type EnginePart = {
  id: string
  index: number
  accountId: string
  /** First byte of this part inside the whole file. */
  start: number
  size: number
  /** Bytes of this part that the provider has safely stored. */
  uploaded: number
  status: 'pending' | 'uploading' | 'complete'
  sessionUri: string | null
  providerFileId: string | null
  md5: string | null
}

export type PutResult =
  | { kind: 'complete'; providerFileId: string; size: number; md5: string | null }
  | { kind: 'partial'; committed: number }
  | { kind: 'expired' }

export interface PartUploader {
  /** Opens an upload session for the part and returns its URI. */
  startSession(part: EnginePart): Promise<string>
  /** Sends `bytes` that belong at `offsetInPart`. Retries temporary failures itself. */
  put(part: EnginePart, bytes: Buffer, offsetInPart: number): Promise<PutResult>
  /** Asks the provider how much of the part it already has. */
  query(part: EnginePart): Promise<PutResult>
}

export class OffsetMismatchError extends Error {
  constructor(readonly expectedOffset: number) {
    super(`Upload must continue at byte ${expectedOffset}.`)
    this.name = 'OffsetMismatchError'
  }
}

export class PartSizeMismatchError extends Error {
  constructor(readonly partIndex: number, expected: number, actual: number) {
    super(`Part ${partIndex + 1} was stored with ${actual} bytes but ${expected} were expected.`)
    this.name = 'PartSizeMismatchError'
  }
}

export type ChunkOutcome = { offset: number; complete: boolean }

function nextOffset(parts: EnginePart[]) {
  const current = parts.find((part) => part.status !== 'complete')
  if (!current) return null
  return current.start + current.uploaded
}

export function currentOffset(parts: EnginePart[]) {
  return nextOffset(parts) ?? parts.reduce((sum, part) => sum + part.size, 0)
}

export async function applyChunk(
  parts: EnginePart[],
  startByte: number,
  body: Buffer,
  uploader: PartUploader,
  persist: (part: EnginePart) => Promise<void>,
  alignBytes = GOOGLE_ALIGN_BYTES,
): Promise<ChunkOutcome> {
  const total = parts.reduce((sum, part) => sum + part.size, 0)
  const expected = nextOffset(parts)
  if (expected === null) return { offset: total, complete: true }
  if (startByte > expected) throw new OffsetMismatchError(expected)

  const skip = expected - startByte
  if (skip >= body.length) return { offset: expected, complete: false } // chunk we already have
  let data = body.subarray(skip)

  while (data.length > 0) {
    const part = parts.find((candidate) => candidate.status !== 'complete')
    if (!part) break

    const room = part.size - part.uploaded
    let pieceLength = Math.min(data.length, room)
    const reachesPartEnd = pieceLength === room
    if (!reachesPartEnd) {
      pieceLength = Math.floor(pieceLength / alignBytes) * alignBytes
      if (pieceLength === 0) break // too small to send now; the client sends it again together with more data
    }

    if (!part.sessionUri) {
      part.sessionUri = await uploader.startSession(part)
      part.status = 'uploading'
      await persist(part)
    }

    const piece = data.subarray(0, pieceLength)
    const result = await uploader.put(part, piece, part.uploaded)

    if (result.kind === 'expired') {
      part.uploaded = 0
      part.sessionUri = null
      part.status = 'pending'
      await persist(part)
      break
    }

    if (result.kind === 'complete') {
      if (result.size !== part.size) throw new PartSizeMismatchError(part.index, part.size, result.size)
      part.status = 'complete'
      part.uploaded = part.size
      part.providerFileId = result.providerFileId
      part.md5 = result.md5
      await persist(part)
      data = data.subarray(pieceLength)
      continue
    }

    const wanted = part.uploaded + pieceLength
    part.uploaded = Math.max(0, Math.min(result.committed, part.size))
    await persist(part)
    if (part.uploaded < wanted) break // the provider kept less than we sent; the client continues from what is stored
    data = data.subarray(pieceLength)
  }

  const offset = currentOffset(parts)
  return { offset, complete: parts.every((part) => part.status === 'complete') }
}

/** Re-reads progress from the provider (used when a client resumes) so the answer reflects what is really stored. */
export async function refreshProgress(parts: EnginePart[], uploader: PartUploader, persist: (part: EnginePart) => Promise<void>) {
  const part = parts.find((candidate) => candidate.status !== 'complete')
  if (!part || !part.sessionUri) return
  const result = await uploader.query(part)
  if (result.kind === 'expired') {
    part.uploaded = 0
    part.sessionUri = null
    part.status = 'pending'
    await persist(part)
  } else if (result.kind === 'complete') {
    if (result.size !== part.size) throw new PartSizeMismatchError(part.index, part.size, result.size)
    part.status = 'complete'
    part.uploaded = part.size
    part.providerFileId = result.providerFileId
    part.md5 = result.md5
    await persist(part)
  } else if (result.committed !== part.uploaded) {
    part.uploaded = Math.max(0, Math.min(result.committed, part.size))
    await persist(part)
  }
}
