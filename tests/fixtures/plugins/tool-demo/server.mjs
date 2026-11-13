export function apply(ctx) {
  ctx.extensions.tools.register({
    name: 'hello',
    description: '问候演示：输入名字，返回问候语及当前 Profile。可用于验证 Studio 插件工具的 MCP 注入；不修改数据、不调用模型。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '希望问候的名字，例如 Ekko', minLength: 1, maxLength: 80 } },
      required: ['name'],
      additionalProperties: false,
    },
    async execute({ name }, run) {
      const recipient = name.trim()
      if (!recipient) return { ok: false, content: '请输入名字。', error: 'Name cannot be blank' }
      return {
        ok: true,
        content: `你好，${recipient}！这是通过 MCP 调用的 Studio 插件工具。当前 Profile：${run.identity.profile}。`,
        data: { greeting: `你好，${recipient}！`, profile: run.identity.profile },
      }
    },
  })
}
