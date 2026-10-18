import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { hashPassword, verifyPassword } from '../../utils/password.js'
import { randomToken, hashToken } from '../../utils/crypto.js'
import { signAccessToken } from '../../utils/jwt.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'

export const authRouter = Router()

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(191),
  email: z.string().trim().toLowerCase().email('Invalid email address').max(191),
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
})

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
})

// Register a new user
authRouter.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = registerSchema.parse(req.body)

    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (existingUser) {
      return res.status(400).json({
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'An account with this email already exists.',
      })
    }

    const passwordHash = await hashPassword(password)
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        status: 'active',
      },
      select: { id: true, name: true, email: true, status: true },
    })

    // Create session
    const rawRefreshToken = randomToken(48)
    const refreshTokenHash = hashToken(rawRefreshToken)
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400 * 1000)

    const session = await prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        userAgent: req.headers['user-agent']?.slice(0, 500) || null,
        ipAddress: (req.ip || req.socket.remoteAddress || '').slice(0, 64) || null,
        expiresAt,
      },
    })

    const accessToken = signAccessToken({ sub: user.id, sid: session.id })

    return res.status(201).json({
      user,
      accessToken,
      refreshToken: rawRefreshToken,
    })
  } catch (error) {
    return next(error)
  }
})

// Login with email and password
authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body)

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      // Run dummy hash check to prevent timing analysis
      await verifyPassword('$argon2id$v=19$m=65536,t=3,p=4$dHVtbXlkdW1teWR1bW15$dummyhashdummyhashdummyhash', password).catch(() => false)
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      })
    }

    const isValidPassword = await verifyPassword(user.passwordHash, password)
    if (!isValidPassword) {
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      })
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        code: 'USER_INACTIVE',
        message: 'This account has been deactivated. Please contact support.',
      })
    }

    // Create session
    const rawRefreshToken = randomToken(48)
    const refreshTokenHash = hashToken(rawRefreshToken)
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400 * 1000)

    const session = await prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        userAgent: req.headers['user-agent']?.slice(0, 500) || null,
        ipAddress: (req.ip || req.socket.remoteAddress || '').slice(0, 64) || null,
        expiresAt,
      },
    })

    const accessToken = signAccessToken({ sub: user.id, sid: session.id })

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
      },
      accessToken,
      refreshToken: rawRefreshToken,
    })
  } catch (error) {
    return next(error)
  }
})

// Refresh access token
authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body)
    const refreshTokenHash = hashToken(refreshToken)

    const session = await prisma.userSession.findFirst({
      where: {
        refreshTokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    })

    if (!session || !session.user || session.user.status !== 'active') {
      return res.status(401).json({
        code: 'SESSION_EXPIRED',
        message: 'Your session has expired. Please log in again.',
      })
    }

    const accessToken = signAccessToken({ sub: session.user.id, sid: session.id })

    return res.json({ accessToken })
  } catch (error) {
    return next(error)
  }
})

// Logout / revoke session
authRouter.post('/logout', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (req.user?.sessionId) {
      await prisma.userSession.updateMany({
        where: { id: req.user.sessionId },
        data: { revokedAt: new Date() },
      })
    }
    return res.json({ success: true, message: 'Logged out successfully.' })
  } catch (error) {
    return next(error)
  }
})

// Get current authenticated user
authRouter.get('/me', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { id: true, name: true, email: true, status: true, createdAt: true },
    })
    return res.json({ user })
  } catch (error) {
    return next(error)
  }
})
