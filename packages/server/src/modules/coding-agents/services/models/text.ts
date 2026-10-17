import { discoveryError, text } from './types'
import type { ModelDiscoveryContext } from './types'

/** Only advertise native CLI choices printed by this installation. */
export async function cliReasoningEfforts(context: ModelDiscoveryContext, option: string): Promise<string[]> {
  try {
    const { stdout, stderr } = await context.run(['--help'])
    const output = lines(`${stdout}\n${stderr}`)
    const start = output.findIndex(line => line.includes(option))
    if (start < 0) return []
    const block = [output[start]]
    for (const line of output.slice(start + 1, start + 4)) {
      if (/^--?[a-z]/i.test(line)) break
      block.push(line)
    }
    const declared = block.join(' ')
    return ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      .filter(value => new RegExp(`\\b${value}\\b`).test(declared)).map(value => value === 'off' ? 'none' : value)
  } catch { return [] }
}

export function lines(stdout: string): string[] {
  return stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

export function requireModelOutput(models: unknown[], stdout: string) {
  const declared = lines(stdout).some(line => /^(?:no (?:available )?models\b|MODEL$|provider\s+model\b|available models\b)/i.test(line))
  if (!models.length && !declared) throw discoveryError(stdout)
}

export function modelId(value: string): string | undefined {
  const id = text(value)
  return id && /^[\p{L}\p{N}][\p{L}\p{N}._:/@+\[\]-]*$/u.test(id) ? id : undefined
}

export function tokenCount(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(value)
  return match ? Math.round(Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1000 : 1)) : undefined
}
