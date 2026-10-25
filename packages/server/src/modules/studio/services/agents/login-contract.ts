import { StudioError, type ProcessSpawnInput } from '../../contracts/plugins'
import { parseProcessSpawn } from '../processes/managed'

export function parseAgentLogin(value: unknown): Omit<ProcessSpawnInput, 'terminal'> {
  const input = parseProcessSpawn(value)
  if ('terminal' in input) throw new StudioError('INVALID_ARGUMENT', 'Login terminal dimensions belong to the host')
  return input
}
