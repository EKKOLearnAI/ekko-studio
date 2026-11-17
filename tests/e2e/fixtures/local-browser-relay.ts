import { ensureRemoteBrowserRelay, remoteBrowserEnabled, stopRemoteBrowserRelay } from '../../../packages/client/src/composables/useRemoteBrowserRelay'
const status = document.querySelector('output')!
document.querySelector('button')!.addEventListener('click', async () => {
  await stopRemoteBrowserRelay()
  status.textContent = 'disconnected'
})
try {
  await ensureRemoteBrowserRelay()
  status.textContent = remoteBrowserEnabled.value ? 'connected' : 'unavailable'
} catch (error) { status.textContent = String(error) }
