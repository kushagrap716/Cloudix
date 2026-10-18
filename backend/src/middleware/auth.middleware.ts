import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { hashPassword } from '../utils/password.js'
import { randomToken } from '../utils/crypto.js'

export type AuthRequest = Request & {
  user?: { id: string; sessionId: string }
}

const LOCAL_USER_EMAIL = 'local@cloudix.local'

let localUserId: string | null = null
let pendingLocalUser: Promise<string> | null = null

async function findOrCreateLocalUser(): Promise<string> {
  const existing = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
  if (existing) return existing.id
  try {
    const created = await prisma.user.create({
      data: { name: 'Local User', email: LOCAL_USER_EMAIL, passwordHash: await hashPassword(randomToken(32)) },
    })
    return created.id
  } catch (error) {
    // Another request created the user at the same moment: use that one.
    const raced = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
    if (raced) return raced.id
    throw error
  }
}

export function resetLocalUserCache() {
  localUserId = null
  pendingLocalUser = null
}

// No login: the app runs as one built-in local user.
// Existing installs keep their data because the oldest existing user is reused.
export async function getLocalUserId(): Promise<string> {
  if (localUserId) {
    const stillThere = await prisma.user.findUnique({ where: { id: localUserId }, select: { id: true } })
    if (stillThere) return localUserId
    localUserId = null
  }
  // Several requests arrive together on first launch; they all share one lookup.
  pendingLocalUser ??= findOrCreateLocalUser().finally(() => {
    pendingLocalUser = null
  })
  localUserId = await pendingLocalUser
  return localUserId
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    req.user = { id: await getLocalUserId(), sessionId: 'local' }
    return next()
  } catch (error) {
    return next(error)
  }
}
