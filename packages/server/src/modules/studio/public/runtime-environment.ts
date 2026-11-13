import { existsSync } from 'fs'

export function isDockerContainer(): boolean {
  return existsSync('/.dockerenv') || process.env.container === 'docker'
}
