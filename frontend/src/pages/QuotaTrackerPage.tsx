import { useEffect, useMemo, useState } from 'react'
import { CheckCircle, ChevronDown, Cloud, Database, Filter, Gauge, Link2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch, formatBytes } from '@/lib/api'
import { cn } from '@/lib/utils'

type StorageSummary = { totalBytes: string; usedBytes: string; availableBytes: string }
type ConnectedAccount = { id: string; email: string; displayName?: string | null; provider: string; status: string; storageAccount?: { totalBytes: string | null; usedBytes: string; availableBytes: string | null; lastSyncedAt: string | null } | null }
type RoutingMode = 'most_available' | 'round_robin' | 'priority'
type RoutingPolicy = { mode: RoutingMode; priorityAccountIds: string[]; roundRobinCursor: number }

function providerLabel(provider: string) {
  if (provider === 's3') return 'S3 Storage'
  return 'Google Drive'
}

function ProviderIcon({ provider }: { provider: string }) {
  const Icon = provider === 's3' ? Database : Cloud
  return <Icon className="h-6 w-6" />
}

function storageLimitLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.totalBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.totalBytes)
}

function availableLabel(account: ConnectedAccount) {
  if (account.provider === 's3' && account.storageAccount?.availableBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.availableBytes)
}

function pct(account: ConnectedAccount) {
  const total = Number(account.storageAccount?.totalBytes ?? 0)
  const used = Number(account.storageAccount?.usedBytes ?? 0)
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
}

function statusColor(percent: number) {
  if (percent >= 80) return 'bg-red-500 text-red-600'
  if (percent >= 50) return 'bg-yellow-400 text-yellow-600'
  return 'bg-emerald-500 text-emerald-600'
}

