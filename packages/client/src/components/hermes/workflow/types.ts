import type { SelectOption } from 'naive-ui'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { CodingAgentApiMode } from '@/api/coding-agents'

export interface WorkflowSelectOption extends SelectOption {
  label: string
  value: string
}

export type WorkflowNodeStatus = 'idle' | 'queued' | 'running' | 'pending_approval' | 'completed' | 'skipped' | 'failed' | 'approval_rejected' | 'canceled'

export interface WorkflowAgentNodeData {
  title: string
  agent: string
  agentMode: 'scoped' | 'global'
  priorAgentMode?: 'scoped' | 'global'
  agentPreset?: string
  agentPresetReady?: boolean
  provider: string
  model: string
  apiMode: CodingAgentApiMode
  reasoningEffort: string
  input: string
  skills: string[]
  images: string[]
  approvalRequired: boolean
  orchestration: { join: 'all' | 'any' }
  status: WorkflowNodeStatus
  statusError?: string | null
  readonly?: boolean
  agentOptions: WorkflowSelectOption[]
  skillOptions: WorkflowSelectOption[]
  skillsLoading: boolean
  modelGroups: AvailableModelGroup[]
  onUpdate: (id: string, patch: Partial<WorkflowAgentNodeEditableData>) => void
  onUploadImages: (id: string, files: File[]) => Promise<string[]>
}

export type WorkflowAgentNodeEditableData = Pick<WorkflowAgentNodeData, 'title' | 'agent' | 'agentMode' | 'priorAgentMode' | 'agentPreset' | 'agentPresetReady' | 'provider' | 'model' | 'apiMode' | 'reasoningEffort' | 'input' | 'skills' | 'images' | 'approvalRequired' | 'orchestration'>
