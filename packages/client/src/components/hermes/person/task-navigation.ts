import type { ComputedRef, InjectionKey } from 'vue'

export const personTaskNavigation: InjectionKey<(taskId: string, executionId?: string) => void> = Symbol('personTaskNavigation')
export const personWorkspacePreviewContext: InjectionKey<ComputedRef<{ sessionId: string; workspace?: string | null } | null>> = Symbol('personWorkspacePreviewContext')
