import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

/** Generated wrappers live in their own folder of the profile's native `scripts/` directory. */
export const WRAPPER_DIR = 'ekko-script-reports'
const WRAPPER_TEMPLATE = 'ekko_script_report_wrapper.py'
const MANIFEST_PLACEHOLDER = 'MANIFEST_PATH = None  # @EKKO_SCRIPT_REPORT_MANIFEST@'

function wrapperTemplatePath(): string {
  const candidates = [
    // Built server: dist/server/index.js -> dist/server/assets/script-reports/
    resolve(__dirname, 'assets', 'script-reports', WRAPPER_TEMPLATE),
    resolve(__dirname, '..', '..', '..', '..', 'assets', 'script-reports', WRAPPER_TEMPLATE),
    resolve(process.cwd(), 'packages/server/src/assets/script-reports', WRAPPER_TEMPLATE),
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) throw new Error('script report wrapper template not found')
  return found
}

/** The generated wrapper: the template with the absolute manifest path as a Python string literal. */
export function renderWrapper(manifestPath: string): string {
  const template = readFileSync(wrapperTemplatePath(), 'utf-8')
  if (template.split(MANIFEST_PLACEHOLDER).length !== 2) throw new Error('script report wrapper template is invalid')
  // A JSON string literal is a valid Python string literal.
  return template.replace(MANIFEST_PLACEHOLDER, `MANIFEST_PATH = ${JSON.stringify(manifestPath)}`)
}
