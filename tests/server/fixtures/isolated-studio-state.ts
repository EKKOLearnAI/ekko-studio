// Import first: points Web UI and Hermes state at a private temporary directory before any Studio module
// loads, so these tests never touch the default ~/.hermes-web-ui or an inherited HERMES_HOME, and parallel
// files never share a database. Tests that need a specific Hermes home still stub it explicitly.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'studio-test-state-'))
process.env.HERMES_WEB_UI_HOME = dir
// Test mode keeps the Studio database under the checkout unless this points elsewhere.
process.env.HERMES_WEB_UI_TEST_DB_DIR = dir
process.env.HERMES_WEBUI_STATE_DIR = dir
process.env.UPLOAD_DIR = join(dir, 'upload')
process.env.HERMES_HOME = join(dir, 'hermes')
