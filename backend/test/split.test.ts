import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { MIB, partsAreContiguous, planParts } from '../src/modules/split/split-plan.js'
import { parseByteRange } from '../src/modules/split/byte-range.js'
import { PartIntegrityError, PartReadError, readParts, type OpenPart, type ReadablePart } from '../src/modules/split/read-parts.js'

const GIB = 1024n * MIB

async function collect(gen: AsyncGenerator<Buffer>) {
  const chunks: Buffer[] = []
  for await (const c of gen) chunks.push(c)
  return Buffer.concat(chunks)
}

// ---------- planner
{
  const accounts = [
    { id: 'a', availableBytes: 14n * GIB },
    { id: 'b', availableBytes: 15n * GIB },
    { id: 'c', availableBytes: 9n * GIB },
    { id: 'd', availableBytes: 15n * GIB },
  ]
  // 20 GiB: biggest drives first (b, d), 2 parts
  let plan = planParts({ sizeBytes: 20n * GIB, accounts })!
  assert.equal(plan.length, 2)
  assert.deepEqual(plan.map((p) => p.accountId), ['b', 'd'])
  assert.equal(plan.reduce((s, p) => s + p.sizeBytes, 0n), 20n * GIB)
  assert.equal(partsAreContiguous(plan, 20n * GIB), true)
  // every part leaves the safety margin
  for (const p of plan) assert.ok(p.sizeBytes <= accounts.find((a) => a.id === p.accountId)!.availableBytes - 16n * MIB)
  // 23 GiB video
  plan = planParts({ sizeBytes: 23n * GIB, accounts })!
  assert.equal(partsAreContiguous(plan, 23n * GIB), true)
  assert.equal(new Set(plan.map((p) => p.accountId)).size, plan.length) // one part per drive
  // exactly everything that is usable
  const total = accounts.reduce((s, a) => s + a.availableBytes - 16n * MIB, 0n)
  assert.ok(planParts({ sizeBytes: total, accounts }) !== null || total % MIB !== 0n)
  // more than the pool: refuse instead of half-uploading
  assert.equal(planParts({ sizeBytes: 60n * GIB, accounts }), null)
  assert.equal(planParts({ sizeBytes: 1n, accounts: [] }), null)
  assert.equal(planParts({ sizeBytes: 0n, accounts }), null)
  // nearly-full drives are ignored
  assert.equal(planParts({ sizeBytes: 10n * MIB, accounts: [{ id: 'x', availableBytes: 10n * MIB }] }), null)
  // contiguity checker catches gaps / wrong totals
  assert.equal(partsAreContiguous([{ startByte: 0n, sizeBytes: 5n }, { startByte: 6n, sizeBytes: 5n }], 11n), false)
  assert.equal(partsAreContiguous([{ startByte: 0n, sizeBytes: 5n }, { startByte: 5n, sizeBytes: 5n }], 11n), false)
  assert.equal(partsAreContiguous([], 0n), false)
}