export function QuotaTrackerPage() {
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [routingPolicy, setRoutingPolicy] = useState<RoutingPolicy>({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
  const [message, setMessage] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null)
  const [providerFilter, setProviderFilter] = useState('all')
  const [accountFilter, setAccountFilter] = useState('all')
  const [sortBy, setSortBy] = useState<'most_available' | 'most_used' | 'name'>('most_available')

  async function load() {
    const [summaryData, accountData, policyData] = await Promise.all([
      apiFetch<StorageSummary>('/storage/summary'),
      apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts'),
      apiFetch<{ policy: RoutingPolicy }>('/storage/routing-policy'),
    ])
    setSummary(summaryData)
    setAccounts(accountData.accounts)
    setRoutingPolicy(policyData.policy)
  }

  async function refresh() {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to load quota tracker'))
  }, [])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => load().catch(() => undefined), 35_000)
    return () => window.clearInterval(timer)
  }, [autoRefresh])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.data?.type !== 'GOOGLE_CONNECTED') return
      setMessage(event.data.status === 'success' ? 'Google Drive connected.' : 'Google Drive connection failed.')
      load().catch(() => undefined)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  async function connectDrive() {
    const popup = window.open('', 'google-drive-connect', 'width=540,height=720')
    if (popup) {
      popup.document.write('<html><head><title>Connecting...</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#64748b;}</style></head><body><div style="text-align:center;"><h2>Connecting to Google...</h2><p>Please wait while we redirect you.</p></div></body></html>')
    }
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      if (popup) {
        popup.location.href = data.url
      } else {
        window.location.href = data.url
      }
    } catch (e) {
      if (popup) popup.close()
      console.error('Failed to start Google Drive connection from Quota Tracker', e)
    }
  }

  async function sync(accountId: string) {
    setSyncingAccountId(accountId)
    try {
      await apiFetch(`/connected-accounts/${accountId}/sync-quota`, { method: 'POST' })
      await load()
    } finally {
      setSyncingAccountId(null)
    }
  }

  async function saveRoutingPolicy(nextPolicy: RoutingPolicy) {
    setRoutingPolicy(nextPolicy)
    const data = await apiFetch<{ policy: RoutingPolicy }>('/storage/routing-policy', { method: 'PATCH', body: JSON.stringify({ mode: nextPolicy.mode, priorityAccountIds: nextPolicy.priorityAccountIds }) })
    setRoutingPolicy(data.policy)
    setMessage('Upload routing policy updated.')
  }

  function orderedAccounts() {
    const byId = new Map(accounts.map((account) => [account.id, account]))
    const ordered = routingPolicy.priorityAccountIds.map((id) => byId.get(id)).filter((account): account is ConnectedAccount => Boolean(account))
    const orderedIds = new Set(ordered.map((account) => account.id))
    return [...ordered, ...accounts.filter((account) => !orderedIds.has(account.id))]
  }

  function moveAccount(accountId: string, direction: -1 | 1) {
    const ids = orderedAccounts().map((account) => account.id)
    const index = ids.indexOf(accountId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    const nextIds = [...ids]
    const [item] = nextIds.splice(index, 1)
    nextIds.splice(target, 0, item)
    saveRoutingPolicy({ ...routingPolicy, priorityAccountIds: nextIds }).catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to update routing policy'))
  }

  async function toggleAutoRefresh() {
    const next = !autoRefresh
    setAutoRefresh(next)
    if (next) {
      setMessage('Auto-refresh enabled (updating every 35s).')
      await refresh()
    } else {
      setMessage('Auto-refresh disabled.')
    }
  }

  const filteredAccounts = useMemo(() => {
    let list = [...accounts]
    if (providerFilter !== 'all') {
      list = list.filter((a) => a.provider === providerFilter)
    }
    if (accountFilter !== 'all') {
      list = list.filter((a) => a.id === accountFilter)
    }
    if (sortBy === 'most_available') {
      list.sort((a, b) => {
        const aFree = BigInt(a.storageAccount?.availableBytes || '0')
        const bFree = BigInt(b.storageAccount?.availableBytes || '0')
        return bFree > aFree ? 1 : bFree < aFree ? -1 : 0
      })
    } else if (sortBy === 'most_used') {
      list.sort((a, b) => {
        const aUsed = BigInt(a.storageAccount?.usedBytes || '0')
        const bUsed = BigInt(b.storageAccount?.usedBytes || '0')
        return bUsed > aUsed ? 1 : bUsed < aUsed ? -1 : 0
      })
    } else if (sortBy === 'name') {
      list.sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email))
    }
    return list
  }, [accounts, providerFilter, accountFilter, sortBy])

  return (
    <>
      <PageHeader
        title="Quota Tracker"
        description="Track and manage connected provider storage limits."
        actions={
          <>
            <Button
              variant={autoRefresh ? 'default' : 'outline'}
              onClick={toggleAutoRefresh}
              className={cn(
                'transition-all',
                autoRefresh
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600 shadow-sm shadow-emerald-600/20'
                  : ''
              )}
            >
              {autoRefresh ? (
                <span className="relative flex h-2 w-2 mr-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-200 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                </span>
              ) : (
                <CheckCircle className="h-4 w-4" />
              )}
              Auto-refresh {autoRefresh ? 'On' : 'Off'}
            </Button>
            <Button variant="outline" onClick={refresh} disabled={refreshing}>
              <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </Button>
            <Button onClick={connectDrive}>
              <Link2 className="h-4 w-4" />Connect Drive
            </Button>
          </>
        }
      />
      {message ? <p className="mt-5 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}

      <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        <Card className="p-5"><p className="text-sm text-slate-500">Total Storage</p><p className="mt-2 text-2xl font-extrabold">{formatBytes(summary?.totalBytes)}</p></Card>
        <Card className="p-5"><p className="text-sm text-slate-500">Used Storage</p><p className="mt-2 text-2xl font-extrabold">{formatBytes(summary?.usedBytes)}</p></Card>
        <Card className="p-5"><p className="text-sm text-slate-500">Available</p><p className="mt-2 text-2xl font-extrabold">{formatBytes(summary?.availableBytes)}</p></Card>
        <Card className="p-5"><p className="text-sm text-slate-500">Accounts</p><p className="mt-2 text-2xl font-extrabold">{accounts.length}</p></Card>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        {/* Provider Filter */}
        <div className="relative inline-block">
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="h-11 appearance-none rounded-xl border border-slate-200 bg-white pl-9 pr-8 text-sm font-semibold text-slate-950 shadow-sm transition-all hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100"
          >
            <option value="all">All Providers</option>
            <option value="google_drive">Google Drive</option>
            <option value="s3">S3 Storage</option>
          </select>
          <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>

        {/* Account Filter */}
        <div className="relative inline-block">
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="h-11 appearance-none rounded-xl border border-slate-200 bg-white pl-4 pr-8 text-sm font-semibold text-slate-950 shadow-sm transition-all hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100"
          >
            <option value="all">All Accounts</option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.displayName || acc.email}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>

        {/* Sort Filter */}
        <div className="relative inline-block">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="h-11 appearance-none rounded-xl border border-slate-200 bg-slate-100 pl-9 pr-8 text-sm font-semibold text-slate-950 shadow-sm transition-all hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
          >
            <option value="most_available">Most available</option>
            <option value="most_used">Most used</option>
            <option value="name">Account name</option>
          </select>
          <Gauge className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>

        {(providerFilter !== 'all' || accountFilter !== 'all' || sortBy !== 'most_available') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setProviderFilter('all')
              setAccountFilter('all')
              setSortBy('most_available')
            }}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            Reset filters
          </Button>
        )}
      </div>

      <Card className="mt-6 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-extrabold">Upload Routing</h2>
            <p className="mt-1 text-sm text-slate-500">Choose how new uploads pick connected storage accounts.</p>
          </div>
          <label className="grid gap-2 text-sm font-semibold lg:w-64">Routing mode<select className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm" value={routingPolicy.mode} onChange={(event) => saveRoutingPolicy({ ...routingPolicy, mode: event.target.value as RoutingMode }).catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to update routing policy'))}><option value="most_available">Most available</option><option value="round_robin">Round robin</option><option value="priority">Priority order</option></select></label>
        </div>
        <div className="mt-4 grid gap-3">
          {orderedAccounts().map((account, index) => <div key={account.id} className="flex flex-col gap-3 rounded-xl bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-blue-600"><ProviderIcon provider={account.provider} /></div>
              <div><p className="font-semibold">{account.displayName || account.email}</p><p className="text-sm text-slate-500">{providerLabel(account.provider)} · {formatBytes(account.storageAccount?.usedBytes)} used · {availableLabel(account)} free</p></div>
            </div>
            <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => moveAccount(account.id, -1)} disabled={index === 0}>Up</Button><Button variant="outline" size="sm" onClick={() => moveAccount(account.id, 1)} disabled={index === accounts.length - 1}>Down</Button></div>
          </div>)}
          {accounts.length === 0 ? <p className="text-sm text-slate-500">Connect storage accounts to configure routing.</p> : null}
        </div>
      </Card>

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        {filteredAccounts.length === 0 ? (
          <Card className="col-span-full p-8 text-center">
            <Cloud className="mx-auto h-10 w-10 text-blue-600" />
            <h2 className="mt-4 text-xl font-extrabold">
              {accounts.length === 0 ? 'No connected drives' : 'No matching drives found'}
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              {accounts.length === 0
                ? 'Connect Google Drive or S3-compatible storage to start tracking quota.'
                : 'Try clearing your filter criteria to see all connected drives.'}
            </p>
            {accounts.length === 0 ? (
              <Button className="mt-5" onClick={connectDrive}><Link2 className="h-4 w-4" />Connect Drive</Button>
            ) : (
              <Button
                className="mt-5"
                variant="outline"
                onClick={() => {
                  setProviderFilter('all')
                  setAccountFilter('all')
                  setSortBy('most_available')
                }}
              >
                Clear Filters
              </Button>
            )}
          </Card>
        ) : filteredAccounts.map((account) => {
          const percent = pct(account)
          const color = statusColor(percent)
          return (
            <Card key={account.id} className="overflow-hidden p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white"><ProviderIcon provider={account.provider} /></div>
                  <div><h2 className="font-extrabold">{providerLabel(account.provider)}</h2><p className="text-sm text-slate-500">{account.email}</p></div>
                </div>
                <div className="flex gap-2"><Button variant="outline" size="icon" onClick={() => sync(account.id)} disabled={syncingAccountId === account.id}><RefreshCw className={syncingAccountId === account.id ? 'h-5 w-5 animate-spin' : 'h-5 w-5'} /></Button></div>
              </div>
              {account.status === 'needs_reconnect' && (
                <div className="mt-3 flex items-center justify-between rounded-xl bg-amber-500/15 p-2.5 text-xs text-amber-800 dark:text-amber-200 border border-amber-500/30">
                  <span className="font-semibold">⚠️ Needs reconnection</span>
                  <Button size="sm" onClick={connectDrive} className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white">Reconnect</Button>
                </div>
              )}
              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-semibold"><span className={cn('h-3 w-3 rounded-full', color.split(' ')[0])} />storage</span>
                  <span className="font-bold">{percent}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100"><div className={cn('h-full rounded-full', color.split(' ')[0])} style={{ width: `${percent}%` }} /></div>
                <div className="mt-3 flex items-center justify-between text-sm text-slate-500"><span>{formatBytes(account.storageAccount?.usedBytes)} / {storageLimitLabel(account)}</span><span>Available {availableLabel(account)}</span></div>
              </div>
            </Card>
          )
        })}
      </div>
    </>
  )
}
