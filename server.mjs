import { preview } from 'vite'

const requestedPort = Number.parseInt(process.env.PORT || '4173', 10)
const port = Number.isFinite(requestedPort) ? requestedPort : 4173

const server = await preview({
  clearScreen: false,
  preview: {
    host: '0.0.0.0',
    port,
    strictPort: true
  }
})

server.httpServer?.once('listening', () => {
  console.log(`AK Website Benchmark listening on port ${port}`)
})
