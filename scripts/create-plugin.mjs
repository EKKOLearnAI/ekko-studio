#!/usr/bin/env node
import { isAbsolute } from 'node:path'
import { scaffoldPlugin } from '../bin/plugin-development.mjs'
const [destination, id] = process.argv.slice(2)
if (!destination || !isAbsolute(destination)) throw new Error('Usage: node scripts/create-plugin.mjs /absolute/new/directory plugin-id')
console.log(`Plugin created at ${await scaffoldPlugin(destination, id)}. Register with ekko-studio plugins link <directory>.`)
