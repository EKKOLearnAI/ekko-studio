import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Harness scripts are plain Node modules.
import { checkJevIntegrations, jevHarnessViolations, jevUsage } from '../../scripts/jev-harness.mjs'

const root = resolve(import.meta.dirname, '../..')
const registered = JSON.parse(readFileSync(resolve(root, 'scripts/jev-integrations.json'), 'utf8'))
const consumer = 'packages/server/src/modules/hermes/services/jev-example.ts'

function fixture() {
  const manifest = structuredClone(registered)
  const { server, client, form } = manifest.settings
  const integration = manifest.integrations[0]
  const files = [server, client, form, manifest.settings.host, ...manifest.integrations.flatMap((item: typeof integration) => [item.runtimeConfig.file, ...item.sources, ...item.tests])]
  const sources = new Map<string, string>(files.map(file => [file, readFileSync(resolve(root, file), 'utf8')]))
  const labels = Object.values(manifest.settings.fields).map((field: any) => field.label as string)
  sources.set('packages/client/src/i18n/locales/en.ts', `export default ${JSON.stringify({
    jev: Object.fromEntries(labels.filter(label => label.startsWith('jev.')).map(label => [label.slice(4), label])),
    profiles: { model: 'Model' },
  })}`)
  const change = (file: string, before: string, after: string) => {
    expect(sources.get(file)).toContain(before)
    sources.set(file, sources.get(file)!.replace(before, after))
  }
  return { manifest, sources, change, server, client, form, integration }
}

