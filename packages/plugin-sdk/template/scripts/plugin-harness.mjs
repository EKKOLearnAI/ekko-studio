import { fileURLToPath } from 'node:url'
import { runProjectCli } from '../sdk/harness/project.mjs'
await runProjectCli(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2))
