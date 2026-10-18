'use strict'

/**
 * Turns whatever the user typed into a clean backend base URL, or returns null if it is not usable.
 *   "localhost:4000"            -> "http://localhost:4000"
 *   "https://drive.me/api/"     -> "https://drive.me/api"
 *   "ftp://x" / "" / garbage    -> null
 */
function normalizeServerUrl(input) {
  if (typeof input !== 'string') return null
  let value = input.trim()
  if (!value) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'http://' + value

  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null

  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** Accepts mysql:// URLs only (that is what the backend's Prisma schema uses). */
function normalizeDatabaseUrl(input) {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!/^mysql:\/\/[^\s]+$/i.test(value)) return null
  try {
    const url = new URL(value)
    if (!url.hostname || url.pathname.length < 2) return null
  } catch {
    return null
  }
  return value
}

module.exports = { normalizeServerUrl, normalizeDatabaseUrl }