// ---------- range parser
{
  assert.equal(parseByteRange(undefined, 100), null)
  assert.deepEqual(parseByteRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseByteRange('bytes=50-5000', 100), { start: 50, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-500', 100), { start: 0, end: 99 })
  for (const bad of ['bytes=100-', 'bytes=5-2', 'bytes=-', 'items=0-1', 'bytes=0-1,5-6', 'bytes=a-b', 'bytes=-0']) assert.equal(parseByteRange(bad, 100), 'invalid', bad)
  assert.equal(parseByteRange('bytes=0-1', 0), 'invalid')
}

// ---------- readParts
type P = ReadablePart & { bytes: Buffer }
function makeFile(sizes: number[], withMd5 = true) {
  const parts: P[] = []
  let start = 0
  const all: Buffer[] = []
  sizes.forEach((size, index) => {
    const bytes = randomBytes(size)
    all.push(bytes)
    parts.push({ index, start, size, bytes, md5: withMd5 ? createHash('md5').update(bytes).digest('hex') : null })
    start += size
  })
  return { parts, whole: Buffer.concat(all) }
}
const noSleep = async () => undefined

async function* pieces(buf: Buffer, step: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, Math.min(buf.length, i + step))
}

(async () => {
  const { parts, whole } = makeFile([1000, 2500, 300, 4096])
  const good: OpenPart<P> = async (part, from, to) => pieces(part.bytes.subarray(from, to + 1), 333)

  // whole file
  assert.ok((await collect(readParts(parts, 0, whole.length - 1, good))).equals(whole))

  // many random ranges, including ones that start/end exactly on part boundaries
  const boundaries = [0, 999, 1000, 1001, 3499, 3500, 3799, 3800, whole.length - 1]
  const ranges: Array<[number, number]> = []
  for (const a of boundaries) for (const b of boundaries) if (a <= b) ranges.push([a, b])
  for (let i = 0; i < 300; i += 1) {
    const a = Math.floor(Math.random() * whole.length)
    ranges.push([a, a + Math.floor(Math.random() * (whole.length - a))])
  }
  for (const [a, b] of ranges) assert.ok((await collect(readParts(parts, a, b, good))).equals(whole.subarray(a, b + 1)), `range ${a}-${b}`)

  // flaky network: random mid-stream failures, resumes exactly where it stopped
  let calls = 0
  const flaky: OpenPart<P> = async (part, from, to) => {
    calls += 1
    const slice = part.bytes.subarray(from, to + 1)
    return (async function* () {
      let sent = 0
      for (const piece of slice.length ? [slice] : []) {
        const step = 257
        for (let i = 0; i < piece.length; i += step) {
          if (Math.random() < 0.15) throw new Error('connection reset')
          sent += Math.min(step, piece.length - i)
          yield piece.subarray(i, i + step)
        }
      }
      void sent
    })()
  }
  assert.ok((await collect(readParts(parts, 0, whole.length - 1, flaky, { maxAttempts: 1000, sleep: noSleep }))).equals(whole))
  assert.ok(calls > parts.length, 'flaky source should have forced reconnects')

  // stream that ends early is retried instead of returning a short file
  let shortCalls = 0
  const shortThenFull: OpenPart<P> = async (part, from, to) => {
    shortCalls += 1
    const slice = part.bytes.subarray(from, to + 1)
    return pieces(shortCalls === 1 ? slice.subarray(0, Math.floor(slice.length / 2)) : slice, 100)
  }
  assert.ok((await collect(readParts(parts, 0, whole.length - 1, shortThenFull, { sleep: noSleep }))).equals(whole))

  // permanent failure -> error, never a quiet truncation
  const dead: OpenPart<P> = async () => { throw Object.assign(new Error('404 file removed'), { retriable: false }) }
  await assert.rejects(collect(readParts(parts, 0, 10, dead, { sleep: noSleep })), PartReadError)
  let attempts = 0
  const alwaysFails: OpenPart<P> = async () => { attempts += 1; throw new Error('boom') }
  await assert.rejects(collect(readParts(parts, 0, 10, alwaysFails, { maxAttempts: 3, sleep: noSleep })), PartReadError)
  assert.equal(attempts, 3)

  // corrupted bytes in a whole part are detected
  const corrupt: OpenPart<P> = async (part, from, to) => {
    const copy = Buffer.from(part.bytes.subarray(from, to + 1))
    if (part.index === 2) copy[10] ^= 0xff
    return pieces(copy, 64)
  }
  await assert.rejects(collect(readParts(parts, 0, whole.length - 1, corrupt)), PartIntegrityError)
  // ...and verification can be skipped (partial reads never verify)
  assert.equal((await collect(readParts(parts, 10, 20, corrupt))).length, 11)

  // a source that sends too many bytes is trimmed to what was asked
  const greedy: OpenPart<P> = async (part, from) => pieces(part.bytes.subarray(from), 500)
  assert.ok((await collect(readParts(parts, 900, 1100, greedy))).equals(whole.subarray(900, 1101)))

  // cancelling stops reading
  const ac = new AbortController()
  const gen = readParts(parts, 0, whole.length - 1, good, { signal: ac.signal })
  await gen.next()
  ac.abort()
  await assert.rejects(gen.next(), PartReadError)

  console.log('All split tests passed (' + ranges.length + ' ranges checked)')
})().catch((error) => { console.error(error); process.exit(1) })
