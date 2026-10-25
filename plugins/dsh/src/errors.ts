import { StudioError } from '@ekko-studio/plugin-sdk'
export class DshPluginError extends StudioError {
  constructor(_status: number, code: string, message: string) { super(code === 'DSH_DEPENDENCY_UNAVAILABLE' ? 'RUNTIME_UNAVAILABLE' : 'CAPABILITY_UNSUPPORTED', message) }
}
