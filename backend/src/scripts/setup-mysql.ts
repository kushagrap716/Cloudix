import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const prismaDir = path.resolve(__dirname, '../../prisma')
const schemaPath = path.join(prismaDir, 'schema.prisma')
const mysqlBackupPath = path.join(prismaDir, 'schema.mysql.prisma')

console.log('--- Restoring MySQL Schema ---')

if (fs.existsSync(mysqlBackupPath)) {
  const mysqlSchema = fs.readFileSync(mysqlBackupPath, 'utf8')
  fs.writeFileSync(schemaPath, mysqlSchema, 'utf8')
  console.log('✓ Restored schema.prisma from schema.mysql.prisma')
} else {
  let schema = fs.readFileSync(schemaPath, 'utf8')
  schema = schema.replace(/provider\s*=\s*"sqlite"/g, 'provider = "mysql"')
  fs.writeFileSync(schemaPath, schema, 'utf8')
  console.log('✓ Switched schema.prisma provider to mysql')
}

const envPath = path.resolve(__dirname, '../../.env')
if (fs.existsSync(envPath)) {
  let envContent = fs.readFileSync(envPath, 'utf8')
  if (envContent.includes('file:')) {
    envContent = envContent.replace(/DATABASE_URL=.*/, 'DATABASE_URL="mysql://root:password@localhost:3306/cloudix"')
    fs.writeFileSync(envPath, envContent, 'utf8')
    console.log('✓ Restored DATABASE_URL in .env to MySQL')
  }
}

execSync('npx prisma generate', { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit' })
console.log('✓ Prisma client regenerated for MySQL.')

