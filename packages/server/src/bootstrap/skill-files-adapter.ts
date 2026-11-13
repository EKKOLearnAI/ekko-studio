import { findDshSkillFile, listDshSkills, validateDshSkill } from '../modules/coding-agents/services/dsh/skills'
import { configureSkillFileProvider } from '../modules/studio/public/skill-files'

configureSkillFileProvider('dsh', { findFile: findDshSkillFile, list: listDshSkills, validate: validateDshSkill })
