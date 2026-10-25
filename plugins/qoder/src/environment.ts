import { StudioError } from '@ekko-studio/plugin-sdk'

export function checkQoderPlatform(platform = process.platform, arch = process.arch): void {
  if (platform === 'win32' && arch === 'arm64') {
    throw new StudioError('CAPABILITY_UNSUPPORTED', 'Qoder CLI does not support native Windows ARM64; use a supported Studio and Qoder environment')
  }
}
