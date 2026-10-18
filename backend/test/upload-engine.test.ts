import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { applyChunk, currentOffset, OffsetMismatchError, refreshProgress, type EnginePart } from '../src/modules/split/chunk-engine.js'
import { createGoogleUploader } from '../src/modules/split/google-parts.js'
import { readParts, type ReadablePart } from '../src/modules/split/read-parts.js'
import { startFakeGoogle } from './fake-google.js'

// shared fake Google Drive lives in ./fake-google.ts

function makeParts(sizes: number[]): EnginePart[] {
  let start = 0
  return sizes.map((size, index) => { const p: EnginePart = { id: `p${index}`, index, accountId: `acc${index}`, start, size, uploaded: 0, status: 'pending', sessionUri: null, providerFileId: null, md5: null }; start += size; return p })
}

async function upload(original: Buffer, partSizes: number[], clientChunk: number, faults: { failBefore: number; loseResponse: number; expireOnce: boolean }, opts: { duplicateEvery?: number } = {}) {
  const google = await startFakeGoogle(faults)
  const parts = makeParts(partSizes)
  const uploader = createGoogleUploader({
    getAccessToken: async () => 'tok', getPartsFolderId: async () => 'folder', partName: (p) => `x.part${p.index}`, fileId: 'file-1',
    baseUrl: google.base, sleep: async () => undefined, maxAttempts: 6,
  })
  const persist = async () => undefined
  let offset = 0
  let complete = false
  let rounds = 0
  while (!complete) {
    rounds += 1
    assert.ok(rounds < 2000, 'upload did not finish')
    const end = Math.min(offset + clientChunk, original.length)
    try {
      const out = await applyChunk(parts, offset, original.subarray(offset, end), uploader, persist)
      offset = out.offset
      complete = out.complete
      if (opts.duplicateEvery && rounds % opts.duplicateEvery === 0 && !complete) {
        // client re-sends an older chunk (e.g. it never saw the response)
        const back = Math.max(0, offset - clientChunk)
        const again = await applyChunk(parts, back, original.subarray(back, Math.min(back + clientChunk, original.length)), uploader, persist)
        assert.equal(again.offset, offset)
      }
    } catch (error) {
      // like the real client: ask where to continue and carry on
      if (error instanceof OffsetMismatchError) { offset = error.expectedOffset; continue }
      if ((error as { status?: number }).status === 503) { await refreshProgress(parts, uploader, persist); offset = currentOffset(parts); continue }
      throw error
    }
  }
  // what Google stored, in order, must be the original, byte for byte
  const stored = parts.map((p) => Buffer.concat(google.sessions.get(p.sessionUri!.split('/').pop()!)!.chunks))
  assert.ok(Buffer.concat(stored).equals(original), 'reassembled bytes differ from the original')
  for (const p of parts) {
    assert.equal(p.status, 'complete'); assert.equal(p.uploaded, p.size)
    assert.equal(p.md5, createHash('md5').update(original.subarray(p.start, p.start + p.size)).digest('hex'))
  }
  // and the downloader reads it back identically (whole file + a range that crosses two parts)
  const readable: Array<ReadablePart & { data: Buffer }> = parts.map((p, i) => ({ index: p.index, start: p.start, size: p.size, md5: p.md5, data: stored[i] }))
  const open = async (part: (typeof readable)[number], from: number, to: number) => (async function* () { yield part.data.subarray(from, to + 1) })()
  const back = []
  for await (const c of readParts(readable, 0, original.length - 1, open)) back.push(c)
  assert.ok(Buffer.concat(back).equals(original))
  google.close()
  return rounds
}

;(async () => {
  const KiB = 1024
  const original = randomBytes(5 * 1024 * KiB + 12345) // 5 MiB and a bit, not aligned to anything
  const noFaults = { failBefore: 0, loseResponse: 0, expireOnce: false }
  const partSizes = [Math.floor(1.3 * 1024 * KiB), 2 * 1024 * KiB, 0]
  partSizes[2] = original.length - partSizes[0] - partSizes[1]

  // clean run; client chunks (640 KiB) deliberately do not line up with part boundaries
  console.log('clean            rounds:', await upload(original, partSizes, 640 * KiB, noFaults))
  // tiny and huge client chunks
  await upload(original, partSizes, 256 * KiB, noFaults)
  await upload(original, partSizes, 3 * 1024 * KiB, noFaults)
  // duplicate chunks re-sent
  await upload(original, partSizes, 640 * KiB, noFaults, { duplicateEvery: 2 })
  // flaky network: 25% requests fail before storing, 15% store but lose the response
  for (let i = 0; i < 5; i += 1) await upload(original, partSizes, 640 * KiB, { failBefore: 0.25, loseResponse: 0.15, expireOnce: false })
  // a session that expires in the middle of a part
  for (let i = 0; i < 5; i += 1) await upload(original, partSizes, 640 * KiB, { failBefore: 0.1, loseResponse: 0.1, expireOnce: true })
  // one-byte-short and exact-boundary parts
  await upload(original, [original.length], 640 * KiB, noFaults)
  await upload(original, [512 * KiB, original.length - 512 * KiB], 512 * KiB, noFaults)

  // skipping ahead is refused with the right position
  const parts = makeParts([1000, 1000])
  const google = await startFakeGoogle(noFaults)
  const uploader = createGoogleUploader({ getAccessToken: async () => 't', getPartsFolderId: async () => 'f', partName: () => 'n', fileId: 'f', baseUrl: google.base, sleep: async () => undefined })
  await assert.rejects(applyChunk(parts, 500, Buffer.alloc(100), uploader, async () => undefined), (e: unknown) => e instanceof OffsetMismatchError && e.expectedOffset === 0)
  google.close()

  console.log('All upload-engine tests passed')
})().catch((error) => { console.error(error); process.exit(1) })
