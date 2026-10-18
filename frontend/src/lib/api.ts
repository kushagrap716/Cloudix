import { clearSession, getAccessToken, getRefreshToken, setSession } from './auth'

const isProd = import.meta.env.PROD
const rawApiUrl = import.meta.env.VITE_API_URL
export const API_URL = (rawApiUrl && rawApiUrl !== 'http://localhost:4000')
  ? rawApiUrl
  : (isProd ? '/api' : 'http://localhost:4000')

type ApiOptions = RequestInit & {
  skipAuth?: boolean
}

let isRefreshing = false
let refreshSubscribers: ((token: string | null) => void)[] = []

function onRefreshed(token: string | null) {
  refreshSubscribers.forEach((cb) => cb(token))
  refreshSubscribers = []
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  // Inject Bearer token if available
  if (!options.skipAuth) {
    const token = getAccessToken()
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`)
    }
  }

  const response = await fetch(`${API_URL}${path}`, { ...options, headers })

  if (response.status === 401 && !options.skipAuth && !path.startsWith('/auth/')) {
    const refreshToken = getRefreshToken()
    if (refreshToken) {
      if (!isRefreshing) {
        isRefreshing = true
        try {
          const refreshRes = await fetch(`${API_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
          })

          if (refreshRes.ok) {
            const data = await refreshRes.json()
            setSession({ accessToken: data.accessToken })
            onRefreshed(data.accessToken)
          } else {
            clearSession()
            onRefreshed(null)
            if (window.location.pathname !== '/login' && window.location.pathname !== '/register') {
              window.location.href = '/login'
            }
          }
        } catch {
          clearSession()
          onRefreshed(null)
          if (window.location.pathname !== '/login' && window.location.pathname !== '/register') {
            window.location.href = '/login'
          }
        } finally {
          isRefreshing = false
        }
      }

      // Wait for the token refresh to finish and retry
      const newToken = await new Promise<string | null>((resolve) => {
        refreshSubscribers.push(resolve)
      })

      if (newToken) {
        headers.set('Authorization', `Bearer ${newToken}`)
        const retryResponse = await fetch(`${API_URL}${path}`, { ...options, headers })
        if (!retryResponse.ok) {
          const err = await retryResponse.json().catch(() => ({ message: retryResponse.statusText }))
          throw new Error(err.message ?? 'Request failed')
        }
        return retryResponse.json() as Promise<T>
      }
    } else {
      clearSession()
      if (window.location.pathname !== '/login' && window.location.pathname !== '/register') {
        window.location.href = '/login'
      }
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    throw new Error(error.message ?? 'Request failed')
  }

  return response.json() as Promise<T>
}

export function formatBytes(input: string | number | bigint | null | undefined) {
  if (input === null || input === undefined) return '--'
  const bytes = Number(input)
  if (!Number.isFinite(bytes)) return '--'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
