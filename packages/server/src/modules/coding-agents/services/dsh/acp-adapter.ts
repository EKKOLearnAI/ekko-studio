import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshPackageDirectory } from './installation'
import { DshPluginError } from './errors'

// New releases can use the adapter when the required integration seams remain
// compatible. Record the source hash for diagnostics, never as an allowlist.
export const DSH_ACP_ADAPTER_REVISION = 3

export async function writeDshAcpAdapter(installation: string, destination: string, acpAppDirectory: string) {
  // ACP belongs to the selected bundle and may be nested beneath it. Resolve
  // from that owner so we adapt the same copy the native profile would load.
  const directory = await dshPackageDirectory('@deepseek-ai/dsh-acp', [join(acpAppDirectory, 'package.json')])
  const filename = join(directory, 'lib/index.js')
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  let source = await readFile(filename, 'utf8')
  const sourceHash = createHash('sha256').update(source).digest('hex')
  const replace = (capability: string, before: string, after: string, count = 1) => {
    const found = source.split(before).length - 1
    if (found !== count) throw new DshPluginError(422, 'DSH_CAPABILITY_UNSUPPORTED',
      `DSH ACP ${manifest.version || 'unknown version'} is incompatible with Studio's ${capability} adapter: expected ${count} integration point(s), found ${found}. The installed DSH files were not changed.`)
    source = source.split(before).join(after)
  }
  replace('new-session preset selection', 'agentOptions: agentOptions(config),\n\t\t\t\t\tfallbackSelection:', 'agentOptions: agentOptions(config),\n\t\t\t\t\tagentPreset: params._meta?.agentPreset,\n\t\t\t\t\tfallbackSelection:')
  replace('preset persistence', 'meta: { cwd: options.cwd },', 'meta: { cwd: options.cwd, agentPreset: options.agentPreset },')
  replace('preset mounting', 'await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);',
    'await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);\n\t\t\t\tawait ctx.agentPresets.mount(agentCtx, options.agentPreset);', 2)
  replace('default preset selection', 'const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);',
    'options.agentPreset ??= ctx.agentPresets.defaultId;\n\t\tconst modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);')
  // Restoring uses the saved preset, including when the Web default changed.
  // Legacy ACP histories have no preset; they adopt the current Web default.
  replace('preset restoration', 'if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0) throw invalidParams(`session is not resumable: ${sessionId}`);',
    'if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0) throw invalidParams(`session is not resumable: ${sessionId}`);\n\t\t\t\tconst agentPreset = persisted.agentPreset ?? ctx.agentPresets.defaultId;')
  replace('resume-session preset selection', 'agentOptions: agentOptions(config),\n\t\t\t\t\t\tfallbackSelection:', 'agentOptions: agentOptions(config),\n\t\t\t\t\t\tagentPreset,\n\t\t\t\t\t\tfallbackSelection:')
  replace('turn persistence', 'if (inflight.messageQueued) {\n\t\t\t\tawait this.agent.whenIdle();\n\t\t\t\tawait this.outputTail;', 'if (inflight.messageQueued) {\n\t\t\t\tawait this.agent.whenIdle();\n\t\t\t\tawait this.outputTail;\n\t\t\t\tawait this.ctx.sessions.flush(this.agent.session);')
  // Apply after native restoration/preset initialization, before any prompt.
  // This also replaces persisted workspace-write/ask values on old sessions.
  replace('session permission policy', 'this.modelControl = modelControl;', 'this.modelControl = modelControl;\n\t\tsetSandboxMode(this.agent.session, "danger-full-access");\n\t\tsetApprovalPolicy(this.agent.session, "never");')
  source = 'import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";\nimport { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";\n' + source
  const require = createRequire(filename)
  // Absolute module URLs retain the installed release's dependency identity;
  // the adapter lives in Studio Home and must never resolve Studio's own SDK.
  source = source.replace(/from "([^"\n]+)"/g, (match, specifier: string) => specifier.startsWith('node:') ? match : `from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`)
  const license = await readFile(join(directory, 'LICENSE'), 'utf8').catch(() => readFile(join(dirname(installation), 'LICENSE'), 'utf8'))
  await writeFile(destination + '.LICENSE', license)
  await writeFile(destination, `// Studio DSH ACP adapter revision ${DSH_ACP_ADAPTER_REVISION}; upstream ${manifest.version} (MIT); source sha256 ${sourceHash}.\n` + source, { mode: 0o600 })
}
