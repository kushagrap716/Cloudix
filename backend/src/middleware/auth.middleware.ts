import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { verifyAccessToken } from '../utils/jwt.js'

export type AuthRequest = Request & {
  user?: { id: string; sessionId: string }
}

export function resetLocalUserCache() {
  // Maintained for backward compatibility with database restore routines
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Authentication required. Please log in.'
      })
    }

    const token = authHeader.slice(7).trim()
    let payload: { sub: string; sid: string }
    try {
      payload = verifyAccessToken(token)
    } catch {
      return res.status(401).json({
        code: 'INVALID_TOKEN',
        message: 'Your session has expired or is invalid. Please log in again.'
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true }
    })

    if (!user || user.status !== 'active') {
      return res.status(401).json({
        code: 'USER_INACTIVE',
        message: 'Your account is inactive or not found.'
      })
    }

    req.user = { id: user.id, sessionId: payload.sid }
    return next()
  } catch (error) {
    return next(error)
  }
}
