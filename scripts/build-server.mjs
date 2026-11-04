import * as esbuild from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf-8'))
const version = pkg.version
const serverOutDir = resolve(rootDir, 'dist/server')

rmSync(serverOutDir, { recursive: true, force: true })
mkdirSync(serverOutDir, { recursive: true })

await esbuild.build({
  entryPoints: [resolve(rootDir, 'packages/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node23',
  format: 'cjs',
  outfile: resolve(serverOutDir, 'index.js'),
  external: ['node-pty', 'node:sqlite', 'sharp', 'socket.io'],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  sourcemap: true,
  minify: true,
  treeShaking: true,
  logLevel: 'info',
})

const bridgeOutDir = resolve(serverOutDir, 'agent-bridge', 'python')
const bridgeSrcDir = resolve(rootDir, 'packages/server/src/modules/hermes/services/bridge/python')
mkdirSync(bridgeOutDir, { recursive: true })
for (const fileName of readdirSync(bridgeSrcDir)) {
  if (fileName.endsWith('.py')) {
    cpSync(resolve(bridgeSrcDir, fileName), resolve(bridgeOutDir, fileName))
  }
}
chmodSync(resolve(bridgeOutDir, 'hermes_bridge.py'), 0o755)

const serverAssetsSrcDir = resolve(rootDir, 'packages/server/src/assets')
if (existsSync(serverAssetsSrcDir)) {
  cpSync(serverAssetsSrcDir, resolve(serverOutDir, 'assets'), { recursive: true })
}

cpSync(
  resolve(rootDir, 'docs/openapi.json'),
  resolve(serverOutDir, 'openapi.json'),
)

const skillsOutDir = resolve(rootDir, 'dist/skills')
rmSync(skillsOutDir, { recursive: true, force: true })
cpSync(
  resolve(rootDir, 'packages/skills'),
  skillsOutDir,
  { recursive: true },
)

const ekkoSkillsOutDir = resolve(rootDir, 'dist/ekko-skills')
rmSync(ekkoSkillsOutDir, { recursive: true, force: true })
cpSync(
  resolve(rootDir, 'packages/ekko-agent/skills'),
  ekkoSkillsOutDir,
  { recursive: true },
)

const firmwareOutDir = resolve(rootDir, 'dist/mcu')
const legacyFirmwareOutPath = resolve(firmwareOutDir, 'firmware.bin')
for (const firmwareVersion of ['v1', 'v2']) {
  const firmwareBuildSrc = resolve(rootDir, `packages/mcu/esp32-c3/${firmwareVersion}/.pio/build/esp32-c3-devkitm-1/firmware.bin`)
  const firmwareReleaseSrc = resolve(rootDir, `packages/mcu/esp32-c3/release/${firmwareVersion}/firmware.bin`)
  const firmwareVersionedOutDir = resolve(firmwareOutDir, firmwareVersion)
  const firmwareOutPath = resolve(firmwareVersionedOutDir, 'firmware.bin')
  let firmwareSrc = ''
  let sourceLabel = ''

  if (existsSync(firmwareBuildSrc)) {
    mkdirSync(dirname(firmwareReleaseSrc), { recursive: true })
    cpSync(firmwareBuildSrc, firmwareReleaseSrc)
    firmwareSrc = firmwareBuildSrc
    sourceLabel = 'PlatformIO build output'
  } else if (existsSync(firmwareReleaseSrc)) {
    firmwareSrc = firmwareReleaseSrc
    sourceLabel = 'release artifact'
  }

  if (!firmwareSrc) {
    console.warn(`[build-server] ESP32-C3 ${firmwareVersion} firmware not found, skipped dist/mcu/${firmwareVersion}/firmware.bin`)
    continue
  }

  mkdirSync(firmwareVersionedOutDir, { recursive: true })
  cpSync(firmwareSrc, firmwareOutPath)
  if (firmwareVersion === 'v1') cpSync(firmwareSrc, legacyFirmwareOutPath)
  console.log(`[build-server] ESP32-C3 ${firmwareVersion} firmware copied from ${sourceLabel}`)
}
