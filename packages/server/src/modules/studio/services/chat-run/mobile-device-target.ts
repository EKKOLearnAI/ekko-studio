import { createHash } from 'node:crypto'

export type MobileDeviceTarget = {
  deviceCode: string
  userId: string
  profile: string
  platform?: 'ios' | 'android' | 'unknown'
}
export function mobileDeviceId(target: MobileDeviceTarget): string {
  return createHash('sha256').update(JSON.stringify([target.userId, target.deviceCode])).digest('hex').slice(0, 24)
}
export function mobileDeviceRoom(target: MobileDeviceTarget): string {
  return `mobile-consent:${mobileDeviceId(target)}:${encodeURIComponent(target.profile)}`
}
export function sameMobileDevice(a: MobileDeviceTarget | undefined, b: MobileDeviceTarget | undefined): boolean {
  return Boolean(a && b && a.deviceCode === b.deviceCode && a.userId === b.userId && a.profile === b.profile)
}
export function mobileEventAllowed(data: Record<string, any> | undefined, target: MobileDeviceTarget | undefined): boolean {
  return Boolean(target && data?.target_device_id === target.deviceCode && data?.target_user_id === target.userId && data?.target_profile === target.profile)
}
