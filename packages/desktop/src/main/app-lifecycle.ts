export interface DesktopAppLifecycleHost {
  quit: () => void
  relaunch: () => void
  exit: (exitCode?: number) => void
}

export interface DesktopAppLifecycle {
  readonly isQuitting: boolean
  quit: () => void
  prepareShutdown: () => void
  scheduleRestart: (delayMs?: number) => boolean
  finalizeExit: (exitCode?: number) => boolean
}

/**
 * Coordinate normal quits and requested restarts without registering a
 * relaunch until graceful shutdown has finished. A later explicit quit can
 * therefore override a restart while shutdown is still in progress.
 */
export function createDesktopAppLifecycle(host: DesktopAppLifecycleHost): DesktopAppLifecycle {
  let isQuitting = false
  let restartScheduled = false
  let relaunchAfterShutdown = false
  let exitFinalized = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  function cancelRestart(): void {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    restartScheduled = false
    relaunchAfterShutdown = false
  }

  return {
    get isQuitting() {
      return isQuitting
    },

    quit() {
      // A user-initiated quit always wins over a pending or in-progress
      // restart request.
      cancelRestart()
      if (exitFinalized) return
      isQuitting = true
      host.quit()
    },

    prepareShutdown() {
      isQuitting = true
    },

    scheduleRestart(delayMs = 100) {
      if (restartScheduled || relaunchAfterShutdown) return true
      if (isQuitting || exitFinalized) return false
      restartScheduled = true
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (isQuitting || exitFinalized) {
          restartScheduled = false
          return
        }
        relaunchAfterShutdown = true
        isQuitting = true
        host.quit()
      }, delayMs)
      restartTimer.unref?.()
      return true
    },

    finalizeExit(exitCode = 0) {
      if (exitFinalized) return false
      exitFinalized = true
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = null
      restartScheduled = false
      if (relaunchAfterShutdown) host.relaunch()
      host.exit(exitCode)
      return true
    },
  }
}
