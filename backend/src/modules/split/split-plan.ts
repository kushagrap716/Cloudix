/**
 * Decides how a file that does not fit on a single drive is cut into parts.
 * Pure logic (no database, no network) so it can be tested on its own.
 */

export const MIB = 1024n * 1024n

export type PlanAccount = { id: string; availableBytes: bigint }
export type PlannedPart = { partIndex: number; accountId: string; startByte: bigint; sizeBytes: bigint }

type PlanOptions = {
  sizeBytes: bigint
  accounts: PlanAccount[]
  /** Free space kept untouched on every drive (quota numbers are not exact to the byte). */
  marginBytes?: bigint
  /** Part sizes are rounded down to a multiple of this (except the last part). */
  alignBytes?: bigint
}

/**
 * Greedy plan: fill the drive with the most free space first, then the next one, and so on.
 * Uses each drive at most once, so a file is made of as few parts as possible.
 * Returns null when the drives together do not have enough space.
 */
export function planParts({ sizeBytes, accounts, marginBytes = 16n * MIB, alignBytes = MIB }: PlanOptions): PlannedPart[] | null {
  if (sizeBytes <= 0n) return null

  const candidates = accounts
    .map((account) => ({ id: account.id, usable: account.availableBytes - marginBytes }))
    .filter((account) => account.usable >= alignBytes)
    .sort((a, b) => (a.usable === b.usable ? a.id.localeCompare(b.id) : a.usable > b.usable ? -1 : 1))

  const parts: PlannedPart[] = []
  let remaining = sizeBytes
  let cursor = 0n

  for (const account of candidates) {
    if (remaining === 0n) break
    const room = (account.usable / alignBytes) * alignBytes
    const take = remaining < room ? remaining : room
    if (take <= 0n) continue
    parts.push({ partIndex: parts.length, accountId: account.id, startByte: cursor, sizeBytes: take })
    cursor += take
    remaining -= take
  }

  return remaining === 0n ? parts : null
}

/** Checks that parts are in order, touch each other without gaps, and add up to the file size. */
export function partsAreContiguous(parts: Array<{ startByte: bigint | number; sizeBytes: bigint | number }>, totalBytes: bigint | number) {
  let expected = 0n
  for (const part of parts) {
    if (BigInt(part.startByte) !== expected) return false
    if (BigInt(part.sizeBytes) <= 0n) return false
    expected += BigInt(part.sizeBytes)
  }
  return parts.length > 0 && expected === BigInt(totalBytes)
}
