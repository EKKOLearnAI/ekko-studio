import { randomUUID } from 'node:crypto'

export function apply(ctx) {
  const schema = { type:'object', properties:{ text:{ type:'string', minLength:1, maxLength:4000 } }, required:['text'], additionalProperties:false }
  const updateSchema = { type:'object', properties:{ id:{ type:'string', minLength:1 }, done:{ type:'boolean' } }, required:['id','done'], additionalProperties:false }
  // UI, tools and workflow writes share one queue so concurrent updates cannot lose notes.
  let tail = Promise.resolve()
  function serial(work) { const next = tail.catch(() => {}).then(work); tail = next; return next }
  async function read() {
    const notes = await ctx.state.plugin.get('notes') || []
    if (!Array.isArray(notes)) throw new Error('便签数据格式不正确')
    return notes
  }
  function append(text, run, origin) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('请输入 1–4000 个字符')
    return serial(async () => {
      run.signal.throwIfAborted()
      const notes = await read()
      const note = { id:randomUUID(), text:text.trim(), done:false, origin, createdAt:Date.now(), sessionId:run.identity.sessionId || null }
      await ctx.state.plugin.set('notes', [...notes, note].slice(-100))
      run.messages.emit('notebook.updated', { id:note.id, action:'append' }, { audience:'plugin' })
      return note
    })
  }
  function change(input, run, remove = false) {
    if (!input || typeof input.id !== 'string' || (!remove && typeof input.done !== 'boolean')) throw new Error('无效的便签操作')
    return serial(async () => {
      run.signal.throwIfAborted()
      const notes = await read(), index = notes.findIndex(note => note.id === input.id)
      if (index < 0) throw new Error('便签已不存在，请刷新列表')
      if (remove) notes.splice(index, 1)
      else notes[index] = { ...notes[index], done:input.done }
      await ctx.state.plugin.set('notes', notes)
      run.messages.emit('notebook.updated', { id:input.id, action:remove ? 'remove' : 'update' }, { audience:'plugin' })
      return { ok:true }
    })
  }
  ctx.extensions.rpc.register('list', () => serial(read))
  ctx.extensions.rpc.register('get-preferences', async (_, run) => await run.state.plugin.namespace('preferences', String(run.identity.userId)).get('filter') || 'all')
  ctx.extensions.rpc.register('set-preferences', async (input, run) => {
    if (!['all', 'open', 'done'].includes(input?.filter)) throw new Error('无效的筛选选项')
    await run.state.plugin.namespace('preferences', String(run.identity.userId)).set('filter', input.filter)
    return { ok: true }
  })
  ctx.extensions.rpc.register('append', (input, run) => append(input?.text, run, 'ui'))
  ctx.extensions.rpc.register('update', (input, run) => change(input, run))
  ctx.extensions.rpc.register('remove', (input, run) => change(input, run, true))
  ctx.extensions.tools.register({ name:'append', description:'保存工作便签 / Save a shared note available across accounts and Profiles.', inputSchema:schema,
    async execute(input, run) { const note = await append(input.text, run, 'tool'); return { ok:true, content:'Note saved', data:note } } })
  ctx.extensions.tools.register({ name:'list', description:'读取工作便签及完成状态 / Read notes, IDs and completion states.', readOnly:true, inputSchema:{ type:'object', additionalProperties:false },
    async execute() { const notes = await serial(read); return { ok:true, content:JSON.stringify(notes), data:notes } } })
  ctx.extensions.tools.register({ name:'complete', description:'标记便签完成或恢复待办 / Set a note completion state by ID.', inputSchema:updateSchema,
    async execute(input, run) { await change(input, run); return { ok:true, content:input.done ? 'Note completed' : 'Note reopened' } } })
  ctx.extensions.commands.register({ name:'note', description:'保存便签：/notebook:note 你的内容', async execute(text, run) { await append(text, run, 'command'); return '便签已保存' } })
  ctx.extensions.actions.register({ name:'capture', description:'将工作流上游输出保存为便签', inputSchema:{ type:'object', properties:{ input:{ type:'string', minLength:1, maxLength:4000 } }, required:['input'] }, execute:(input, run) => append(input.input, run, 'workflow') })
  ctx.lifecycle.add(() => tail.catch(() => {}))
}
