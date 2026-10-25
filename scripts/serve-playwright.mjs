import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'
import { build as bundle } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2] || 4173)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Playwright port')
const outDir = resolve(root, `node_modules/.cache/playwright-client-${port}`)
const configFile = resolve(root, 'vite.config.ts')
// Keep the real Socket.IO module at an explicit network boundary so the same
// per-page socket fixtures work with both the built client and the dev server.
const socketPath = '/__e2e/socket__io-client.js'
await build({
  configFile,
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      external: ['socket.io-client'],
      output: { paths: { 'socket.io-client': socketPath } },
    },
  },
})
await bundle({
  absWorkingDir: root,
  entryPoints: ['socket.io-client'],
  outfile: resolve(outDir, socketPath.slice(1)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
})
const server = await preview({
  configFile,
  build: { outDir },
  // A missing test mock must never reach a developer's running backend.
  preview: { host: '127.0.0.1', port, strictPort: true, proxy: {} },
  plugins: [{
    name: 'playwright-mock-backend-only',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!/^\/(?:api|v1|socket\.io|health)(?:\/|\?|$)/.test(request.url || '')) return next()
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'Unmocked browser-test request' }))
      })
    },
  }],
})
server.printUrls()
