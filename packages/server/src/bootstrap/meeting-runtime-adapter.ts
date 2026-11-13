import { HermesSkillInjector } from '../modules/hermes/services/skills/injector'
import { configureMeetingRuntime } from '../modules/studio/public/meeting-runtime'

configureMeetingRuntime({ resolveBundledSkillsDirectory: () => HermesSkillInjector.resolveSourceDir() })
