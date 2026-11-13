export async function mount(root, ctx) {
  if (ctx.slot === 'workspace-sidebar') {
    const title = document.createElement('p'); title.textContent = '最近的便签'; root.append(title)
    const list = document.createElement('div'); root.append(list)
    let alive = true
    async function refresh() {
      const notes = await ctx.rpc.call('list'); if (!alive) return
      list.replaceChildren(...notes.slice(-10).reverse().map(note => {
        const button = document.createElement('button'); button.style.display = 'block'; button.style.width = '100%'; button.textContent = note.text.slice(0, 24)
        button.onclick = () => ctx.ui.navigate(`/studio/plugins/${ctx.plugin.id}/notes?note=${encodeURIComponent(note.id)}`)
        return button
      }))
    }
    const unsubscribe = ctx.messages.on('notebook.updated', () => { void refresh().catch(() => {}) })
    ctx.lifecycle.add(() => { alive = false; unsubscribe() })
    await refresh(); return
  }
  if (ctx.view === 'usage') {
    root.textContent = `页面、Agent 工具、/${ctx.plugin.id}:note 命令和工作流共享便签数据。侧栏可打开最近便签，设置侧栏可调整个人偏好。`
    return
  }
  if (ctx.slot === 'settings') {
    const label = document.createElement('label'); label.textContent = '默认筛选：'
    const select = document.createElement('select')
    for (const [value, text] of [['all', '全部'], ['open', '待完成'], ['done', '已完成']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option) }
    select.value = await ctx.rpc.call('get-preferences')
    select.onchange = async () => { await ctx.rpc.call('set-preferences', { filter: select.value }); ctx.ui.notify('已保存', 'success') }
    label.append(select); root.append(label); return
  }
  root.innerHTML = `
    <style>
      .notebook { display:grid; gap:18px; padding:8px; color:var(--text-primary); }
      .notebook h2,.notebook p { margin:0; } .notebook h2 { font-size:26px; letter-spacing:-.5px; }
      .notebook .eyebrow { color:var(--accent-primary); font-size:11px; letter-spacing:2px; font-weight:700; margin-bottom:8px; }
      .notebook .muted { color:var(--text-secondary); font-size:12px; line-height:1.7; }
      .notebook header,.notebook .compose-footer,.notebook .filters { display:flex; gap:10px; justify-content:space-between; align-items:center; flex-wrap:wrap; }
      .notebook .stats { display:flex; gap:22px; padding:14px 0; border-block:1px solid var(--border-color); }
      .notebook .stats strong { font-size:24px; margin-right:6px; }
      .notebook textarea { width:100%; min-height:90px; resize:vertical; padding:12px; line-height:1.6; border-radius:10px; }
      .notebook .compose-footer { margin-top:8px; } .notebook .save { border-color:var(--accent-primary); color:var(--accent-primary); padding:8px 18px; font-weight:600; }
      .notebook button:hover { border-color:var(--accent-primary); } .notebook button:disabled { opacity:.45; cursor:not-allowed; }
      .notebook :is(button,textarea):focus-visible { outline:2px solid var(--accent-primary); outline-offset:3px; }
      .notebook .filters { justify-content:flex-start; } .notebook .filters button { background:transparent; padding:6px 12px; border-radius:20px; }
      .notebook .filters button[aria-pressed=true] { color:var(--accent-primary); border-color:var(--accent-primary); }
      .notebook .notes { display:grid; gap:10px; max-height:360px; overflow:auto; }
      .notebook .note { display:flex; align-items:flex-start; gap:12px; padding:14px; border:1px solid var(--border-color); border-radius:12px; }
      .notebook .note-content { flex:1; min-width:0; } .notebook .note-text { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.7; margin-bottom:8px; }
      .notebook .done .note-text { text-decoration:line-through; color:var(--text-secondary); }
      .notebook .check { width:26px; min-width:26px; height:26px; border-radius:50%; padding:0; background:transparent; }
      .notebook .check[aria-pressed=true] { color:var(--accent-primary); border-color:var(--accent-primary); }
      .notebook .delete { background:transparent; color:var(--text-secondary); font-size:11px; padding:4px 7px; }
      .notebook .empty { padding:26px 12px; text-align:center; color:var(--text-secondary); border:1px dashed var(--border-color); border-radius:10px; }
      .notebook .hint { border-left:3px solid var(--accent-primary); padding:4px 12px; } .notebook code { overflow-wrap:anywhere; }
      @media(max-width:480px) { .notebook { padding:0; gap:14px; } .notebook h2 { font-size:22px; } .notebook .note { padding:10px; gap:8px; } .notebook .stats { gap:16px; } }
    </style>
    <section class="notebook">
      <header><div><p class="eyebrow">02 / SHARED NOTES</p><h2></h2><p class="muted" data-profile></p></div><button type="button" data-refresh>刷新便签</button></header>
      <div class="stats"><span><strong data-open>0</strong><span class="muted">待完成</span></span><span><strong data-done>0</strong><span class="muted">已完成</span></span><span><strong data-total>0</strong><span class="muted">全部</span></span></div>
      <div class="compose"><textarea aria-label="便签内容" placeholder="记下一个想法，或交给 Agent 帮你记录…" maxlength="4000"></textarea><div class="compose-footer"><span class="muted" data-count>0 / 4000 · Ctrl / ⌘ + Enter 保存</span><button class="save" type="button" disabled>添加便签</button></div></div>
      <div class="filters" aria-label="筛选便签"><button type="button" data-filter="all" aria-pressed="true">全部</button><button type="button" data-filter="open" aria-pressed="false">待完成</button><button type="button" data-filter="done" aria-pressed="false">已完成</button></div>
      <p class="muted" role="status" data-status>正在读取便签…</p><div class="notes"></div>
      <div class="hint muted">也可以在聊天中输入<br><code>/notebook:note 记得验证插件效果</code><br>页面与 Agent 共用数据，刷新后仍然保留。最多保存最近 100 条。</div>
    </section>`
  const $ = selector => root.querySelector(selector), input = $('textarea'), save = $('.save'), list = $('.notes'), refresh = $('[data-refresh]')
  $('h2').textContent = ctx.config.title || '工作便签'
  $('[data-profile]').textContent = '全局共享 · 所有账号与 Profile · 页面与 Agent 同步'
  let notes = [], filter = 'all', busy = false, disposed = false, sequence = 0
  filter = await ctx.rpc.call('get-preferences')
  const origins = { ui:'页面记录', tool:'Agent 工具', command:'聊天命令', workflow:'工作流' }
  function controls() { save.disabled = busy || !input.value.trim(); input.disabled = busy; refresh.disabled = busy; for (const button of list.querySelectorAll('button')) button.disabled = busy }
  function render() {
    $('[data-total]').textContent = String(notes.length); $('[data-done]').textContent = String(notes.filter(n => n.done).length); $('[data-open]').textContent = String(notes.filter(n => !n.done).length)
    for (const button of root.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter))
    const visible = notes.filter(n => ctx.location.query.note ? n.id === ctx.location.query.note : filter === 'all' || (filter === 'done' ? n.done : !n.done)).slice().reverse()
    list.replaceChildren(...visible.map(note => {
      const row = document.createElement('article'); row.className = `note${note.done ? ' done' : ''}`
      const check = document.createElement('button'); check.type = 'button'; check.className = 'check'; check.textContent = note.done ? '✓' : '○'; check.setAttribute('aria-label', note.done ? '恢复待完成' : '标记完成'); check.setAttribute('aria-pressed', String(note.done))
      check.onclick = () => mutate(() => ctx.rpc.call('update', { id:note.id, done:!note.done }), note.done ? '已恢复待完成' : '已标记完成')
      const content = document.createElement('div'); content.className = 'note-content'
      const text = document.createElement('p'); text.className = 'note-text'; text.textContent = note.text
      const meta = document.createElement('p'); meta.className = 'muted'; meta.textContent = `${origins[note.origin] || '便签'} · ${new Date(note.createdAt).toLocaleString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}`
      content.append(text, meta)
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete'; remove.textContent = '删除'; remove.setAttribute('aria-label', '删除便签')
      remove.onclick = async () => { if (await ctx.ui.confirm('删除这条便签？此操作不可撤销。')) await mutate(() => ctx.rpc.call('remove', { id:note.id }), '便签已删除') }
      row.append(check, content, remove); return row
    }))
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = notes.length ? '这个分类还没有便签。' : '把第一条想法记在这里。'; list.append(empty) }
    controls()
  }
  async function load() {
    const current = ++sequence
    try { const value = await ctx.rpc.call('list'); if (disposed || current !== sequence) return; notes = value; render(); $('[data-status]').textContent = '已与后端同步' }
    catch (error) { if (!disposed && current === sequence) $('[data-status]').textContent = `读取失败：${error.message}`; throw error }
  }
  async function mutate(work, message) {
    if (busy || disposed) return
    busy = true; controls(); $('[data-status]').textContent = '正在保存…'
    try { await work(); await load(); if (!disposed) { $('[data-status]').textContent = message; ctx.ui.notify(message, 'success') } }
    catch (error) { if (!disposed) { $('[data-status]').textContent = error.message; ctx.ui.notify(error.message, 'error') } }
    finally { busy = false; if (!disposed) controls() }
  }
  function count() { $('[data-count]').textContent = `${input.value.length} / 4000 · Ctrl / ⌘ + Enter 保存`; controls() }
  // Sandboxed views use the RPC bridge instead of native HTML form submission.
  function submit() { if (!input.value.trim()) return; void mutate(async () => { await ctx.rpc.call('append', { text:input.value }); input.value = ''; count() }, '便签已保存') }
  save.onclick = submit
  input.oninput = count
  input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!busy) submit() } }
  refresh.onclick = () => { void load().catch(() => {}) }
  for (const button of root.querySelectorAll('[data-filter]')) button.onclick = () => { filter = button.dataset.filter; for (const item of root.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === button)); render() }
  const unsubscribe = ctx.messages.on('notebook.updated', () => { void load().catch(() => {}) })
  ctx.lifecycle.add(() => { disposed = true; unsubscribe(); save.onclick = input.oninput = input.onkeydown = refresh.onclick = null })
  await load().catch(() => {})
}
