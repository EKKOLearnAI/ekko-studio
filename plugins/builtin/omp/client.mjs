const text = {
  zh: {
    title: 'OMP 设置', intro: '全局模式使用本页的 OMP 模型与凭证；scoped 模式使用 Studio 选择的模型。配置按当前账号与 Profile 保存。',
    engine: '运行环境', status: '引擎状态', installed: '已安装', missing: '未安装', management: '打开 Agent 管理', install: '首次安装或升级：在 Agent 管理中点击 OMP 的“检查更新”，再选择升级版本。',
    executable: 'OMP 可执行文件（可选）', executableHelp: '留空使用 Studio 管理的 OMP；也可以填写已安装 OMP 的绝对路径。',
    native: '全局模型', model: '默认模型', modelHelp: '填写 provider/model；也可以留空，在聊天时选择 OMP 提供的原生模型。',
    models: '模型与凭证（JSON）', modelsHelp: '使用 OMP models.yml 的 providers 结构。已有密钥会遮蔽显示，保留遮蔽值即可保持原密钥。',
    example: '查看配置示例', config: 'OMP 运行设置（JSON）', configHelp: '使用 OMP config.yml 的设置结构。scoped 模式的模型绑定由 Studio 注入。',
    save: '保存配置', saved: '配置已保存', loading: '正在读取配置…', retry: '重新读取', docs: 'OMP 配置文档',
  },
  en: {
    title: 'OMP settings', intro: 'Global mode uses OMP models and credentials from this page. Scoped mode uses the model selected in Studio. Settings belong to the current account and Profile.',
    engine: 'Runtime', status: 'Engine status', installed: 'Installed', missing: 'Not installed', management: 'Open Agent management', install: 'To install or upgrade, check for OMP updates in Agent management, then select the target version.',
    executable: 'OMP executable (optional)', executableHelp: 'Leave empty for the Studio-managed engine, or enter an absolute path to an existing OMP executable.',
    native: 'Global models', model: 'Default model', modelHelp: 'Use provider/model, or leave empty and choose an OMP native model in chat.',
    models: 'Models and credentials (JSON)', modelsHelp: 'Use the OMP models.yml providers structure. Saved secrets are masked; leave the masked value to retain a secret.',
    example: 'Configuration example', config: 'OMP runtime settings (JSON)', configHelp: 'Use the OMP config.yml settings structure. Studio supplies the model binding in scoped mode.',
    save: 'Save settings', saved: 'Settings saved', loading: 'Loading settings…', retry: 'Reload', docs: 'OMP configuration docs',
  },
}
export async function mount(root, ctx) {
  const t = text[(ctx.locale || navigator.language).startsWith('zh') ? 'zh' : 'en']
  let disposed = false
  ctx.onDispose(() => { disposed = true })
  const style = document.createElement('style')
  style.textContent = '.omp-settings{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:24px}.omp-settings h1{font-size:22px;margin:0}.omp-settings h2{font-size:16px;margin:0 0 12px}.omp-settings p{color:var(--text-secondary);line-height:1.6;margin:8px 0}.omp-section{border-bottom:1px solid var(--border-color);padding-bottom:20px}.omp-field{display:flex;flex-direction:column;gap:8px;margin:16px 0}.omp-field input,.omp-field textarea{width:100%}.omp-field textarea{font-family:ui-monospace,monospace;resize:vertical;min-height:160px;line-height:1.5}.omp-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.omp-settings a{color:var(--accent-primary)}.omp-error{color:var(--text-primary);white-space:pre-wrap}.omp-settings summary{cursor:pointer;color:var(--text-secondary)}.omp-settings pre{white-space:pre-wrap;overflow-wrap:anywhere}'
  const container = document.createElement('section'); container.className = 'omp-settings'
  const element = (tag, content) => { const value = document.createElement(tag); if (content) value.textContent = content; return value }
  const status = element('p', t.loading); status.setAttribute('role', 'status')
  const runtime = element('section'); runtime.className = 'omp-section'; runtime.append(element('h2', t.engine))
  const version = element('p'); runtime.append(version, element('p', t.install))
  const manage = element('button', t.management); manage.type = 'button'; manage.onclick = () => ctx.ui.navigate('/studio/agents'); runtime.append(manage)
  const field = (parent, label, help, area = false) => {
    const wrapper = element('label'); wrapper.className = 'omp-field'; wrapper.append(element('strong', label))
    const input = element(area ? 'textarea' : 'input'); input.setAttribute('aria-label', label); if (area) input.rows = 10
    input.spellcheck = false; wrapper.append(input, element('p', help)); parent.append(wrapper); return input
  }
  const executable = field(runtime, t.executable, t.executableHelp)
  const native = element('section'); native.className = 'omp-section'; native.append(element('h2', t.native))
  const model = field(native, t.model, t.modelHelp); model.placeholder = 'provider/model'
  const models = field(native, t.models, t.modelsHelp, true)
  const example = element('details'); example.append(element('summary', t.example), element('pre', JSON.stringify({ providers: { custom: { baseUrl: 'https://your-provider.example/v1', api: 'openai-completions', apiKey: 'YOUR_API_KEY', models: [{ id: 'your-model', name: 'Your model' }] } } }, null, 2)))
  const docs = element('a', t.docs); docs.href = 'https://github.com/can1357/oh-my-pi/blob/main/docs/models.md'; docs.target = '_blank'; docs.rel = 'noopener noreferrer'; example.append(docs); native.append(example)
  const advanced = element('section'); advanced.append(element('h2', t.config))
  const config = field(advanced, t.config, t.configHelp, true)
  const actions = element('div'); actions.className = 'omp-actions'
  const save = element('button', t.save); save.type = 'button'; save.disabled = true
  const retry = element('button', t.retry); retry.type = 'button'; actions.append(save, retry)
  container.append(element('h1', t.title), element('p', t.intro), runtime, native, advanced, actions, status); root.append(style, container)
  async function load() {
    const value = await ctx.rpc('get-settings')
    if (disposed) return
    executable.value = value.executable; model.value = value.defaultModel
    models.value = JSON.stringify(value.models, null, 2); config.value = JSON.stringify(value.config, null, 2)
    version.textContent = `${t.status}: ${value.status.installed ? `${t.installed} ${value.status.version}` : t.missing}`
    status.textContent = value.status.error || ''; save.disabled = false
  }
  retry.onclick = () => { load().catch(error => { status.textContent = error.message }) }
  save.onclick = async () => {
    save.disabled = true
    try {
      await ctx.rpc('save-settings', { executable: executable.value, defaultModel: model.value,
        models: JSON.parse(models.value), config: JSON.parse(config.value) })
      await load(); status.textContent = t.saved; ctx.ui.notify(t.saved, 'success')
    } catch (error) { if (!disposed) status.textContent = error.message }
    finally { if (!disposed) save.disabled = false }
  }
  try { await load() } catch (error) { status.textContent = error.message }
}
