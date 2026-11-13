import { codingAgentEnvironmentError } from '../../contracts/environment'

export function checkQoderPlatform(platform: NodeJS.Platform, arch: string): void {
  if (platform === 'win32' && arch === 'arm64') {
    throw codingAgentEnvironmentError('Qoder CLI does not support native Windows ARM64. Run Studio and Qoder together in a supported environment (for example, Linux inside WSL).')
  }
}
