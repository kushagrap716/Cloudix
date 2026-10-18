import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { FileTable } from '@/components/drive/FileTable'
import { MetricCard } from '@/components/drive/MetricCard'
import { PageHeader } from '@/components/drive/PageHeader'
import { archivedFiles } from '@/data/drive-data'

export function ArchivedPage() {
  return (
    <>
      <PageHeader title="Archived" description="Older files kept out of active workspace." actions={<><Button variant="outline"><RotateCcw className="h-4 w-4" />Restore</Button><Button variant="danger"><Trash2 className="h-4 w-4" />Delete Permanently</Button></>} />
      <Card className="mt-8 border-orange-200 bg-orange-50 p-4 text-sm text-orange-700">
        Archived files stay available and do not count as active workspace clutter.
      </Card>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <MetricCard label="Archived Items" value="3" icon={Archive} />
        <MetricCard label="Recoverable" value="3" icon={RotateCcw} />
        <MetricCard label="Storage Saved" value="2.6 MB" icon={Trash2} />
      </div>
      <FileTable files={archivedFiles} mode="archived" />
    </>
  )
}
