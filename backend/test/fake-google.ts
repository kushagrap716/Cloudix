import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/** A fake Google Drive: resumable uploads (with Google's rules), media downloads with Range, and fault injection. */
export type Faults = { failBefore: number; loseResponse: number; expireOnce: boolean; downloadFailBefore?: number; downloadCutMidStream?: number }
type Session = { id: string; total: number; chunks: Buffer[]; committed: number; done: boolean; name: string; parents: string[] }

export async function startFakeGoogle(faults: Faults) {
  const sessions = new Map<string, Session>()
  const removed = new Set<string>()
  let base = ''
  let expired = false
  let seq = 0

  const fileData = (id: string) => {
    const s = sessions.get(id.replace(/^file-/, ''))
    return s && s.done && !removed.has(id) ? Buffer.concat(s.chunks) : null
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url!, base)

      // ---- media download
      const media = /^\/drive\/v3\/files\/([\w-]+)$/.exec(url.pathname)
      if (req.method === 'GET' && media) {
        if (Math.random() < (faults.downloadFailBefore ?? 0)) { res.writeHead(503); return res.end() }
        const data = fileData(media[1])
        if (!data) { res.writeHead(404); return res.end('not found') }
        const range = /bytes=(\d+)-(\d+)?/.exec(String(req.headers.range ?? ''))
        const a = range ? Number(range[1]) : 0
        const b = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1
        const slice = data.subarray(a, b + 1)
        res.writeHead(range ? 206 : 200, { 'Content-Length': slice.length, ...(range ? { 'Content-Range': `bytes ${a}-${b}/${data.length}` } : {}) })
        if (Math.random() < (faults.downloadCutMidStream ?? 0) && slice.length > 10) {
          res.write(slice.subarray(0, Math.floor(slice.length / 3)))
          setTimeout(() => res.destroy(), 5)
          return
        }
        return res.end(slice)
      }

      // ---- resumable upload: start
      if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
        const meta = JSON.parse(body.toString() || '{}')
        const id = `s${++seq}`
        sessions.set(id, { id, total: Number(req.headers['x-upload-content-length']), chunks: [], committed: 0, done: false, name: meta.name, parents: meta.parents })
        res.writeHead(200, { Location: `${base}/session/${id}` })
        return res.end()
      }

      // ---- resumable upload: chunks / status
      const m = /^\/session\/(\w+)$/.exec(url.pathname)
      const s = m && sessions.get(m[1])
      if (!s) { res.writeHead(404); return res.end() }
      const header = String(req.headers['content-range'])
      const range = (c: number) => (c > 0 ? { Range: `bytes=0-${c - 1}` } : {})
      const meta = () => JSON.stringify({ id: `file-${s.id}`, size: String(s.total), md5Checksum: createHash('md5').update(Buffer.concat(s.chunks)).digest('hex') })

      if (faults.expireOnce && !expired && s.committed > 0 && Math.random() < 0.3) { expired = true; sessions.delete(s.id); res.writeHead(404); return res.end() }
      if (header.startsWith('bytes */')) {
        if (s.done) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(meta()) }
        res.writeHead(308, range(s.committed)); return res.end()
      }
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(header)!
      const a = Number(match[1]); const b = Number(match[2]); const t = Number(match[3])
      const isFinal = b + 1 === t
      if (Math.random() < faults.failBefore) { res.writeHead(503); return res.end() }
      if (a !== s.committed) { res.writeHead(308, range(s.committed)); return res.end() }
      if (!isFinal && body.length % (256 * 1024) !== 0) { res.writeHead(400); return res.end('chunk not a multiple of 256 KiB') }
      s.chunks.push(body); s.committed += body.length
      if (s.committed === s.total) s.done = true
      if (Math.random() < faults.loseResponse) { res.destroy(); return }
      if (s.done) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(meta()) }
      res.writeHead(308, range(s.committed)); res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve() }))
  return {
    base,
    sessions,
    removed,
    stored: (fileId: string) => fileData(fileId),
    corrupt: (fileId: string) => { const s = sessions.get(fileId.replace(/^file-/, ''))!; s.chunks[0] = Buffer.from(s.chunks[0]); s.chunks[0][3] ^= 0xff },
    close: () => server.close(),
  }
}
