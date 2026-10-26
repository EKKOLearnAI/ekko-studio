import { readonly, shallowRef } from 'vue'
import { desktopBridge, type DesktopComputerUsePermissions } from '@/utils/desktop-bridge'

const pending = shallowRef<DesktopComputerUsePermissions | null>(null)
let checking = false
let revision = 0

export async function notifyComputerUseStarted(tool: unknown, input: Record<string, unknown> | null): Promise<void> {
  if (tool !== 'computer_use' || !['call', 'status'].includes(String(input?.action))) return
  const desktop = desktopBridge()
  const claim = desktop?.computerUsePermissions?.claimReminder
  if (!desktop?.isDesktop || desktop.platform !== 'darwin' || desktop.remoteMode || !claim || checking || pending.value) return
  checking = true
  const currentRevision = revision
  try {
    // The native claim is atomic across windows and never requests OS grants.
    const status = await claim()
    if (revision === currentRevision) pending.value = status
  } catch {
    // A failed check is not evidence of a missing grant; allow a later attempt.
  } finally {
    checking = false
  }
}

export function useComputerUsePermissionPrompt() {
  return {
    pending: readonly(pending),
    dismiss: () => { revision++; pending.value = null },
  }
}
