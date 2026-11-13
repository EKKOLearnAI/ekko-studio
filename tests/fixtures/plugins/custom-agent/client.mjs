export async function mount(root, ctx) {
  const title = document.createElement('h2')
  title.textContent = 'Custom Agent settings'
  const label = document.createElement('label')
  label.textContent = 'Local echo prefix '
  const input = document.createElement('input')
  input.setAttribute('aria-label', 'Local echo prefix')
  input.value = (await ctx.rpc.call('get-settings')).prefix
  label.append(input)
  const button = document.createElement('button')
  button.textContent = 'Save settings'
  button.onclick = async () => {
    button.disabled = true
    try { await ctx.rpc.call('save-settings', { prefix: input.value }); ctx.ui.notify('Settings saved', 'success') }
    catch (error) { ctx.ui.notify(String(error), 'error') }
    finally { button.disabled = false }
  }
  root.append(title, label, button)
}
