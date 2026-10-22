/**
 * Plumbing. DO NOT EDIT.
 */
export { createBackup } from './backups'
export { main } from './main'
export { init, uninit } from './init'
export { actions } from './actions'
import { buildManifest } from '@start9labs/start-sdk'
import { manifest as sdkManifest } from './manifest'
import { versionGraph } from './versions'
import { dependencies } from './dependencies'
export const manifest = buildManifest(versionGraph, sdkManifest, dependencies)
