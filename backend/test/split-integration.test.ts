/**
 * End-to-end test of the split-file feature: real service code, fake database, fake Google Drive.
 * Run with: node --experimental-test-module-mocks --import tsx test/split-integration.test.ts
 */
process.env.DATABASE_URL = 'mysql://x'
process.env.FRONTEND_URL = 'http://localhost'
process.env.JWT_ACCESS_SECRET = 'j'.repeat(40)
process.env.TOKEN_ENCRYPTION_KEY = 'k'.repeat(40)

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { mock } from 'node:test'
import express from 'express'
import { startFakeGoogle } from './fake-google.js'

type Row = Record<string, any>
const MiB = 1024 * 1024

// ------------------------------------------------------------------ fake database
const files = new Map<string, Row>()
const parts = new Map<string, Row>()
const sessions = new Map<string, Row>()
const accounts = new Map<string, Row>()

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'file') return matches(files.get(row.fileId) ?? {}, cond)
    const value = row[key]
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && typeof cond !== 'bigint') {
      if ('in' in cond) return cond.in.includes(value)
      if ('not' in cond) return value !== cond.not
      if ('lt' in cond) return value < cond.lt
      return false
    }
    return value === cond
  })
}
const list = (table: Map<string, Row>, where?: Row) => [...table.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }))
const one = (table: Map<string, Row>, where: Row) => { const r = [...table.values()].find((x) => matches(x, where)); if (!r) throw new Error('Record not found'); return r }

const fakePrisma: any = {
  connectedAccount: { findMany: async ({ where, include }: any) => list(accounts, where).map((a) => ({ ...a, ...(include?.storageAccount ? { storageAccount: a.storageAccount } : {}) })) },
  filePart: {
    findMany: async ({ where, orderBy }: any) => { const r = list(parts, where); if (orderBy?.partIndex) r.sort((a, b) => a.partIndex - b.partIndex); return r },
    update: async ({ where, data }: any) => Object.assign(one(parts, where), data),
    delete: async ({ where }: any) => { const r = one(parts, where); parts.delete(r.id); return r },
    createMany: async ({ data }: any) => { for (const d of data) { const id = randomUUID(); parts.set(id, { id, uploadedBytes: 0n, status: 'pending', googleSessionUri: null, providerFileId: null, md5Checksum: null, ...d }) } },
  },
  file: {
    create: async ({ data }: any) => { const r = { createdAt: new Date(), ...data }; files.set(r.id, r); return { ...r } },
    update: async ({ where, data }: any) => ({ ...Object.assign(one(files, where), data) }),
    findUniqueOrThrow: async ({ where }: any) => ({ ...one(files, where) }),
    findMany: async ({ where }: any) => list(files, where),
    delete: async ({ where }: any) => { const r = one(files, where); files.delete(r.id); return r },
  },
  uploadSession: {
    create: async ({ data }: any) => { const r = { id: randomUUID(), createdAt: new Date(), errorMessage: null, completedAt: null, ...data }; sessions.set(r.id, r); return { ...r } },
    update: async ({ where, data }: any) => ({ ...Object.assign(one(sessions, where), data) }),
    updateMany: async ({ where, data }: any) => { for (const r of sessions.values()) if (matches(r, where)) Object.assign(r, data) },
  },
  auditLog: { create: async () => ({}) },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg)),
}

// ------------------------------------------------------------------ fake google libraries
const deletedFromDrive: string[] = []
let google: Awaited<ReturnType<typeof startFakeGoogle>>

