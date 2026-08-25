import { preview } from 'vite'
import { access } from 'node:fs/promises'
import path from 'node:path'

const requestedPort = Number.parseInt(process.env.PORT || '56436', 10)
const port = Number.isFinite(requestedPort) ? requestedPort : 56436

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

server.httpServer?.once('listening', () => {
  console.log(`AK Website Benchmark listening on port ${port}`)
})

server.httpServer?.once('error', error => {
  console.error('AK Website Benchmark server error:', error)
})
