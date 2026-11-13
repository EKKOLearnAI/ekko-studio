export async function mount(root, ctx) {
  root.innerHTML = `
    <style>
      .desk { display:grid; gap:20px; padding:8px; color:var(--text-primary); }
      .desk h2,.desk p { margin:0; } .desk h2 { font-size:26px; letter-spacing:-.5px; }
      .desk .eyebrow { color:var(--accent-primary); font-size:11px; letter-spacing:2px; font-weight:700; margin-bottom:8px; }
      .desk .muted { color:var(--text-secondary); font-size:12px; line-height:1.7; }
      .desk header,.desk .toolbar,.desk footer { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
      .desk button:hover { border-color:var(--accent-primary); }
      .desk button:disabled { cursor:wait; opacity:.5; }
      .desk :is(button,input,select):focus-visible { outline:2px solid var(--accent-primary); outline-offset:3px; }
      .desk .stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
      .desk .stat { border:1px solid var(--border-color); border-radius:12px; padding:16px; }
      .desk .stat strong { display:block; font-size:30px; font-weight:650; margin:4px 0; }
      .desk input { flex:1; min-width:140px; padding:10px 12px; } .desk select { padding:10px; max-width:100%; }
      .desk .rows { max-height:400px; overflow:auto; display:grid; gap:8px; }
      .desk .session { width:100%; text-align:left; padding:14px; display:flex; align-items:center; gap:14px; border-radius:10px; background:transparent; }
      .desk .session-main { min-width:0; flex:1; } .desk .session-title { display:block; font-weight:600; margin-bottom:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .desk .badge { display:inline-block; font-size:11px; border:1px solid var(--border-color); padding:2px 7px; border-radius:20px; margin-right:8px; color:var(--accent-primary); }
      .desk .arrow { color:var(--accent-primary); font-size:20px; }
      .desk .empty { padding:35px 12px; text-align:center; color:var(--text-secondary); border:1px dashed var(--border-color); border-radius:10px; }
      .desk footer { border-top:1px solid var(--border-color); padding-top:14px; }
      @media(max-width:480px) { .desk { padding:0; gap:14px; } .desk h2 { font-size:22px; } .desk .stat { padding:10px; } .desk .stat strong { font-size:24px; } .desk .toolbar { align-items:stretch; } .desk .toolbar input { flex-basis:100%; } }
    </style>
    <section class="desk">
      <header><div><p class="eyebrow">01 / SESSION DESK</p><h2>会话，一眼看清</h2><p class="muted" data-profile></p></div><button type="button" data-refresh>刷新会话</button></header>
      <div class="stats"><div class="stat"><span class="muted">当前 Profile 会话</span><strong data-total>—</strong><span class="muted">来自你的 Studio</span></div><div class="stat"><span class="muted">已加载消息数</span><strong data-messages>—</strong><span class="muted">已加载会话内的消息</span></div><div class="stat"><span class="muted">最近 7 天活跃</span><strong data-recent>—</strong><span class="muted">在已加载会话中</span></div></div>
      <div class="toolbar"><input type="search" aria-label="搜索会话" placeholder="搜索已加载会话的标题…"><select aria-label="按 Agent 筛选"><option value="">所有 Agent</option></select></div>
      <p class="muted" role="status" data-status>正在读取会话…</p><div class="rows"></div>
      <footer><span class="muted" data-updated>点击会话即可继续对话</span><button type="button" data-more hidden>加载更多会话</button></footer>
    </section>`
  const $ = selector => root.querySelector(selector)
  const rows = $('.rows'), search = $('input'), filter = $('select'), refresh = $('[data-refresh]'), more = $('[data-more]')
  $('[data-profile]').textContent = `Profile · ${ctx.identity.profile} · 点击标题继续对话`
  let sessions = [], total = 0, hasMore = false, busy = false, disposed = false
  const stamp = value => { const number = Number(value); return Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : 0 }
  const agent = session => session.agent || (session.source === 'builtin_agent' ? 'ekko-agent' : session.source === 'coding_agent' ? 'coding-agent' : 'hermes')
  const labels = { 'ekko-agent':'Ekko', codex:'Codex', claude:'Claude Code', hermes:'Hermes', pi:'Pi', 'coding-agent':'Coding Agent' }
  function render() {
    const query = search.value.trim().toLocaleLowerCase()
    const visible = sessions.filter(s => (!filter.value || agent(s) === filter.value) && `${s.title || ''} ${s.id}`.toLocaleLowerCase().includes(query))
    $('[data-total]').textContent = String(total)
    $('[data-messages]').textContent = String(sessions.reduce((sum, s) => sum + (Number(s.message_count) || 0), 0))
    $('[data-recent]').textContent = String(sessions.filter(s => stamp(s.last_active || s.started_at) >= Date.now() - 7 * 86400000).length)
    $('[data-status]').textContent = `已加载 ${sessions.length} / ${total} 个会话 · 匹配 ${visible.length} 个`
    rows.replaceChildren(...visible.map(session => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'session'
      const main = document.createElement('span'); main.className = 'session-main'
      const title = document.createElement('span'); title.className = 'session-title'; title.textContent = session.title || '未命名会话'
      const meta = document.createElement('span'); meta.className = 'muted'
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = labels[agent(session)] || agent(session)
      const date = stamp(session.last_active || session.started_at)
      meta.append(badge, document.createTextNode(`${Number(session.message_count) || 0} 条消息 · ${date ? new Date(date).toLocaleString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '暂无时间'}`))
      const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true')
      main.append(title, meta); row.append(main, arrow)
      row.onclick = () => ctx.ui.navigate(`/hermes/session/${encodeURIComponent(session.id)}`)
      return row
    }))
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = sessions.length ? '没有匹配的会话，试试其他关键词。' : '还没有会话。开始一段对话后，在这里刷新即可看到。'; rows.append(empty) }
    more.hidden = !hasMore
  }
  async function load(append = false) {
    if (busy || disposed) return
    busy = true; refresh.disabled = more.disabled = true
    $('[data-status]').textContent = '正在读取会话…'
    try {
      const result = await ctx.host.request('/api/studio/sessions', { query:{ limit:60, offset:append ? sessions.length : 0 } })
      if (disposed) return
      const incoming = Array.isArray(result.sessions) ? result.sessions : []
      sessions = append ? [...sessions, ...incoming] : incoming
      total = typeof result.total === 'number' ? result.total : sessions.length; hasMore = Boolean(result.hasMore)
      const selection = filter.value
      filter.replaceChildren(new Option('所有 Agent', ''), ...[...new Set(sessions.map(agent))].sort().map(id => new Option(labels[id] || id, id)))
      if ([...filter.options].some(o => o.value === selection)) filter.value = selection
      render(); $('[data-updated]').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')} · 仅展示当前 Profile`
    } catch (error) { if (!disposed) $('[data-status]').textContent = `读取失败：${error.message}，可点击刷新重试。` }
    finally { busy = false; refresh.disabled = more.disabled = false }
  }
  search.oninput = render; filter.onchange = render; refresh.onclick = () => load(); more.onclick = () => load(true)
  ctx.lifecycle.add(() => { disposed = true; search.oninput = filter.onchange = refresh.onclick = more.onclick = null })
  await load()
}
