import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { parseBundledMcpArgs, runBundledMcpCli } from './mcp-cli'
import { applyPortableEnv, resolvePortableLayout } from './portable'

// Portable (green) layout: a marker file next to the executable redirects every
// writable root before any other module can resolve a data path, so the Studio
// server, Hermes Agent and the MCP CLI all stay inside the app directory.
if (app.isPackaged) {
  const portable = resolvePortableLayout(process.execPath)
  if (portable) {
    applyPortableEnv(portable)
    mkdirSync(portable.userData, { recursive: true })
    app.setPath('userData', portable.userData)
  }
}

// Already-running Gateways can retain MCP definitions from before Node mode
// was persisted. Route those invocations before loading any GUI or updater code.
const mcpArgs = app.isPackaged ? parseBundledMcpArgs(process.argv, process.resourcesPath) : null
if (mcpArgs) {
  app.dock?.hide()
  runBundledMcpCli(mcpArgs).then(code => app.exit(code)).catch(error => {
    console.error(error)
    app.exit(1)
  })
} else {
  require('./index')
}
