export interface MeetingRuntimeDependencies {
  resolveBundledSkillsDirectory(): string
}

let dependencies: MeetingRuntimeDependencies | undefined

export function configureMeetingRuntime(next: MeetingRuntimeDependencies): void {
  dependencies = next
}

export function resolveBundledMeetingSkillsDirectory(): string {
  if (!dependencies) throw new Error('Studio meeting runtime has not been configured')
  return dependencies.resolveBundledSkillsDirectory()
}
