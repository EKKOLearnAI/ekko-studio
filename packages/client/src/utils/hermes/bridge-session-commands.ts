export type BridgeSessionCommandName =
  | 'usage'
  | 'context'
  | 'status'
  | 'yolo'
  | 'abort'
  | 'queue'
  | 'skill'
  | 'bundles'
  | 'learn'
  | 'plan'
  | 'moa'
  | 'goal'
  | 'subgoal'
  | 'clear'
  | 'title'
  | 'compress'
  | 'compact'
  | 'fork'
  | 'steer'
  | 'destroy'
  | 'reload-mcp'
  | 'reload-skills'

export interface BridgeSessionCommandDefinition {
  key: string
  name: BridgeSessionCommandName
  descriptionKey: string
  argsKey?: string
  args?: string
  insertText?: string
  opensSkillPicker?: boolean
  opensBundlePicker?: boolean
  opensBundleCreator?: boolean
}

export const BRIDGE_SESSION_COMMAND_DEFINITIONS: BridgeSessionCommandDefinition[] = [
  { key: 'command:usage', name: 'usage', args: '', descriptionKey: 'chat.slashCommands.usage' },
  { key: 'command:context', name: 'context', args: '', descriptionKey: 'chat.slashCommands.context' },
  { key: 'command:status', name: 'status', args: '', descriptionKey: 'chat.slashCommands.status' },
  { key: 'command:yolo', name: 'yolo', args: '', descriptionKey: 'chat.slashCommands.yolo' },
  { key: 'command:abort', name: 'abort', args: '', descriptionKey: 'chat.slashCommands.abort' },
  { key: 'command:queue', name: 'queue', argsKey: 'chat.slashCommandArgs.message', descriptionKey: 'chat.slashCommands.queue' },
  { key: 'command:skill', name: 'skill', args: '', descriptionKey: 'skills.title', opensSkillPicker: true },
  { key: 'command:bundles', name: 'bundles', args: '', descriptionKey: 'chat.slashCommands.bundles', opensBundlePicker: true },
  { key: 'command:bundles-create', name: 'bundles', args: 'create', insertText: 'bundles create', descriptionKey: 'chat.slashCommands.bundlesCreate', opensBundleCreator: true },
  { key: 'command:learn', name: 'learn', argsKey: 'chat.slashCommandArgs.text', descriptionKey: 'chat.slashCommands.learn' },
  { key: 'command:plan', name: 'plan', argsKey: 'chat.slashCommandArgs.text', descriptionKey: 'chat.slashCommands.plan' },
  { key: 'command:moa', name: 'moa', argsKey: 'chat.slashCommandArgs.text', descriptionKey: 'chat.slashCommands.moa' },
  { key: 'command:goal', name: 'goal', argsKey: 'chat.slashCommandArgs.text', descriptionKey: 'chat.slashCommands.goal' },
  { key: 'command:goal-status', name: 'goal', args: 'status', insertText: 'goal status', descriptionKey: 'chat.slashCommands.goalStatus' },
  { key: 'command:goal-pause', name: 'goal', args: 'pause', insertText: 'goal pause', descriptionKey: 'chat.slashCommands.goalPause' },
  { key: 'command:goal-resume', name: 'goal', args: 'resume', insertText: 'goal resume', descriptionKey: 'chat.slashCommands.goalResume' },
  { key: 'command:goal-done', name: 'goal', args: 'done', insertText: 'goal done', descriptionKey: 'chat.slashCommands.goalDone' },
  { key: 'command:goal-clear', name: 'goal', args: 'clear', insertText: 'goal clear', descriptionKey: 'chat.slashCommands.goalClear' },
  { key: 'command:subgoal', name: 'subgoal', argsKey: 'chat.slashCommandArgs.text', descriptionKey: 'chat.slashCommands.subgoal' },
  { key: 'command:clear', name: 'clear', args: '', descriptionKey: 'chat.slashCommands.clear' },
  { key: 'command:clear-history', name: 'clear', args: '--history', insertText: 'clear --history', descriptionKey: 'chat.slashCommands.clearHistory' },
  { key: 'command:title', name: 'title', argsKey: 'chat.slashCommandArgs.title', descriptionKey: 'chat.slashCommands.title' },
  { key: 'command:compress', name: 'compress', args: '', descriptionKey: 'chat.slashCommands.compress' },
  { key: 'command:compact', name: 'compact', args: '', descriptionKey: 'chat.slashCommands.compact' },
  { key: 'command:fork', name: 'fork', argsKey: 'chat.slashCommandArgs.title', descriptionKey: 'chat.slashCommands.fork' },
  { key: 'command:steer', name: 'steer', argsKey: 'chat.slashCommandArgs.text', descriptionKey: 'chat.slashCommands.steer' },
  { key: 'command:destroy', name: 'destroy', args: '', descriptionKey: 'chat.slashCommands.destroy' },
  { key: 'command:reload-mcp', name: 'reload-mcp', args: '', descriptionKey: 'chat.slashCommands.reloadMcp' },
  { key: 'command:reload-skills', name: 'reload-skills', args: '', descriptionKey: 'chat.slashCommands.reloadSkills' },
]

export const BRIDGE_SESSION_COMMAND_NAMES = Array.from(
  new Set(BRIDGE_SESSION_COMMAND_DEFINITIONS.map(command => command.name)),
)

const BRIDGE_SESSION_COMMAND_ALIASES = new Map<string, BridgeSessionCommandName>([
  ['reload_skills', 'reload-skills'],
])

export function normalizeBridgeSessionCommandName(name: string): BridgeSessionCommandName | null {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return null
  const alias = BRIDGE_SESSION_COMMAND_ALIASES.get(normalized)
  if (alias) return alias
  return (BRIDGE_SESSION_COMMAND_NAMES as string[]).includes(normalized)
    ? normalized as BridgeSessionCommandName
    : null
}

export function readBridgeSessionCommandName(input: string): BridgeSessionCommandName | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s|$)/)
  if (!match) return null
  return normalizeBridgeSessionCommandName(match[1])
}

export function isKnownBridgeSessionCommand(input: string): boolean {
  return readBridgeSessionCommandName(input) !== null
}

export const EKKO_SESSION_COMMAND_DEFINITIONS: BridgeSessionCommandDefinition[] = [
  { key: 'ekko:context', name: 'context', args: '', descriptionKey: 'chat.slashCommands.context' },
  { key: 'ekko:compact', name: 'compact', args: '', descriptionKey: 'chat.slashCommands.compress' },
  { key: 'ekko:usage', name: 'usage', args: '', descriptionKey: 'chat.slashCommands.usage' },
  { key: 'ekko:status', name: 'status', args: '', descriptionKey: 'chat.slashCommands.status' },
]

export function isKnownEkkoSessionCommand(input: string): boolean {
  const name = readBridgeSessionCommandName(input)
  return name === 'compress' || EKKO_SESSION_COMMAND_DEFINITIONS.some(command => command.name === name)
}
