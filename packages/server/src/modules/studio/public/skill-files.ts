export interface SkillFileProvider {
  findFile(roots: string[], name: string): Promise<{ name: string; directory: string; path: string; flat: boolean } | null>
  list(roots: string[]): Promise<Array<{ name: string; description: string; skills: Array<{
    name: string; description: string; enabled: boolean; source: string; readonly: boolean
  }> }>>
  validate(content: string): { name: string; description: string }
}

const providers = new Map<string, SkillFileProvider>()

export function configureSkillFileProvider(agent: string, provider: SkillFileProvider): void {
  providers.set(agent, provider)
}

export function getSkillFileProvider(agent: string): SkillFileProvider {
  const provider = providers.get(agent)
  if (!provider) throw new Error(`Skill file provider is not configured: ${agent}`)
  return provider
}
