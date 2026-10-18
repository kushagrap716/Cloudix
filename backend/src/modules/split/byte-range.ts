/** Parses an HTTP Range header for a single range. Sizes stay far below 2^53, so plain numbers are safe. */

export type ByteRange = { start: number; end: number }

/**
 * - undefined / empty header  -> null (send the whole file)
 * - valid single range        -> { start, end } (inclusive, clamped to the file)
 * - unsatisfiable or invalid  -> 'invalid' (answer 416)
 * Multi-range requests are not supported; they are treated as invalid.
 */
export function parseByteRange(header: string | undefined, total: number): ByteRange | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const [, first, last] = match
  if (first === '' && last === '') return 'invalid'
  if (total <= 0) return 'invalid'

  if (first === '') {
    // suffix range: the last N bytes
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, total - suffix), end: total - 1 }
  }

  const start = Number(first)
  if (!Number.isSafeInteger(start) || start >= total) return 'invalid'
  const end = last === '' ? total - 1 : Math.min(Number(last), total - 1)
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end }
}
