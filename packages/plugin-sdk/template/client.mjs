/** Starter metadata and UI strings cover the same languages as Studio. */
export const templateMessages = {
  en: { description: 'Configure {id} in Studio.', settings: 'Settings', save: 'Save settings', saved: 'Saved' },
  zh: { description: '在 Studio 中配置 {id}。', settings: '设置', save: '保存设置', saved: '已保存' },
  'zh-TW': { description: '在 Studio 中設定 {id}。', settings: '設定', save: '儲存設定', saved: '已儲存' },
  ja: { description: 'Studio で {id} を設定します。', settings: '設定', save: '設定を保存', saved: '保存しました' },
  ko: { description: '{id} 설정을 Studio에서 관리합니다.', settings: '설정', save: '설정 저장', saved: '저장됨' },
  fr: { description: 'Configurez {id} dans Studio.', settings: 'Paramètres', save: 'Enregistrer les paramètres', saved: 'Enregistré' },
  es: { description: 'Configura {id} en Studio.', settings: 'Configuración', save: 'Guardar configuración', saved: 'Guardado' },
  de: { description: '{id} in Studio konfigurieren.', settings: 'Einstellungen', save: 'Einstellungen speichern', saved: 'Gespeichert' },
  pt: { description: 'Configure {id} no Studio.', settings: 'Configurações', save: 'Salvar configurações', saved: 'Salvo' },
  ru: { description: 'Настройте {id} в Studio.', settings: 'Настройки', save: 'Сохранить настройки', saved: 'Сохранено' },
  ar: { description: 'اضبط إعدادات {id} في Studio.', settings: 'الإعدادات', save: 'حفظ الإعدادات', saved: 'تم الحفظ' },
  tr: { description: 'Studio’da {id} eklentisini yapılandırın.', settings: 'Ayarlar', save: 'Ayarları kaydet', saved: 'Kaydedildi' },
}
/** @param {HTMLElement} root @param {import('@ekko-studio/plugin-sdk').ClientContext} ctx */
export async function mount(root, ctx) {
  const requested = String(ctx.locale || 'en').replaceAll('_', '-').toLowerCase()
  const locale = Object.keys(templateMessages).find(key => key.toLowerCase() === requested)
    || (Object.hasOwn(templateMessages, requested.split('-')[0]) ? requested.split('-')[0] : 'en')
  const labels = templateMessages[locale] || templateMessages.en
  root.lang = locale
  root.dir = locale === 'ar' ? 'rtl' : 'ltr'
  const editor = document.createElement('textarea')
  editor.rows = 12; editor.style.width = '100%'; editor.dir = 'ltr'
  editor.setAttribute('aria-label', labels.settings)
  editor.value = JSON.stringify(await ctx.rpc.call('get-settings'), null, 2)
  const save = document.createElement('button')
  save.textContent = labels.save
  save.onclick = async () => {
    try { await ctx.rpc.call('save-settings', JSON.parse(editor.value)); ctx.ui.notify(labels.saved, 'success') }
    catch (error) { ctx.ui.notify(error.message, 'error') }
  }
  root.append(editor, save)
}
