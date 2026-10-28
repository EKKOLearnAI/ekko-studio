import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { ProxyOptions } from 'vite'
import { resolve } from 'path'
import pkg from './package.json'

const FRONTEND_PORT = Number(process.env.HERMES_WEB_UI_FRONTEND_PORT || 8649)
const BACKEND_PORT = process.env.HERMES_WEB_UI_BACKEND_PORT || '8648'
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`

function createProxyConfig(): ProxyOptions {
  return {
    target: BACKEND,
    changeOrigin: true,
    ws: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
      proxy.on('proxyReqWs', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
      proxy.on('proxyRes', (proxyRes) => {
        proxyRes.headers['cache-control'] = 'no-cache'
        proxyRes.headers['x-accel-buffering'] = 'no'
      })
    },
  }
}

export default defineConfig({
  root: 'packages/client',
  base: process.env.STUDIO_BASE_PATH || '/',
  // Concurrent test/dev servers must not replace each other's optimized Vue runtime.
  cacheDir: resolve(__dirname, process.env.HERMES_WEB_UI_VITE_CACHE_DIR || 'node_modules/.vite/client'),
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    // Use esbuild for minification (much faster than terser)
    minify: 'esbuild',
    // Disable sourcemap generation for faster builds
    sourcemap: false,
    target: 'es2020',
    // Increase chunk size warning limit (default: 500KB)
    chunkSizeWarningLimit: 1000,
    // CSS code splitting for better caching
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Optimize chunk file names for better caching
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
    },
  },
  optimizeDeps: {
    // Pre-bundle all large dependencies for faster builds
    include: [
      'monaco-editor',
      'mermaid',
      'vue',
      'vue-router',
      'pinia',
      'naive-ui',
      // Worker-only imports must be ready before opening a workbook, without a page reload.
      'read-excel-file/web-worker',
    ],
  },
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    proxy: {
      '/api': createProxyConfig(),
      '/v1': createProxyConfig(),
      '/health': createProxyConfig(),
      '/upload': createProxyConfig(),
      '/socket.io': {
        target: BACKEND,
        ws: true,
      },
    },
  },
})
