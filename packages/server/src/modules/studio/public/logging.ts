import pino from 'pino'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { mkdirSync, statSync, truncateSync, openSync, readSync, closeSync, writeFileSync } from 'fs'
import { config } from './config'

const MAX_LOG_SIZE = 3 * 1024 * 1024 // 3MB
const CHECK_INTERVAL = 60_000 // Check every minute

const logDir = process.env.VITEST
  ? resolve(tmpdir(), 'hermes-web-ui-test-logs', String(process.pid))
  : resolve(config.appHome, 'logs')

const logFile = resolve(logDir, 'server.log')
const bridgeLogFile = resolve(logDir, 'bridge.log')
const VALID_LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

function logLevel(value: string | undefined, fallback = 'info'): string {
  const normalized = String(value || '').trim().toLowerCase()
  return VALID_LOG_LEVELS.has(normalized) ? normalized : fallback
}

function createDestination(file: string) {
  try {
    mkdirSync(logDir, { recursive: true })
    const destination = pino.destination({ dest: file, sync: true })
    destination.on('error', error => {
      console.error(`[logging] write failed for ${file}`, error)
    })
    return destination
  } catch (error) {
    // Logging must never make Studio unbootable. stderr remains available to
    // Desktop's child-process capture and to service managers.
    console.error(`[logging] unable to open ${file}; falling back to stderr`, error)
    const destination = pino.destination({ dest: 2, sync: true })
    destination.on('error', destinationError => {
      console.error('[logging] stderr destination failed', destinationError)
    })
    return destination
  }
}

function rotateFileIfNeeded(file: string) {
  try {
    const stat = statSync(file)
    if (stat.size > MAX_LOG_SIZE) {
      const keepSize = Math.floor(MAX_LOG_SIZE / 2)
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(keepSize)
      readSync(fd, buf, 0, keepSize, stat.size - keepSize)
      closeSync(fd)
      truncateSync(file, 0)
      writeFileSync(file, buf)
    }
  } catch { }
}

function rotateIfNeeded() {
  rotateFileIfNeeded(logFile)
  rotateFileIfNeeded(bridgeLogFile)
}

// Rotate on startup
rotateIfNeeded()

// Periodic rotation check — prevents unbounded log growth
setInterval(rotateIfNeeded, CHECK_INTERVAL)

export const logger = pino({
  level: logLevel(process.env.LOG_LEVEL),
}, createDestination(logFile))

export const bridgeLogger = pino({
  level: logLevel(process.env.BRIDGE_LOG_LEVEL, logLevel(process.env.LOG_LEVEL)),
  name: 'bridge',
}, createDestination(bridgeLogFile))
