import { useEffect, useRef } from 'react'
import { apiFetch } from '@/lib/api'

export type DriveSyncResult = {
  created: number
  updated: number
  deleted: number
  foldersCreated?: number
  foldersUpdated?: number
  foldersRemoved?: number
}

export const driveSyncChanged = (r: DriveSyncResult) =>
  r.created + r.updated + r.deleted + (r.foldersCreated ?? 0) + (r.foldersUpdated ?? 0) + (r.foldersRemoved ?? 0) > 0

/** Shared by every page and the manual Sync button so two syncs never run at the same time. */
export const driveSyncState = { busy: false, lastRunAt: 0 }

const INTERVAL_MS = 60_000
const MIN_GAP_MS = 20_000

/**
 * Keeps a page in step with Google Drive: syncs when the page opens, when the window regains focus
 * and every minute. `onChanged` runs only when the sync actually changed something, so the page can reload its list.
 * Errors are silent here; the Sync button on All Files reports them.
 */
export function useDriveAutoSync(onChanged: () => void | Promise<void>) {
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  useEffect(() => {
    let disposed = false

    async function autoSync() {
      if (driveSyncState.busy || document.hidden || Date.now() - driveSyncState.lastRunAt < MIN_GAP_MS) return
      driveSyncState.busy = true
      driveSyncState.lastRunAt = Date.now()
      try {
        const response = await apiFetch<{ results: DriveSyncResult[] }>('/files/sync-google', { method: 'POST', body: JSON.stringify({}) })
        if (!disposed && response.results.some(driveSyncChanged)) {
          await onChangedRef.current()
          window.dispatchEvent(new Event('cloudix:storage-changed'))
        }
      } catch {
        // silent
      } finally {
        driveSyncState.busy = false
      }
    }

    autoSync()
    const timer = window.setInterval(autoSync, INTERVAL_MS)
    window.addEventListener('focus', autoSync)
    document.addEventListener('visibilitychange', autoSync)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', autoSync)
      document.removeEventListener('visibilitychange', autoSync)
    }
  }, [])
}
