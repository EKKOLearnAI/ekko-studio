import { describe, expect, it, vi } from 'vitest'
import { openapi } from '../../packages/server/src/modules/studio/controllers/api-docs'

describe('api docs controller', () => {
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
