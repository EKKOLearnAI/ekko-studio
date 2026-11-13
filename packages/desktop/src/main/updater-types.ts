export interface DesktopUpdateState {
  revision: number
  status: 'idle' | 'downloading' | 'cancelling' | 'cancelled' | 'preparing' | 'downloaded' | 'error' | 'installing'
  version: string
  percent: number | null
  transferred: number
  total: number
  bytesPerSecond: number
}

export const DESKTOP_UPDATE_STATE_CHANNEL = 'hermes-desktop:update-state-change'