;(async () => {
  const faults = { failBefore: 0, loseResponse: 0, expireOnce: false, downloadFailBefore: 0, downloadCutMidStream: 0 }
  google = await startFakeGoogle(faults)
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: any, init?: any) => realFetch(String(input).replace('https://www.googleapis.com', google.base), init)) as typeof fetch

  const src = (p: string) => pathToFileURL(path.resolve(__dirname, '../src', p)).href
  mock.module(src('config/prisma.ts'), { namedExports: { prisma: fakePrisma } })
  mock.module(src('modules/google/google.service.ts'), {
    namedExports: {
      getAuthedGoogleClient: async () => ({ getAccessToken: async () => ({ token: 'tok' }), getRequestHeaders: async () => ({ Authorization: 'Bearer tok' }) }),
      ensureGoogleAppFolder: async () => 'appfolder',
      syncGoogleQuota: async () => ({}),
    },
  })
  mock.module('googleapis', {
    namedExports: {
      google: {
        drive: () => ({
          files: {
            list: async () => ({ data: { files: [{ id: 'partsfolder' }] } }),
            create: async () => ({ data: { id: 'partsfolder' } }),
            delete: async ({ fileId }: { fileId: string }) => {
              if (google.removed.has(fileId)) throw Object.assign(new Error('not found'), { code: 404 })
              google.removed.add(fileId); deletedFromDrive.push(fileId)
            },
          },
        }),
      },
    },
  })

  const service = await import('../src/modules/split/split.service.js')
  const { streamSplitFile } = await import('../src/modules/files/stream-split-file.js')

  // four connected drives, each with only a few MiB usable (16 MiB safety margin is kept by the planner)
  const usable = [5, 4, 4, 3]
  usable.forEach((u, i) => accounts.set(`acc${i}`, { id: `acc${i}`, userId: 'user1', provider: 'google_drive', status: 'connected', storageAccount: { availableBytes: BigInt((16 + u) * MiB) } }))

  // ------------------------------------------------------------------ 1. planning
  const original = randomBytes(9 * MiB + 12345)
  const mime = 'video/mp4'
  assert.equal(await service.tryCreateSplitUpload({ userId: 'user1', fileName: 'big.mp4', mimeType: mime, sizeBytes: BigInt(200 * MiB), folderId: null }), null, 'a file bigger than all drives together must be refused')
  assert.equal(files.size, 0, 'a refused upload must not leave rows behind')

  const created = (await service.tryCreateSplitUpload({ userId: 'user1', fileName: 'big.mp4', mimeType: mime, sizeBytes: BigInt(original.length), folderId: null }))!
  assert.ok(created.partCount >= 3)
  const fileRow = [...files.values()][0]
  assert.equal(fileRow.status, 'uploading'); assert.equal(fileRow.provider, 'split')
  const partRows = list(parts).sort((a, b) => a.partIndex - b.partIndex)
  assert.equal(new Set(partRows.map((p) => p.connectedAccountId)).size, partRows.length)
  assert.equal(partRows.reduce((s, p) => s + p.sizeBytes, 0n), BigInt(original.length))

  // ------------------------------------------------------------------ 2. upload through faults, with resume from status
  Object.assign(faults, { failBefore: 0.2, loseResponse: 0.1, expireOnce: true })
  let session = created.session
  let offset = 0
  let rounds = 0
  let usedStatusResume = false
  while (true) {
    assert.ok(++rounds < 500, 'upload did not finish')
    session = { ...sessions.get(session.id)! } as any
    const end = Math.min(offset + 5 * MiB / 8, original.length) // 640 KiB client chunks
    try {
      const out = await service.handleSplitChunk(session as any, 'user1', offset, original.subarray(offset, end))
      if (out.status === 'completed') break
      offset = Number(out.offset)
      if (rounds === 3) { // pretend the browser was closed: ask the server where to continue
        const st = await service.getSplitStatus(sessions.get(session.id)! as any, 'user1')
        assert.equal(st.status, 'uploading'); offset = Number(st.offset); usedStatusResume = true
      }
    } catch (error) {
      const st = await service.getSplitStatus(sessions.get(session.id)! as any, 'user1')
      offset = Number(st.offset)
    }
  }
  assert.ok(usedStatusResume)
  Object.assign(faults, { failBefore: 0, loseResponse: 0, expireOnce: false })
  assert.equal([...files.values()][0].status, 'active')
  assert.equal(sessions.get(session.id)!.status, 'completed')
  const finalParts = list(parts).sort((a, b) => a.partIndex - b.partIndex)
  assert.ok(finalParts.every((p) => p.status === 'complete' && p.providerFileId && p.md5Checksum))
  assert.ok(Buffer.concat(finalParts.map((p) => google.stored(p.providerFileId)!)).equals(original), 'what Google holds differs from the upload')

  // ------------------------------------------------------------------ 3. downloads through a real express app
  const app = express()
  app.get('/dl', async (req, res) => { await streamSplitFile({ ...[...files.values()][0] } as any, req.headers.range, res, { disposition: 'attachment' }) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dl`
  const get = (range?: string) => realFetch(url, { headers: range ? { Range: range } : {} })

  let r = await get()
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-length'), String(original.length))
  assert.match(r.headers.get('content-disposition')!, /attachment; filename="big.mp4"/)
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(original), 'full download differs from the original')

  const edges: number[] = []
  for (const p of finalParts) edges.push(Number(p.startByte), Number(p.startByte) + Number(p.sizeBytes) - 1, Number(p.startByte) - 1)
  const ranges: Array<[number, number]> = []
  for (const a of edges) for (const b of edges) if (a >= 0 && b >= a && b < original.length) ranges.push([a, b])
  for (let i = 0; i < 25; i += 1) { const a = Math.floor(Math.random() * original.length); ranges.push([a, a + Math.floor(Math.random() * (original.length - a))]) }
  for (const [a, b] of ranges) {
    r = await get(`bytes=${a}-${b}`)
    assert.equal(r.status, 206, `range ${a}-${b}`)
    assert.equal(r.headers.get('content-range'), `bytes ${a}-${b}/${original.length}`)
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(original.subarray(a, b + 1)), `range ${a}-${b} bytes differ`)
  }
  r = await get('bytes=-1000'); assert.ok(Buffer.from(await r.arrayBuffer()).equals(original.subarray(original.length - 1000)))
  r = await get(`bytes=${original.length}-`); assert.equal(r.status, 416); await r.arrayBuffer()

  // flaky Google while downloading: still byte-exact
  Object.assign(faults, { downloadFailBefore: 0.25, downloadCutMidStream: 0.2 })
  // Every download must be byte-exact (200) or fail visibly (502 / aborted connection). A 200 with wrong bytes is the one outcome that is never allowed.
  let exact = 0
  for (let i = 0; i < 6; i += 1) {
    try {
      r = await get()
      const got = Buffer.from(await r.arrayBuffer())
      if (r.status === 200) { assert.ok(got.equals(original), 'WRONG BYTES delivered with status 200'); exact += 1 } else assert.equal(r.status, 502)
    } catch (error) { if ((error as Error).name === 'AssertionError') throw error }
  }
  assert.ok(exact >= 1, 'no flaky download succeeded at all')
  Object.assign(faults, { downloadFailBefore: 0, downloadCutMidStream: 0 })

  // ------------------------------------------------------------------ 4. damage is detected, never delivered as a "complete" file
  const middle = finalParts[1].providerFileId
  google.corrupt(middle)
  await assert.rejects(async () => { const x = await get(); await x.arrayBuffer() }, 'a corrupted part must abort the download')
  r = await get(`bytes=0-99`); assert.equal(r.status, 206); await r.arrayBuffer() // untouched part still readable
  google.corrupt(middle) // flip back

  google.removed.add(finalParts[0].providerFileId) // first part vanished from the drive
  r = await get(); assert.equal(r.status, 502); assert.equal((await r.json() as any).code, 'SPLIT_FILE_READ_FAILED')
  google.removed.delete(finalParts[0].providerFileId)
  google.removed.add(middle) // a later part vanished
  await assert.rejects(async () => { const x = await get(); await x.arrayBuffer() })
  google.removed.delete(middle)
  r = await get(); assert.ok(Buffer.from(await r.arrayBuffer()).equals(original), 'download works again once the parts are back')

  const brokenRow = { ...[...files.values()][0] }
  const saved = list(parts)[0]; parts.delete(saved.id) // a part row lost from the database
  r = await realFetch(url); assert.equal(r.status, 500); assert.equal((await r.json() as any).code, 'SPLIT_FILE_INCOMPLETE')
  parts.set(saved.id, saved)
  void brokenRow
  server.close()

  // ------------------------------------------------------------------ 5. delete removes every part from every drive
  const ids = finalParts.map((p) => p.providerFileId)
  const gone = await service.deleteSplitParts(fileRow.id)
  assert.deepEqual(gone.failed, [])
  assert.equal(list(parts, { fileId: fileRow.id }).length, 0)
  for (const id of ids) assert.ok(google.removed.has(id) && deletedFromDrive.includes(id), `part ${id} not deleted from the drive`)
  assert.equal(new Set(gone.touchedAccountIds).size, ids.length)

  // ------------------------------------------------------------------ 6. abandoned uploads are cleaned up
  const abandoned = (await service.tryCreateSplitUpload({ userId: 'user1', fileName: 'half.bin', mimeType: 'application/octet-stream', sizeBytes: BigInt(original.length), folderId: null }))!
  const half = await service.handleSplitChunk(abandoned.session as any, 'user1', 0, original.subarray(0, 5 * MiB)) // fills (and completes) the first part
  assert.equal(half.status, 'uploading')
  const abandonedFile = [...files.values()].find((f) => f.name === 'half.bin')!
  assert.equal(await service.cleanupStaleSplitUploads(), 0, 'recent uploads must be left alone')
  abandonedFile.createdAt = new Date(Date.now() - 72 * 3600_000)
  assert.equal(await service.cleanupStaleSplitUploads(), 1)
  assert.equal(files.has(abandonedFile.id), false)
  assert.equal(list(parts, { fileId: abandonedFile.id }).length, 0)
  assert.equal(sessions.get(abandoned.session.id)!.status, 'failed')

  console.log(`All split integration tests passed (${ranges.length} ranges, ${rounds} upload rounds with faults)`)
  google.close()
  process.exit(0)
})().catch((error) => { console.error(error); process.exit(1) })
