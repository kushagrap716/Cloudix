import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const prismaDir = path.resolve(__dirname, '../../prisma')
const schemaPath = path.join(prismaDir, 'schema.prisma')
const mysqlBackupPath = path.join(prismaDir, 'schema.mysql.prisma')
const envPath = path.resolve(__dirname, '../../.env')

console.log('--- Switching Cloudix to Zero-Config Local SQLite ---')

const currentSchema = fs.readFileSync(schemaPath, 'utf8')

// Backup MySQL schema
if (!fs.existsSync(mysqlBackupPath) && currentSchema.includes('provider = "mysql"')) {
  fs.writeFileSync(mysqlBackupPath, currentSchema, 'utf8')
  console.log('✓ Backed up original MySQL schema to schema.mysql.prisma')
}

// Convert schema to SQLite
const sqliteSchema = currentSchema
  .replace(/provider\s*=\s*"mysql"/g, 'provider = "sqlite"')
  .replace(/@db\.[A-Za-z0-9_()]+/g, '')

fs.writeFileSync(schemaPath, sqliteSchema, 'utf8')
console.log('✓ Converted schema.prisma to SQLite provider')

// Ensure local .env uses SQLite
let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
if (envContent.includes('DATABASE_URL=')) {
  envContent = envContent.replace(/DATABASE_URL=.*/, 'DATABASE_URL="file:./dev.db"')
} else {
  envContent += '\nDATABASE_URL="file:./dev.db"\n'
}
if (!envContent.includes('TOKEN_ENCRYPTION_KEY=')) {
  envContent += 'TOKEN_ENCRYPTION_KEY="01234567890123456789012345678901"\n'
}
if (!envContent.includes('JWT_ACCESS_SECRET=')) {
  envContent += 'JWT_ACCESS_SECRET="cloudix_local_dev_jwt_access_secret_key_12345"\n'
}
if (!envContent.includes('FRONTEND_URL=')) {
  envContent += 'FRONTEND_URL="http://localhost:5173"\n'
}
fs.writeFileSync(envPath, envContent, 'utf8')
console.log('✓ Configured .env with local SQLite DATABASE_URL="file:./dev.db"')

console.log('Running prisma db push...')
execSync('npx prisma db push --skip-generate --accept-data-loss', { cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'inherit', 'inherit'] })
execSync('npx prisma generate', { cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'inherit', 'inherit'] })

console.log('✓ Local SQLite database initialized successfully!')
console.log('You can now run "npm run dev" with zero external MySQL requirement.')
