import { USBService } from './USBService'

let singleton: USBService | null = null

export function getUSBService(): USBService {
  if (!singleton) singleton = new USBService()
  return singleton
}

export function startUSBService(): USBService {
  const service = getUSBService()
  service.start()
  return service
}

export async function stopUSBService(): Promise<void> {
  if (!singleton) return
  await singleton.stop()
}
