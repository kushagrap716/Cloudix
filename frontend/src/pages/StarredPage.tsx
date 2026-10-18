import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { MetricCard } from '@/components/drive/MetricCard'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch, formatBytes, formatDate } from '@/lib/api'
import { useDriveAutoSync } from '@/lib/useDriveAutoSync'

type StarredFile = {
  id: string
  name: string
  sizeBytes: string
  starredAt: string | null
  connectedAccount?: { email: string } | null
  folder?: { name: string } | null
}

export function StarredPage() {
  const [files, setFiles] = useState<StarredFile[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  async function load() {
    try {
      const data = await apiFetch<{ files: StarredFile[] }>('/files?starred=true')
      setFiles(data.files)
      setMessage('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to load starred files')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  useDriveAutoSync(load)

  async function removeStar(file: StarredFile) {
    try {
      await apiFetch(`/files/${file.id}`, { method: 'PATCH', body: JSON.stringify({ starred: false }) })
      setFiles((current) => current.filter((item) => item.id !== file.id))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to remove star')
    }
  }

  return (
    <>
      <PageHeader title="Starred" description="Pinned files for quick access. Right-click a file in All Files and choose Add Star." />
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <MetricCard label="Starred Files" value={String(files.length)} icon={Star} />
      </div>
      {message ? <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{message}</p> : null}
      <Card className="mt-8 overflow-hidden">
        {loading ? (
          <p className="p-5 text-sm text-slate-500">Loading...</p>
        ) : files.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">No starred files yet. In All Files, right-click a file and choose Add Star.</p>
        ) : (
          <ul className="divide-y divide-slate-200/10">
            {files.map((file) => (
              <li key={file.id} className="flex items-center gap-3 p-4">
                <Star className="h-4 w-4 shrink-0 fill-yellow-400 text-yellow-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold" title={file.name}>{file.name}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {formatBytes(file.sizeBytes)}
                    {file.folder?.name ? ` · ${file.folder.name}` : ''}
                    {file.connectedAccount?.email ? ` · ${file.connectedAccount.email}` : ''}
                    {file.starredAt ? ` · starred ${formatDate(file.starredAt)}` : ''}
                  </p>
                </div>
                <Button variant="soft" size="sm" onClick={() => removeStar(file)}>Remove star</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
