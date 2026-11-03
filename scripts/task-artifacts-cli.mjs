#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTaskArtifacts, createTaskArtifactDirectory, taskArtifactsRoot } from './task-artifacts.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const command = process.argv[2] || 'check'
try {
  if (command === 'dir') console.log(taskArtifactsRoot(root))
  else if (command === 'new') console.log(await createTaskArtifactDirectory(root, process.argv[3]))
  else if (command === 'check') {
    const failures = await checkTaskArtifacts(process.argv[3] || root)
    if (failures.length) {
      console.error(failures.join('\n'))
      process.exitCode = 1
    } else console.log('Task artifact policy passed (read-only; protected data and build/dependency outputs excluded).')
  } else throw new Error('Usage: task-artifacts-cli.mjs check [checkout] | dir | new <task-label>')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
