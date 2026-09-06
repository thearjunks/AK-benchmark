import { preview } from 'vite'
import { access } from 'node:fs/promises'
import path from 'node:path'

// Managed Node hosts provide PORT. Use the conventional production fallback
// instead of the dashboard's local development port.
const requestedPort = Number.parseInt(process.env.PORT || '3000', 10)
const port = Number.isFinite(requestedPort) ? requestedPort : 3000

await access(path.join(process.cwd(), 'dist', 'index.html'))

const server = await preview({
  clearScreen: false,
  // Hostinger runs Node 22. Loading this plain ESM config natively avoids
  // Rolldown config bundling crashes observed in its Linux runtime.
  configLoader: 'native',
  preview: {
    host: '0.0.0.0',
    port,
    strictPort: true
  }
})

// Identify this runtime release during post-deployment health verification.
server.httpServer?.prependListener('request', (_req, res) => {
  res.setHeader('X-Benchmark-Release', 'audit-recovery-2026-09-06')
})

server.httpServer?.once('listening', () => {
  console.log(`AK Website Benchmark listening on port ${port}`)
})

server.httpServer?.once('error', error => {
  console.error('AK Website Benchmark server error:', error)
})
