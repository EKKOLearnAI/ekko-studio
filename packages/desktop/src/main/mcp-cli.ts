import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

export function parseBundledMcpArgs(argv: string[], resourcesPath: string): string[] | null {
  const script = argv[1]
  if (!script) return null
  const bin = join(resourcesPath, 'webui', 'bin')
  if (!['ekko-studio-mcp.mjs', 'hermes-studio-mcp.mjs', 'hermes-web-ui-mcp.mjs'].some(name => resolve(script) === join(bin, name))) {
    return null
  }
  return argv.slice(1)
}

export async function runBundledMcpCli(args: string[]): Promise<number> {
  return await new Promise(resolveExit => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
      windowsHide: true,
    })
    const terminate = () => { child.kill('SIGTERM') }
    const interrupt = () => { child.kill('SIGINT') }
    process.on('SIGTERM', terminate)
    process.on('SIGINT', interrupt)
    process.once('exit', terminate)
    const cleanup = () => {
      process.removeListener('SIGTERM', terminate)
      process.removeListener('SIGINT', interrupt)
      process.removeListener('exit', terminate)
    }
    child.once('error', error => {
      cleanup()
      console.error(`Failed to start bundled MCP: ${error.message}`)
      resolveExit(1)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      resolveExit(code ?? (signal === 'SIGINT' ? 130 : 143))
    })
  })
}
