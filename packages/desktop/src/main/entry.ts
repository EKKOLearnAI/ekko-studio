import { app } from 'electron'
import { parseBundledMcpArgs, runBundledMcpCli } from './mcp-cli'

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
