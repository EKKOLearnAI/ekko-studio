import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { Context } from 'koa'

function openApiCandidatePaths(): string[] {
  return [
    // Dev/test from source tree.
    resolve(process.cwd(), 'docs/openapi.json'),
    resolve(__dirname, '../../../../../../docs/openapi.json'),
    // Bundled server: scripts/build-server.mjs copies the doc next to index.js.
    resolve(__dirname, 'openapi.json'),
    resolve(__dirname, '../openapi.json'),
  ]
}

function readOpenApiDocument(): unknown {
  for (const filePath of openApiCandidatePaths()) {
    if (!existsSync(filePath)) continue
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  }
  return null
}

export async function openapi(ctx: Context) {
  const doc = readOpenApiDocument()
  if (!doc) {
    ctx.status = 404
    ctx.body = { error: 'OpenAPI document is not available' }
    return
  }

  ctx.set('Cache-Control', 'no-store')
  ctx.body = doc
}
