import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { taskArtifactPath } from './scripts/task-artifacts.mjs'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
      '/logo.png': resolve(__dirname, 'packages/client/public/logo.png'),
      '/relay-logo.png': resolve(__dirname, 'packages/client/public/relay-logo.png'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      reportsDirectory: taskArtifactPath(__dirname, 'coverage'),
      exclude: [
        '**/dist/**',
        'packages/desktop/release/**',
      ],
    },
  },
})
