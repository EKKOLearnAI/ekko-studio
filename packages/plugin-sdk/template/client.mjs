/** @param {HTMLElement} root @param {import('@ekko-studio/plugin-sdk').ClientContext} ctx */
export async function mount(root, ctx) {
  const labels = ctx.locale?.startsWith('zh')
    ? { save: '保存设置', saved: '已保存' }
    : { save: 'Save settings', saved: 'Saved' }
  const editor = document.createElement('textarea')
  editor.rows = 12; editor.style.width = '100%'
  editor.value = JSON.stringify(await ctx.rpc.call('get-settings'), null, 2)
  const save = document.createElement('button')
  save.textContent = labels.save
  save.onclick = async () => {
    try { await ctx.rpc.call('save-settings', JSON.parse(editor.value)); ctx.ui.notify(labels.saved, 'success') }
    catch (error) { ctx.ui.notify(error.message, 'error') }
  }
  root.append(editor, save)
}
