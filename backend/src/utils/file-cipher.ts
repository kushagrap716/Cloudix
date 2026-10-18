import crypto from 'node:crypto'
import { env } from '../config/env.js'

/**
 * Derives a 32-byte AES-256 key from a passphrase and salt.
 */
export function deriveFileEncryptionKey(passphrase: string, salt: string = 'cloudix-vault-salt'): Buffer {
  return crypto.scryptSync(passphrase, salt, 32)
}

/**
 * Encrypts a binary Buffer with AES-256-GCM.
 * Prepends the 12-byte IV and 16-byte Auth Tag to the ciphertext:
 * [12 bytes IV][16 bytes Tag][Ciphertext...]
 */
export function encryptFileBuffer(data: Buffer, customKey?: Buffer): Buffer {
  const key = customKey || crypto.createHash('sha256').update(env.TOKEN_ENCRYPTION_KEY).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted])
}

/**
 * Decrypts a binary Buffer produced by encryptFileBuffer.
 * Expects: [12 bytes IV][16 bytes Tag][Ciphertext...]
 */
export function decryptFileBuffer(encryptedData: Buffer, customKey?: Buffer): Buffer {
  if (encryptedData.length < 28) throw new Error('Encrypted payload too short (minimum 28 bytes for IV + Tag)')
  const key = customKey || crypto.createHash('sha256').update(env.TOKEN_ENCRYPTION_KEY).digest()
  const iv = encryptedData.subarray(0, 12)
  const tag = encryptedData.subarray(12, 28)
  const ciphertext = encryptedData.subarray(28)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
