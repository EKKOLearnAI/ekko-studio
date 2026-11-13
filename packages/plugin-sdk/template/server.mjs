import { readFileSync } from 'node:fs'
import { assertContracts, registerRpc, validateModel } from './sdk/harness/contracts.mjs'
const contract = assertContracts(JSON.parse(readFileSync(new URL('./contracts/plugin.json', import.meta.url), 'utf8')))

/** @param {import('@ekko-studio/plugin-sdk').PluginContext} ctx */
export function apply(ctx) {
  const store = run => ctx.state.plugin.namespace(String(run.identity.userId), run.identity.profile)
  registerRpc(ctx, contract, 'get-settings', async (_input, run) =>
    validateModel(contract, 'settings', await store(run).get('settings') ?? { greeting: 'Hello', compact: false }))
  registerRpc(ctx, contract, 'save-settings', async (input, run) => {
    await store(run).set('settings', validateModel(contract, 'settings', input))
    return { ok: true }
  })
}
