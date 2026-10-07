import { describe, expect, it, vi } from 'vitest'
import { openapi } from '../../packages/server/src/modules/studio/controllers/api-docs'

describe('api docs controller', () => {
  it('documents profile-scoped context manager controls and mutation guards', async () => {
    const ctx = { set: vi.fn(), status: 200, body: undefined as any }
    await openapi(ctx as any)
    const paths = ctx.body.paths
    const prefix = '/api/studio/context-manager'
    expect(ctx.body.tags).toContainEqual(expect.objectContaining({ name: 'Context Manager' }))
    for (const [path, methods] of Object.entries({
      [`${prefix}/settings`]: ['get', 'put'],
      [`${prefix}/health`]: ['get'],
      [`${prefix}/worker/restart`]: ['post'],
      [`${prefix}/lifecycle/{action}`]: ['post'],
    })) {
      for (const method of methods) {
        const operation = paths[path]?.[method]
        expect(operation).toBeDefined()
        expect(operation.tags).toEqual(['Context Manager'])
        expect(operation.parameters).toContainEqual(expect.objectContaining({
          name: 'X-Hermes-Profile', in: 'header', required: true,
        }))
        expect(operation.security).toEqual([{ BearerAuth: [] }])
        expect(operation.responses['409']).toBeDefined()
      }
    }
    const settings = paths[`${prefix}/settings`].put.requestBody.content['application/json'].schema
    expect(settings.additionalProperties).toBe(false)
    expect(settings.properties.hermes.properties.manager.enum).toEqual(['native', 'bili'])
    expect(settings.properties.ekko.properties.manager.enum).toEqual(['native', 'bili'])
    expect(settings.properties.proxyUrl.description).toContain('loopback')
    expect(settings.properties.allowNativeFallback.type).toBe('boolean')
    const lifecycle = paths[`${prefix}/lifecycle/{action}`].post
    expect(lifecycle.parameters).toContainEqual(expect.objectContaining({
      name: 'action', in: 'path', required: true,
      schema: { type: 'string', enum: ['install', 'start', 'stop', 'upgrade'] },
    }))
    expect(lifecycle.requestBody.content['application/json'].schema).toEqual({
      type: 'object', required: ['manager'], properties: { manager: { type: 'string', enum: ['hermes', 'ekko'] } },
    })
    const restart = paths[`${prefix}/worker/restart`].post.requestBody.content['application/json'].schema
    expect(restart.required).toEqual(['profile', 'confirm'])
    expect(restart.properties.confirm).toEqual({ type: 'boolean', enum: [true] })
    expect(paths[`${prefix}/health`].get.description).toContain('compatibility')
  })

  it('returns the OpenAPI route catalog', async () => {
    const ctx = {
      set: vi.fn(),
      status: 200,
      body: undefined as any,
    }

    await openapi(ctx as any)

    expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(ctx.body.openapi).toBe('3.0.3')
    expect(ctx.body.paths['/api/openapi.json']).toBeTruthy()
    expect(ctx.body.paths['/api/auth/login'].post.requestBody.content['application/json'].schema.required).toEqual([
      'password',
      'username',
    ])
    expect(ctx.body.paths['/api/auth/users/{id}'].put.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ])
    expect(ctx.body.paths['/api/hermes/kanban/search-sessions'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'task_id', in: 'query', required: true }),
        expect.objectContaining({ name: 'profile', in: 'query', required: true }),
        expect.objectContaining({ name: 'q', in: 'query', required: false }),
      ]),
    )
    expect(
      ctx.body.paths['/api/studio/chat-run/runs'].post.requestBody.content['application/json'].schema.properties.source.enum,
    ).toEqual(['cli', 'builtin_agent', 'coding_agent', 'global_agent', 'workflow', 'group_chat'])
    for (const path of ['/api/studio/sessions/hermes', '/api/studio/sessions/hermes/groups']) {
      expect(ctx.body.paths[path].get.parameters).toContainEqual(expect.objectContaining({
        name: 'agent_groups', in: 'query', required: false,
        schema: { type: 'string', enum: ['0', '1'], default: '0' },
      }))
    }
    expect(ctx.body.paths['/api/studio/sessions/hermes'].get.parameters.find((parameter: any) => parameter.name === 'source').schema).toEqual({ type: 'string' })

    for (const path of [
      '/api/studio/update/preview/prepare',
      '/api/studio/update/preview/start',
    ]) {
      expect(ctx.body.paths[path].post.requestBody).toEqual({
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
              },
            },
          },
        },
      })
    }
  })
})
