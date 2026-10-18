export const SIDEBAR_DEFAULT_WIDTH = 240
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 480

export function sidebarMaxWidth(viewportWidth: number) {
  // Leave room for the navigation rail and the main content on small desktops.
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - 400))
}

export function clampSidebarWidth(width: number, maxWidth = SIDEBAR_MAX_WIDTH) {
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth,
    Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH)))
}