describe('JEV integration harness', () => {
  it('accepts the registered memory integrations', () => {
    const { sources, manifest } = fixture()
    expect(jevHarnessViolations(sources, manifest)).toEqual([])
  })

  it('discovers nested consumers and missing regression tests in an isolated repository', async () => {
    const { sources, manifest, integration } = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'jev-harness-'))
    const write = async (file: string, source: string) => {
      const target = join(directory, file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, source)
    }
    try {
      await write('scripts/jev-integrations.json', JSON.stringify(manifest))
      await Promise.all([...sources].map(([file, source]) => write(file, source)))
      expect(await checkJevIntegrations(directory)).toEqual([])

      const consumers = [
        'packages/server/src/nested/consumer.ts',
        'packages/client/src/nested/Consumer.vue',
        'packages/ekko-agent/src/nested/consumer.ts',
      ]
      await Promise.all(consumers.map(file => write(file, file.endsWith('.vue')
        ? '<script setup lang="ts">runtime.jev.tryEvaluate(request)</script>'
        : 'runtime.jev.tryEvaluate(request)')))
      await rm(join(directory, integration.tests[0]))
      const failures = (await checkJevIntegrations(directory)).join('\n')
      for (const file of consumers) expect(failures).toContain(`${file} is an unregistered JEV integration`)
      expect(failures).toContain(`missing required file ${integration.tests[0]}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    `import { evaluateJev as judge } from '../../studio/public/jev'; judge(profile, request)`,
    `import * as evaluator from '../../studio/public/jev'; evaluator.evaluateJev(profile, request)`,
    `runtime.jev.tryEvaluate(request)`,
    `runtime['jev']['evaluate'](request)`,
    `const { jev: evaluator } = runtime; evaluator.evaluate(request)`,
    `const module = await import('../../studio/public/jev')`,
    `fetch('/api/studio/jev/evaluate', options)`,
  ])('rejects an unregistered business integration: %s', source => {
    const { sources, manifest } = fixture()
    sources.set(consumer, source)
    expect(jevHarnessViolations(sources, manifest).join('\n')).toContain(`${consumer} is an unregistered JEV integration`)
  })

  it('ignores comments and type-only imports instead of treating them as integrations', () => {
    const usage = jevUsage(consumer, `
      // runtime.jev.evaluate(request)
      /* import { evaluateJev } from '../../studio/public/jev' */
      import type { Questions } from '@typesafe-ai/sdk'
      import { type EkkoJevConfig } from 'ekko-agent'
    `)
    expect(usage).toEqual({ used: false, evaluates: false, directSdk: false })
  })

  it.each([
    `import { TypeSafeClient as Client } from '@typesafe-ai/sdk'; new Client(options)`,
    `import * as sdk from '@typesafe-ai/sdk'; new sdk.TypeSafeClient(options)`,
    `const sdk = require('@typesafe-ai/sdk')`,
    `const sdk = await import('@typesafe-ai/sdk')`,
  ])('rejects direct provider SDK use even in a registered integration: %s', source => {
    const { sources, manifest, integration } = fixture()
    sources.set(integration.sources[0], source)
    expect(jevHarnessViolations(sources, manifest).join('\n')).toContain('business integrations must use the public JEV facade')
  })

  it('requires a default-off boolean switch', () => {
    const f = fixture()
    f.change(f.server, 'ekkoMemoryEnabled: false', 'ekkoMemoryEnabled: true')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('requires its own boolean switch with a false default')
  })

  it('requires independent switches rather than reusing another feature switch', () => {
    const f = fixture()
    f.sources.set(consumer, `import { evaluateJev } from '../../studio/public/jev'`)
    f.manifest.integrations.push({ ...f.integration, id: 'other', sources: [consumer] })
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('must belong to one integration')
  })

  it('rejects a commented-out switch and a wrong binding', () => {
    for (const mutation of ['comment', 'binding']) {
      const f = fixture()
      const control = f.sources.get(f.form)!.match(/<NSwitch[^>]+\/>/)![0]
      f.change(f.form, control, mutation === 'comment' ? `<!-- ${control} -->` : control.replace('settings.ekkoMemoryEnabled', 'settings.unrelated'))
      expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('ekkoMemoryEnabled needs an editable NSwitch')
    }
  })

  it('requires new persisted options to have a frontend entry and integration owner', () => {
    const f = fixture()
    f.change(f.server, 'const defaults: StoredSettings = {', 'const defaults: StoredSettings = { recallThreshold: 0.7,')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('recallThreshold has no registered frontend configuration entry')
    f.manifest.settings.fields.recallThreshold = { control: 'NInputNumber', binding: 'settings.recallThreshold', label: 'jev.timeout' }
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('recallThreshold must be owned by a registered JEV integration')
  })

  it('rejects a switch that is displayed but never saved', () => {
    const f = fixture()
    f.change(f.form, 'saveJevSettings(profile, { baseUrl, model, timeoutMs, ekkoMemoryEnabled,', 'saveJevSettings(profile, { baseUrl, model, timeoutMs,')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('ekkoMemoryEnabled is not submitted')
  })

  it('rejects missing server validation and response wiring', () => {
    const f = fixture()
    f.change(f.server, "'apiKey', 'ekkoMemoryEnabled'", "'apiKey'")
    f.change(f.server, 'ekkoMemoryEnabled: value.ekkoMemoryEnabled, ', '')
    const failures = jevHarnessViolations(f.sources, f.manifest).join('\n')
    expect(failures).toContain('be accepted by settings validation')
    expect(failures).toContain('round-trip through matching server and client settings')
  })

  it('rejects accepted options that normalization silently drops', () => {
    const f = fixture()
    f.change(f.server, 'next.ekkoMemoryEnabled = value.ekkoMemoryEnabled', '')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('be accepted by settings validation and normalization')
  })

  it('rejects an orphaned settings form with no frontend page entry', () => {
    const f = fixture()
    f.change(f.manifest.settings.host, '<JevSettingsPanel :profile="selectedProfile" />', '<!-- <JevSettingsPanel :profile="selectedProfile" /> -->')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('must be mounted in its declared frontend page')
  })

  it.each([' readonly', ' :disabled="true"'])('rejects permanently uneditable settings controls: %s', attribute => {
    const f = fixture()
    f.change(f.form, '<NSwitch ', `<NSwitch${attribute} `)
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('needs an editable NSwitch')
  })

  it('requires value bindings to have a working update handler', () => {
    const f = fixture()
    f.change(f.form, '@update:value="value => { if (value !== null) settings!.timeoutMs = value }"', '')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('timeoutMs needs an editable NInputNumber')
  })

  it('requires the UI label in every locale', () => {
    const f = fixture()
    f.sources.set('packages/client/src/i18n/locales/fr.ts', 'export default {}')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('missing label jev.ekkoMemoryEnabled')
  })

  it('requires configuration transport and standalone defaults to retain the switch', () => {
    const f = fixture()
    f.change(f.server, 'memoryEnabled: ekkoMemoryEnabled', 'memoryEnabled: false')
    f.change(f.integration.runtimeConfig.file, 'memoryEnabled: false', 'memoryEnabled: true')
    const failures = jevHarnessViolations(f.sources, f.manifest).join('\n')
    expect(failures).toContain('must map ekkoMemoryEnabled to memoryEnabled')
    expect(failures).toContain('standalone runtime switch must also default to false')
  })

  it('does not allow a configuration-only registration to hide an evaluation call', () => {
    const f = fixture()
    f.integration.status = 'configuration-only'
    f.sources.set(f.integration.sources[0], f.sources.get(f.integration.sources[0]) + '\nruntime.jev.tryEvaluate(request)')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('configuration-only registration cannot evaluate JEV')
    f.integration.status = 'active'
    expect(jevHarnessViolations(f.sources, f.manifest)).toEqual([])
  })

  it('requires registration when runtime wiring starts evaluating JEV', () => {
    const f = fixture()
    const runtime = 'packages/ekko-agent/src/runtime/runtime.ts'
    f.sources.set(runtime, `import { EkkoJevClient } from '../jev'; const jev = new EkkoJevClient(options)`)
    expect(jevHarnessViolations(f.sources, f.manifest)).toEqual([])
    f.sources.set(runtime, f.sources.get(runtime) + '\nruntime.jev.tryEvaluate(request)')
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain(`${runtime} is an unregistered JEV integration`)
    f.integration.sources.push(runtime)
    f.integration.status = 'configuration-only'
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('configuration-only registration cannot evaluate JEV')
    f.integration.status = 'active'
    expect(jevHarnessViolations(f.sources, f.manifest)).toEqual([])
  })

  it('does not exempt provider SDK creation in configuration infrastructure', () => {
    const f = fixture()
    f.sources.set('packages/ekko-agent/src/setup.ts', `import { TypeSafeClient } from '@typesafe-ai/sdk'; new TypeSafeClient(options)`)
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('business integrations must use the public JEV facade')
  })

  it('rejects missing source and regression test files', () => {
    const f = fixture()
    f.sources.delete(f.integration.sources[0])
    f.sources.delete(f.integration.tests[0])
    expect(jevHarnessViolations(f.sources, f.manifest).join('\n')).toContain('missing required file')
  })
})
