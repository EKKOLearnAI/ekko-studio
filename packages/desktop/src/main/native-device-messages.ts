import { app } from 'electron'

export const nativeDeviceLocales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'ar', 'tr'] as const
export type NativeDeviceLocale = typeof nativeDeviceLocales[number]

export function normalizeNativeDeviceLocale(value: unknown): NativeDeviceLocale | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const tag = value.trim().replaceAll('_', '-').toLowerCase()
  if (!tag) return null
  if (tag === 'zh' || tag.startsWith('zh-')) {
    return /(?:^|-)(hant|tw|hk|mo)(?:-|$)/.test(tag) ? 'zh-TW' : 'zh'
  }
  const primary = tag.split('-')[0]
  return (nativeDeviceLocales as readonly string[]).includes(primary) ? primary as NativeDeviceLocale : null
}

export function defaultNativeDeviceLocale(): NativeDeviceLocale {
  return normalizeNativeDeviceLocale(app.getLocale()) || 'en'
}

type Labels = { title: string; local: string; manage: string; name: string; address: string; add: string; remove: string; current: string; switch: string; confirm: string; hint: string; cancel: string; busy: string; failed: string; invalid: string; duplicate: string; unreachable: string; active: string; deleteConfirm: string; limit: string }
const messages: Record<NativeDeviceLocale, Labels> = {
  en: { title: 'Devices', local: 'localhost', manage: 'Manage devices…', name: 'Device name', address: 'Studio server address', add: 'Add device', remove: 'Delete', current: 'Current device', switch: 'Switch', confirm: 'Switch and restart', hint: 'Save your work first. Studio will check the connection and restart all desktop windows on the selected device.', cancel: 'Cancel', busy: 'Checking connection…', failed: 'Could not complete the operation. Please try again.', invalid: 'Enter a name (1–80 characters) and an HTTP or HTTPS server root address without credentials.', duplicate: 'This server address is already saved.', unreachable: 'Could not reach this Studio server. Your current connection is unchanged.', limit: "You can save up to 50 remote devices.", active: 'Switch to another device before deleting this connection.', deleteConfirm: 'Delete this saved connection? The device’s services and data will be retained.' },
  zh: { title: '设备', local: 'localhost', manage: '管理设备…', name: '设备名称', address: 'Studio 服务地址', add: '添加设备', remove: '删除', current: '当前设备', switch: '切换', confirm: '切换并重启', hint: '请先保存当前工作。Studio 会检查连接并重启所有桌面窗口，切换到所选设备。', cancel: '取消', busy: '正在检查连接…', failed: '操作失败，请重试。', invalid: '请输入 1–80 字的名称，以及不含账号密码的 HTTP 或 HTTPS 服务根地址。', duplicate: '该服务地址已添加。', unreachable: '无法连接此 Studio 服务，当前连接保持不变。', limit: "最多可保存 50 台远程设备。", active: '请先切换到其他设备，再删除当前连接。', deleteConfirm: '删除这条连接配置？设备上的服务和数据会保留。' },
  'zh-TW': { title: '裝置', local: 'localhost', manage: '管理裝置…', name: '裝置名稱', address: 'Studio 服務位址', add: '新增裝置', remove: '刪除', current: '目前裝置', switch: '切換', confirm: '切換並重新啟動', hint: '請先儲存工作。Studio 會檢查連線並重新啟動所有桌面視窗，切換至所選裝置。', cancel: '取消', busy: '正在檢查連線…', failed: '操作失敗，請再試一次。', invalid: '請輸入 1–80 字的名稱，以及不含帳號密碼的 HTTP 或 HTTPS 服務根位址。', duplicate: '此服務位址已新增。', unreachable: '無法連線至此 Studio 服務，目前連線維持不變。', limit: "最多可儲存 50 台遠端裝置。", active: '請先切換至其他裝置，再刪除目前連線。', deleteConfirm: '刪除此連線設定？裝置上的服務與資料會保留。' },
  ja: { title: 'デバイス', local: 'localhost', manage: 'デバイスを管理…', name: 'デバイス名', address: 'Studio サーバーアドレス', add: 'デバイスを追加', remove: '削除', current: '現在のデバイス', switch: '切り替え', confirm: '切り替えて再起動', hint: '作業を保存してください。接続を確認し、すべてのデスクトップウィンドウを再起動します。', cancel: 'キャンセル', busy: '接続を確認中…', failed: '操作できませんでした。再試行してください。', invalid: '1～80 文字の名前と、認証情報を含まない HTTP/HTTPS のルートアドレスを入力してください。', duplicate: 'このアドレスは登録済みです。', unreachable: 'サーバーに接続できません。現在の接続は維持されます。', limit: "最大 50 台のリモートデバイスを保存できます。", active: '別のデバイスに切り替えてから削除してください。', deleteConfirm: '接続設定を削除しますか？デバイスのサービスとデータは保持されます。' },
  ko: { title: '기기', local: 'localhost', manage: '기기 관리…', name: '기기 이름', address: 'Studio 서버 주소', add: '기기 추가', remove: '삭제', current: '현재 기기', switch: '전환', confirm: '전환 및 재시작', hint: '작업을 저장하세요. 연결을 확인하고 모든 데스크톱 창을 재시작합니다.', cancel: '취소', busy: '연결 확인 중…', failed: '작업에 실패했습니다. 다시 시도하세요.', invalid: '1–80자의 이름과 인증 정보가 없는 HTTP/HTTPS 서버 루트 주소를 입력하세요.', duplicate: '이미 저장된 주소입니다.', unreachable: '서버에 연결할 수 없습니다. 현재 연결은 유지됩니다.', limit: "원격 기기는 최대 50개까지 저장할 수 있습니다.", active: '다른 기기로 전환한 후 삭제하세요.', deleteConfirm: '연결 설정을 삭제할까요? 기기의 서비스와 데이터는 유지됩니다.' },
  fr: { title: 'Appareils', local: 'localhost', manage: 'Gérer les appareils…', name: 'Nom de l’appareil', address: 'Adresse du serveur Studio', add: 'Ajouter', remove: 'Supprimer', current: 'Appareil actuel', switch: 'Changer', confirm: 'Changer et redémarrer', hint: 'Enregistrez votre travail. Studio vérifiera la connexion et redémarrera toutes les fenêtres.', cancel: 'Annuler', busy: 'Vérification de la connexion…', failed: 'Échec de l’opération. Réessayez.', invalid: 'Saisissez un nom de 1 à 80 caractères et une adresse racine HTTP/HTTPS sans identifiants.', duplicate: 'Cette adresse est déjà enregistrée.', unreachable: 'Serveur inaccessible. La connexion actuelle est conservée.', limit: "Vous pouvez enregistrer jusqu’à 50 appareils distants.", active: 'Changez d’appareil avant de supprimer cette connexion.', deleteConfirm: 'Supprimer cette connexion ? Les services et données de l’appareil seront conservés.' },
  es: { title: 'Dispositivos', local: 'localhost', manage: 'Gestionar dispositivos…', name: 'Nombre del dispositivo', address: 'Dirección del servidor Studio', add: 'Añadir', remove: 'Eliminar', current: 'Dispositivo actual', switch: 'Cambiar', confirm: 'Cambiar y reiniciar', hint: 'Guarda tu trabajo. Studio comprobará la conexión y reiniciará todas las ventanas.', cancel: 'Cancelar', busy: 'Comprobando conexión…', failed: 'No se pudo completar la operación. Inténtalo de nuevo.', invalid: 'Introduce un nombre de 1–80 caracteres y una dirección raíz HTTP/HTTPS sin credenciales.', duplicate: 'Esta dirección ya está guardada.', unreachable: 'Servidor inaccesible. Se mantiene la conexión actual.', limit: "Puedes guardar hasta 50 dispositivos remotos.", active: 'Cambia de dispositivo antes de eliminar esta conexión.', deleteConfirm: '¿Eliminar esta conexión? Se conservarán los servicios y datos del dispositivo.' },
  de: { title: 'Geräte', local: 'localhost', manage: 'Geräte verwalten…', name: 'Gerätename', address: 'Studio-Serveradresse', add: 'Hinzufügen', remove: 'Löschen', current: 'Aktuelles Gerät', switch: 'Wechseln', confirm: 'Wechseln und neu starten', hint: 'Speichern Sie Ihre Arbeit. Studio prüft die Verbindung und startet alle Fenster neu.', cancel: 'Abbrechen', busy: 'Verbindung wird geprüft…', failed: 'Vorgang fehlgeschlagen. Bitte erneut versuchen.', invalid: 'Geben Sie einen Namen mit 1–80 Zeichen und eine HTTP/HTTPS-Stammadresse ohne Zugangsdaten ein.', duplicate: 'Diese Adresse ist bereits gespeichert.', unreachable: 'Server nicht erreichbar. Die aktuelle Verbindung bleibt bestehen.', limit: "Es können bis zu 50 entfernte Geräte gespeichert werden.", active: 'Wechseln Sie vor dem Löschen zu einem anderen Gerät.', deleteConfirm: 'Diese Verbindung löschen? Dienste und Daten des Geräts bleiben erhalten.' },
  pt: { title: 'Dispositivos', local: 'localhost', manage: 'Gerir dispositivos…', name: 'Nome do dispositivo', address: 'Endereço do servidor Studio', add: 'Adicionar', remove: 'Eliminar', current: 'Dispositivo atual', switch: 'Mudar', confirm: 'Mudar e reiniciar', hint: 'Guarde o trabalho. O Studio verificará a ligação e reiniciará todas as janelas.', cancel: 'Cancelar', busy: 'A verificar a ligação…', failed: 'Não foi possível concluir a operação. Tente novamente.', invalid: 'Introduza um nome com 1–80 caracteres e um endereço raiz HTTP/HTTPS sem credenciais.', duplicate: 'Este endereço já está guardado.', unreachable: 'Servidor inacessível. A ligação atual é mantida.', limit: "Você pode salvar até 50 dispositivos remotos.", active: 'Mude de dispositivo antes de eliminar esta ligação.', deleteConfirm: 'Eliminar esta ligação? Os serviços e dados do dispositivo serão mantidos.' },
  ru: { title: 'Устройства', local: 'localhost', manage: 'Управление устройствами…', name: 'Название устройства', address: 'Адрес сервера Studio', add: 'Добавить устройство', remove: 'Удалить', current: 'Текущее устройство', switch: 'Переключить', confirm: 'Переключить и перезапустить', hint: 'Сохраните работу. Studio проверит соединение и перезапустит все окна на выбранном устройстве.', cancel: 'Отмена', busy: 'Проверка соединения…', failed: 'Не удалось выполнить операцию. Повторите попытку.', invalid: 'Введите название длиной 1–80 символов и корневой HTTP- или HTTPS-адрес сервера без учётных данных.', duplicate: 'Этот адрес уже сохранён.', unreachable: 'Сервер Studio недоступен. Текущее подключение сохранено.', active: 'Перед удалением этого подключения переключитесь на другое устройство.', deleteConfirm: 'Удалить это подключение? Службы и данные устройства будут сохранены.', limit: 'Можно сохранить до 50 удалённых устройств.' },
  ar: { title: 'الأجهزة', local: 'localhost', manage: 'إدارة الأجهزة…', name: 'اسم الجهاز', address: 'عنوان خادم Studio', add: 'إضافة جهاز', remove: 'حذف', current: 'الجهاز الحالي', switch: 'تبديل', confirm: 'التبديل وإعادة التشغيل', hint: 'احفظ عملك أولاً. سيتحقق Studio من الاتصال ويعيد تشغيل جميع النوافذ على الجهاز المحدد.', cancel: 'إلغاء', busy: 'جارٍ التحقق من الاتصال…', failed: 'تعذر إكمال العملية. حاول مرة أخرى.', invalid: 'أدخل اسماً من حرف إلى 80 حرفاً وعنوان HTTP أو HTTPS في جذر الخادم دون بيانات تسجيل الدخول.', duplicate: 'عنوان الخادم محفوظ بالفعل.', unreachable: 'تعذر الوصول إلى خادم Studio. سيبقى اتصالك الحالي.', active: 'بدّل إلى جهاز آخر قبل حذف هذا الاتصال.', deleteConfirm: 'هل تريد حذف هذا الاتصال؟ ستبقى خدمات الجهاز وبياناته.', limit: 'يمكنك حفظ ما يصل إلى 50 جهازاً بعيداً.' },
  tr: { title: 'Cihazlar', local: 'localhost', manage: 'Cihazları yönet…', name: 'Cihaz adı', address: 'Studio sunucu adresi', add: 'Cihaz ekle', remove: 'Sil', current: 'Geçerli cihaz', switch: 'Geçiş yap', confirm: 'Geç ve yeniden başlat', hint: 'Önce çalışmanızı kaydedin. Studio bağlantıyı denetleyecek ve tüm pencereleri seçilen cihazda yeniden başlatacak.', cancel: 'İptal', busy: 'Bağlantı denetleniyor…', failed: 'İşlem tamamlanamadı. Tekrar deneyin.', invalid: '1–80 karakterlik bir ad ve kimlik bilgileri içermeyen bir HTTP veya HTTPS sunucu kök adresi girin.', duplicate: 'Bu sunucu adresi zaten kayıtlı.', unreachable: 'Studio sunucusuna ulaşılamadı. Geçerli bağlantınız korunur.', active: 'Bu bağlantıyı silmeden önce başka bir cihaza geçin.', deleteConfirm: 'Bu bağlantı silinsin mi? Cihazın hizmetleri ve verileri korunacaktır.', limit: 'En fazla 50 uzak cihaz kaydedebilirsiniz.' },
}
const extraEnglish = {
  manageTitle: 'Device management', description: 'Switch between this computer and your remote Studio servers.',
  savedDevices: 'Saved devices', remote: 'Remote', localHint: 'Studio running on this computer',
  addHint: 'Enter the Studio server address on your remote device.', saved: 'Device added',
  switchTitle: 'Switch device', deleteTitle: 'Delete connection', target: 'Selected device',
  checkConnection: 'Check connection', restartStudio: 'Restart Studio', restarting: 'Restarting Studio…',
  restartHint: 'Your connection is saved. Studio will reopen on the selected device.',
  checkingHint: 'Verifying the Studio service on this device. Please wait.',
  preparing: 'Preparing to switch…', retry: 'Try again', close: 'Close',
  elapsed: 'Waiting {seconds}s', storedLocally: 'Connections are saved on this computer.',
}
const extraMessages: Record<NativeDeviceLocale, Record<keyof typeof extraEnglish, string>> = {
  en: extraEnglish,
  zh: {
    manageTitle: '设备管理', description: '在本机和远程 Studio 之间切换。', savedDevices: '已保存的设备', remote: '远程',
    localHint: '使用此电脑上的 Studio 服务', addHint: '填写远程设备上 Studio 的服务地址。', saved: '设备已添加',
    switchTitle: '切换设备', deleteTitle: '删除连接', target: '目标设备', checkConnection: '检查连接', restartStudio: '重启 Studio',
    restarting: '正在重启 Studio…', restartHint: '连接已保存，Studio 即将在所选设备上重新打开。',
    checkingHint: '正在验证此设备上的 Studio 服务，请稍候。', preparing: '正在准备切换…', retry: '重试', close: '关闭',
    elapsed: '已等待 {seconds} 秒', storedLocally: '连接配置仅保存在此电脑上。',
  },
  'zh-TW': {
    manageTitle: '裝置管理', description: '在本機與遠端 Studio 之間切換。', savedDevices: '已儲存的裝置', remote: '遠端',
    localHint: '使用此電腦上的 Studio 服務', addHint: '填寫遠端裝置上 Studio 的服務位址。', saved: '裝置已新增',
    switchTitle: '切換裝置', deleteTitle: '刪除連線', target: '目標裝置', checkConnection: '檢查連線', restartStudio: '重新啟動 Studio',
    restarting: '正在重新啟動 Studio…', restartHint: '連線已儲存，Studio 即將在所選裝置上重新開啟。',
    checkingHint: '正在驗證此裝置上的 Studio 服務，請稍候。', preparing: '正在準備切換…', retry: '重試', close: '關閉',
    elapsed: '已等待 {seconds} 秒', storedLocally: '連線設定僅儲存在此電腦上。',
  },
  ja: {
    manageTitle: 'デバイス管理', description: 'このコンピューターとリモート Studio を切り替えます。', savedDevices: '保存済みデバイス', remote: 'リモート',
    localHint: 'このコンピューターで実行中の Studio', addHint: 'リモートデバイスの Studio サーバーアドレスを入力してください。', saved: 'デバイスを追加しました',
    switchTitle: 'デバイスを切り替え', deleteTitle: '接続を削除', target: '選択したデバイス', checkConnection: '接続を確認', restartStudio: 'Studio を再起動',
    restarting: 'Studio を再起動中…', restartHint: '接続を保存しました。選択したデバイスで Studio が再び開きます。',
    checkingHint: 'このデバイスの Studio サービスを確認しています。しばらくお待ちください。', preparing: '切り替えを準備中…', retry: '再試行', close: '閉じる',
    elapsed: '{seconds} 秒経過', storedLocally: '接続設定はこのコンピューターに保存されます。',
  },
  ko: {
    manageTitle: '기기 관리', description: '이 컴퓨터와 원격 Studio 사이를 전환하세요.', savedDevices: '저장된 기기', remote: '원격',
    localHint: '이 컴퓨터에서 실행 중인 Studio', addHint: '원격 기기의 Studio 서버 주소를 입력하세요.', saved: '기기가 추가되었습니다',
    switchTitle: '기기 전환', deleteTitle: '연결 삭제', target: '선택한 기기', checkConnection: '연결 확인', restartStudio: 'Studio 재시작',
    restarting: 'Studio 재시작 중…', restartHint: '연결이 저장되었습니다. 선택한 기기에서 Studio가 다시 열립니다.',
    checkingHint: '이 기기의 Studio 서비스를 확인하고 있습니다. 잠시 기다려 주세요.', preparing: '전환 준비 중…', retry: '다시 시도', close: '닫기',
    elapsed: '{seconds}초 경과', storedLocally: '연결 설정은 이 컴퓨터에 저장됩니다.',
  },
  fr: {
    manageTitle: 'Gestion des appareils', description: 'Basculez entre cet ordinateur et vos serveurs Studio distants.', savedDevices: 'Appareils enregistrés', remote: 'Distant',
    localHint: 'Studio sur cet ordinateur', addHint: 'Saisissez l’adresse du serveur Studio de votre appareil distant.', saved: 'Appareil ajouté',
    switchTitle: 'Changer d’appareil', deleteTitle: 'Supprimer la connexion', target: 'Appareil sélectionné', checkConnection: 'Vérifier la connexion', restartStudio: 'Redémarrer Studio',
    restarting: 'Redémarrage de Studio…', restartHint: 'Connexion enregistrée. Studio va se rouvrir sur l’appareil sélectionné.',
    checkingHint: 'Vérification du service Studio de cet appareil. Veuillez patienter.', preparing: 'Préparation du changement…', retry: 'Réessayer', close: 'Fermer',
    elapsed: 'Attente : {seconds} s', storedLocally: 'Les connexions sont enregistrées sur cet ordinateur.',
  },
  es: {
    manageTitle: 'Gestión de dispositivos', description: 'Cambia entre este ordenador y tus servidores Studio remotos.', savedDevices: 'Dispositivos guardados', remote: 'Remoto',
    localHint: 'Studio en este ordenador', addHint: 'Introduce la dirección del servidor Studio de tu dispositivo remoto.', saved: 'Dispositivo añadido',
    switchTitle: 'Cambiar de dispositivo', deleteTitle: 'Eliminar conexión', target: 'Dispositivo seleccionado', checkConnection: 'Comprobar conexión', restartStudio: 'Reiniciar Studio',
    restarting: 'Reiniciando Studio…', restartHint: 'Conexión guardada. Studio se abrirá en el dispositivo seleccionado.',
    checkingHint: 'Comprobando el servicio Studio de este dispositivo. Espera un momento.', preparing: 'Preparando el cambio…', retry: 'Reintentar', close: 'Cerrar',
    elapsed: 'Esperando {seconds} s', storedLocally: 'Las conexiones se guardan en este ordenador.',
  },
  de: {
    manageTitle: 'Geräteverwaltung', description: 'Zwischen diesem Computer und entfernten Studio-Servern wechseln.', savedDevices: 'Gespeicherte Geräte', remote: 'Remote',
    localHint: 'Studio auf diesem Computer', addHint: 'Geben Sie die Studio-Serveradresse des entfernten Geräts ein.', saved: 'Gerät hinzugefügt',
    switchTitle: 'Gerät wechseln', deleteTitle: 'Verbindung löschen', target: 'Ausgewähltes Gerät', checkConnection: 'Verbindung prüfen', restartStudio: 'Studio neu starten',
    restarting: 'Studio wird neu gestartet…', restartHint: 'Verbindung gespeichert. Studio öffnet sich auf dem ausgewählten Gerät.',
    checkingHint: 'Der Studio-Dienst wird geprüft. Bitte warten.', preparing: 'Wechsel wird vorbereitet…', retry: 'Erneut versuchen', close: 'Schließen',
    elapsed: '{seconds} s vergangen', storedLocally: 'Verbindungen werden auf diesem Computer gespeichert.',
  },
  pt: {
    manageTitle: 'Gestão de dispositivos', description: 'Alterne entre este computador e os seus servidores Studio remotos.', savedDevices: 'Dispositivos guardados', remote: 'Remoto',
    localHint: 'Studio neste computador', addHint: 'Introduza o endereço do servidor Studio do dispositivo remoto.', saved: 'Dispositivo adicionado',
    switchTitle: 'Mudar de dispositivo', deleteTitle: 'Eliminar ligação', target: 'Dispositivo selecionado', checkConnection: 'Verificar ligação', restartStudio: 'Reiniciar Studio',
    restarting: 'A reiniciar o Studio…', restartHint: 'Ligação guardada. O Studio será reaberto no dispositivo selecionado.',
    checkingHint: 'A verificar o serviço Studio deste dispositivo. Aguarde.', preparing: 'A preparar a mudança…', retry: 'Tentar novamente', close: 'Fechar',
    elapsed: 'A aguardar {seconds} s', storedLocally: 'As ligações são guardadas neste computador.',
  },
  ru: {
    manageTitle: 'Управление устройствами', description: 'Переключайтесь между этим компьютером и удалёнными серверами Studio.', savedDevices: 'Сохранённые устройства', remote: 'Удалённое',
    localHint: 'Studio на этом компьютере', addHint: 'Введите адрес сервера Studio на удалённом устройстве.', saved: 'Устройство добавлено',
    switchTitle: 'Переключить устройство', deleteTitle: 'Удалить подключение', target: 'Выбранное устройство', checkConnection: 'Проверить соединение', restartStudio: 'Перезапустить Studio',
    restarting: 'Перезапуск Studio…', restartHint: 'Подключение сохранено. Studio откроется на выбранном устройстве.',
    checkingHint: 'Проверяем службу Studio на этом устройстве. Подождите.', preparing: 'Подготовка к переключению…', retry: 'Повторить', close: 'Закрыть',
    elapsed: 'Ожидание: {seconds} с', storedLocally: 'Подключения хранятся на этом компьютере.',
  },
  ar: {
    manageTitle: 'إدارة الأجهزة', description: 'بدّل بين هذا الكمبيوتر وخوادم Studio البعيدة.', savedDevices: 'الأجهزة المحفوظة', remote: 'بعيد',
    localHint: 'Studio يعمل على هذا الكمبيوتر', addHint: 'أدخل عنوان خادم Studio على جهازك البعيد.', saved: 'تمت إضافة الجهاز',
    switchTitle: 'تبديل الجهاز', deleteTitle: 'حذف الاتصال', target: 'الجهاز المحدد', checkConnection: 'التحقق من الاتصال', restartStudio: 'إعادة تشغيل Studio',
    restarting: 'جارٍ إعادة تشغيل Studio…', restartHint: 'تم حفظ الاتصال. سيفتح Studio على الجهاز المحدد.',
    checkingHint: 'جارٍ التحقق من خدمة Studio على هذا الجهاز. يرجى الانتظار.', preparing: 'جارٍ التحضير للتبديل…', retry: 'إعادة المحاولة', close: 'إغلاق',
    elapsed: 'انتظار {seconds} ث', storedLocally: 'تُحفظ الاتصالات على هذا الكمبيوتر.',
  },
  tr: {
    manageTitle: 'Cihaz yönetimi', description: 'Bu bilgisayar ile uzak Studio sunucularınız arasında geçiş yapın.', savedDevices: 'Kayıtlı cihazlar', remote: 'Uzak',
    localHint: 'Bu bilgisayarda çalışan Studio', addHint: 'Uzak cihazınızdaki Studio sunucusunun adresini girin.', saved: 'Cihaz eklendi',
    switchTitle: 'Cihaz değiştir', deleteTitle: 'Bağlantıyı sil', target: 'Seçilen cihaz', checkConnection: 'Bağlantıyı denetle', restartStudio: 'Studio’yu yeniden başlat',
    restarting: 'Studio yeniden başlatılıyor…', restartHint: 'Bağlantınız kaydedildi. Studio seçilen cihazda yeniden açılacak.',
    checkingHint: 'Bu cihazdaki Studio hizmeti doğrulanıyor. Lütfen bekleyin.', preparing: 'Geçiş hazırlanıyor…', retry: 'Tekrar dene', close: 'Kapat',
    elapsed: '{seconds} sn bekleniyor', storedLocally: 'Bağlantılar bu bilgisayarda saklanır.',
  },
}
export type NativeDeviceLabels = Labels & typeof extraEnglish
export function nativeDeviceLabels(locale: NativeDeviceLocale = defaultNativeDeviceLocale()): NativeDeviceLabels {
  return { ...messages[locale], ...extraMessages[locale] }
}
