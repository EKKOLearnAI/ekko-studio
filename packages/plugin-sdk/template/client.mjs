/** @param {HTMLElement} root @param {import('@ekko-studio/plugin-sdk').ClientContext} ctx */
export async function mount(root, ctx) {
  const editor = document.createElement('textarea')
  editor.rows = 12; editor.style.width = '100%'
  editor.value = JSON.stringify(await ctx.rpc.call('get-settings'), null, 2)
  const save = document.createElement('button')
  save.textContent = 'Save settings'
  save.onclick = async () => {
    try { await ctx.rpc.call('save-settings', JSON.parse(editor.value)); ctx.ui.notify('Saved', 'success') }
    catch (error) { ctx.ui.notify(error.message, 'error') }
  }
  root.append(editor, save)
}
