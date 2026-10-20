import dns from 'node:dns'
import { app } from './app.js'
import { env } from './config/env.js'
import { startSplitCleanupSchedule } from './modules/split/split.service.js'

// Prefer IPv4 over IPv6 on Windows to prevent carrier-level IPv6 TCP resets during uploads
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first')
}

app.listen(env.APP_PORT, () => {
  console.log(`Backend running on http://localhost:${env.APP_PORT}`)
  startSplitCleanupSchedule()
})
