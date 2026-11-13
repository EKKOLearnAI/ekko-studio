import { randomBytes } from 'node:crypto'

const paths = {
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  trash: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
}
const icons = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, `<svg class="icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`]))

// All three documents are shipped with Desktop. Remote HTML, fonts, wallpaper
// resources and scripts never enter these isolated views.
export function nativeDeviceHtml(kind: 'button' | 'manager' | 'action'): string {
  const nonce = randomBytes(18).toString('base64')
  const body = kind === 'button' ? `
    <button id="device-button" aria-haspopup="menu" aria-expanded="false" aria-controls="device-menu">
      <span id="toolbar-icon">${icons.monitor}</span><span id="device-label">Ekko Studio</span><span id="device-arrow">${icons.chevron}</span>
    </button><nav id="device-menu" role="menu" hidden></nav>` : kind === 'manager' ? `
    <main class="manager-shell">
      <header class="manager-header"><span class="hero-icon">${icons.monitor}</span><div><p class="eyebrow">STUDIO</p><h1 id="title"></h1><p id="description" class="muted"></p></div></header>
      <div class="manager-content">
        <section class="list-heading"><h2 id="list-title"></h2><button id="toggle-add" class="primary">${icons.plus}<span id="toggle-add-label"></span></button></section>
        <form id="add-form" class="surface-card" novalidate hidden>
          <div class="form-heading"><h2 id="add-title"></h2><button id="hide-add" type="button" class="icon-button">${icons.close}</button></div>
          <p id="add-hint" class="muted"></p>
          <label><span id="name-label"></span><input id="name" dir="auto" autocomplete="off" maxlength="80" required></label>
          <label><span id="address-label"></span><input id="address" dir="ltr" type="url" autocomplete="off" placeholder="https://studio.example.com" maxlength="2048" required></label>
          <div class="form-footer"><button id="add" type="submit" class="primary"></button></div>
        </form>
        <div id="message" role="status" aria-live="polite" hidden></div>
        <div id="devices"></div>
      </div>
      <footer class="manager-footer">${icons.shield}<span id="storage-note"></span></footer>
    </main>` : `
    <main class="action-shell" id="action-shell">
      <header class="action-header"><span id="action-icon" class="hero-icon">${icons.arrow}</span><p class="eyebrow">STUDIO</p><h1 id="action-title"></h1></header>
      <section class="target-device surface-card"><span id="target-icon" class="device-icon"></span><div class="info"><p id="target-caption" class="eyebrow"></p><strong id="target-name"></strong><p id="target-address" class="address"></p></div></section>
      <p id="action-hint" class="muted action-hint"></p>
      <section id="progress" hidden aria-label="Studio" role="status" aria-live="polite">
        <div class="progress-status"><span class="spinner" aria-hidden="true"></span><strong id="progress-title" tabindex="-1"></strong><span id="elapsed" class="muted" aria-live="off"></span></div>
        <ol class="progress-steps"><li id="step-check"><span class="step-mark"></span><span id="check-label"></span></li><li id="step-restart"><span class="step-mark"></span><span id="restart-label"></span></li></ol>
      </section>
      <div id="action-error" class="notice error" role="alert" hidden></div>
      <footer class="action-footer"><button id="action-cancel"></button><button id="action-new"></button><button id="action-confirm" class="primary"></button></footer>
    </main>`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<style>
:root {
  color-scheme:dark;
  --device-text:#e0e0e0; --device-secondary:#a0a0a0; --device-accent:#e0e0e0; --device-onAccent:#1a1a1a; --device-error:#ef5350;
  --device-background:#1a1a1a; --device-overlay:#2a2a2a; --device-card:#2a2a2a; --device-input:#2a2a2a;
  --device-border:#3a3a3a; --device-overlayBorder:#3a3a3a; --device-cardBorder:#3a3a3a; --device-inputBorder:#3a3a3a;
  --device-radius:6px; --device-overlayRadius:10px; --device-cardRadius:10px; --device-inputRadius:6px; --device-borderWidth:1px;
  --device-font:Inter,system-ui,sans-serif; --device-fontSize:14px;
  font:var(--device-fontSize) var(--device-font); color:var(--device-text);
}
* { box-sizing:border-box; -webkit-app-region:no-drag; }
[hidden] { display:none; }
html,body { margin:0; min-height:100%; -webkit-app-region:no-drag; }
body { background:${kind === 'button' ? 'transparent' : 'var(--device-background)'}; }
button,input { font:inherit; color:inherit; }
button { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:34px; cursor:pointer; border:var(--device-borderWidth) solid var(--device-border); border-radius:var(--device-radius); background:transparent; padding:6px 12px; font-size:13px; white-space:nowrap; }
button:hover { background:color-mix(in srgb,var(--device-text) 7%,transparent); }
button:focus-visible,input:focus-visible { outline:2px solid var(--device-accent); outline-offset:2px; }
button:disabled { opacity:.5; cursor:default; }
button.primary { background:var(--device-accent); color:var(--device-onAccent); border-color:var(--device-accent); font-weight:600; }
button.primary:hover { background:color-mix(in srgb,var(--device-accent) 86%,var(--device-text)); }
button.danger { color:var(--device-error); border-color:color-mix(in srgb,var(--device-error) 30%,transparent); background:color-mix(in srgb,var(--device-error) 8%,transparent); }
svg { width:18px; height:18px; flex-shrink:0; display:block; }
p,h1,h2 { margin:0; }
h1 { font-size:22px; font-weight:650; line-height:1.35; letter-spacing:-.4px; }
h2 { font-size:13px; font-weight:600; }
.muted,.address { color:var(--device-secondary); font-size:12px; line-height:1.65; }
.eyebrow { font-size:10px; letter-spacing:1.3px; color:var(--device-secondary); line-height:1.5; }
.info { flex:1; min-width:0; }
.surface-card { background:var(--device-card); backdrop-filter:var(--device-cardFilter,none); border:var(--device-borderWidth) solid var(--device-cardBorder); border-radius:var(--device-cardRadius); box-shadow:var(--device-cardShadow,none); }
.hero-icon,.device-icon { display:grid; place-items:center; flex-shrink:0; color:var(--device-accent); border-radius:var(--device-radius); background:color-mix(in srgb,var(--device-accent) 8%,transparent); }
.hero-icon { width:44px; height:44px; }
.hero-icon svg { width:23px; height:23px; }
.device-icon { width:38px; height:38px; }
.icon-button { padding:7px; min-width:32px; min-height:32px; border-color:transparent; }
.icon-button svg { width:16px; height:16px; }
#device-button { position:absolute; right:0; top:6px; width:120px; min-height:28px; height:28px; gap:6px; padding:0 6px; border-color:transparent; font-size:12px; }
#device-button:hover,#device-button[aria-expanded=true] { border-color:var(--device-border); }
#device-button svg { width:14px; height:14px; }
#device-button:focus-visible { outline-offset:-2px; }
#device-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:start; }
#device-arrow svg { width:12px; height:12px; }
#device-menu { position:absolute; top:40px; right:0; width:224px; max-height:calc(100vh - 44px); overflow:auto; padding:5px; background:var(--device-overlay); backdrop-filter:var(--device-overlayFilter,none); border:var(--device-borderWidth) solid var(--device-overlayBorder); border-radius:var(--device-overlayRadius); box-shadow:var(--device-overlayShadow,none); }
.menu-item { justify-content:flex-start; width:100%; text-align:start; border:0; padding:8px; gap:8px; font-size:12px; border-radius:var(--device-radius); }
.menu-item svg { width:15px; height:15px; color:var(--device-secondary); }
.menu-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.menu-check { width:14px; }
.menu-check svg { color:var(--device-accent); }
#device-menu hr { border:0; border-top:var(--device-borderWidth) solid var(--device-overlayBorder); margin:4px 0; }
.manager-shell { display:flex; flex-direction:column; min-height:100vh; max-width:800px; margin:auto; }
.manager-header { display:flex; align-items:center; gap:14px; padding:28px 28px 24px; }
.manager-header h1 { margin:2px 0 6px; }
.manager-content { padding:0 28px 24px; flex:1; }
.list-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; }
.list-heading h2 { color:var(--device-secondary); }
.device { display:flex; align-items:center; gap:12px; padding:15px; margin-bottom:10px; }
.device[data-current=true] { border-color:color-mix(in srgb,var(--device-accent) 40%,transparent); }
.name { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.address { margin-top:3px; overflow-wrap:anywhere; }
.actions { display:flex; align-items:center; gap:6px; flex-shrink:0; }
.current { display:inline-flex; align-items:center; gap:4px; padding:4px 7px; border-radius:var(--device-radius); font-size:11px; color:var(--device-accent); background:color-mix(in srgb,var(--device-accent) 9%,transparent); white-space:nowrap; }
.current svg { width:12px; height:12px; }
.manager-footer { border-top:var(--device-borderWidth) solid var(--device-border); padding:15px 28px; display:flex; align-items:center; gap:7px; color:var(--device-secondary); font-size:11px; }
.manager-footer svg { width:14px; height:14px; }
form { padding:18px; margin-bottom:16px; }
.form-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
#add-hint { margin:2px 0 14px; }
label { display:grid; gap:7px; font-size:12px; margin:12px 0; }
input { width:100%; background:var(--device-input); backdrop-filter:var(--device-inputFilter,none); border:var(--device-borderWidth) solid var(--device-inputBorder); border-radius:var(--device-inputRadius); padding:10px 12px; font-size:13px; }
input::placeholder { color:var(--device-secondary); }
.form-footer { display:flex; justify-content:flex-end; margin-top:16px; }
.notice,#message { padding:10px 12px; margin-bottom:14px; font-size:12px; line-height:1.65; border-radius:var(--device-radius); background:color-mix(in srgb,var(--device-accent) 7%,transparent); }
.error { color:var(--device-error); background:color-mix(in srgb,var(--device-error) 7%,transparent); }
.action-shell { min-height:100vh; padding:28px; display:flex; flex-direction:column; background:var(--device-overlay); backdrop-filter:var(--device-overlayFilter,none); }
.action-header .hero-icon { margin-bottom:16px; }
.action-header h1 { margin-top:3px; }
.target-device { display:flex; gap:12px; align-items:center; padding:13px; margin:20px 0 14px; }
.target-device .eyebrow { font-size:10px; letter-spacing:.3px; margin-bottom:3px; }
#target-name { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
#target-address { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.action-hint { margin-bottom:18px; }
.action-footer { margin-top:auto; padding-top:20px; display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
.action-footer button { min-width:80px; }
.progress-status { display:flex; align-items:center; gap:8px; font-size:13px; }
#elapsed { margin-inline-start:auto; font-size:11px; font-variant-numeric:tabular-nums; }
.spinner { display:inline-block; width:16px; height:16px; flex-shrink:0; border:2px solid color-mix(in srgb,var(--device-accent) 20%,transparent); border-top-color:var(--device-accent); border-radius:50%; animation:device-spin .75s linear infinite; }
.progress-steps { display:flex; padding:0; margin:18px 0 0; list-style:none; font-size:11px; color:var(--device-secondary); gap:16px; }
.progress-steps li { display:flex; align-items:center; gap:6px; flex:1; }
.step-mark { display:grid; place-items:center; width:18px; height:18px; border:1px solid var(--device-border); border-radius:50%; font-size:10px; }
.progress-steps .active { color:var(--device-text); }
.progress-steps .active .step-mark,.progress-steps .done .step-mark { color:var(--device-accent); border-color:var(--device-accent); background:color-mix(in srgb,var(--device-accent) 10%,transparent); }
.step-mark svg { width:12px; height:12px; }
#action-error { margin:0; }
:dir(rtl) .icon-arrow { transform:scaleX(-1); }
@keyframes device-spin { to { transform:rotate(360deg); } }
@media(prefers-reduced-motion:reduce) { .spinner { animation:none; } }
@media(max-width:520px) { .manager-header { padding:22px 20px; }.manager-content { padding:0 20px 20px; }.manager-footer { padding:14px 20px; }.device { flex-wrap:wrap; }.actions { margin-inline-start:auto; }.action-shell { padding:24px; } }
</style></head><body class="${kind}">${body}
<script nonce="${nonce}">
const api = window.studioDevices;
const icons = ${JSON.stringify(icons)};
const $ = id => document.getElementById(id);
let labels, latest, working = false, listSignature = '', notice = null;
const number = value => new Intl.NumberFormat(latest.locale).format(value);
function icon(name) { const template = document.createElement('template');template.innerHTML = icons[name];return template.content.firstChild; }
function text(id, value) { if ($(id)) $(id).textContent = value; }
function errorText(error) {
 const value = String(error && error.message || error);
 if (value.includes('LIMIT')) return labels.limit;
 if (/INVALID_|UNSUPPORTED_PATH/.test(value)) return labels.invalid;
 if (value.includes('DUPLICATE')) return labels.duplicate;
 if (value.includes('UNREACHABLE')) return labels.unreachable;
 if (value.includes('ACTIVE')) return labels.active;
 return labels.failed;
}
function paintStatus() {
 const el = $('message') || $('action-error');if (!el || !notice) return;
 el.hidden = false;el.textContent = notice.error ? errorText(notice.value) : labels[notice.value];el.className = 'notice' + (notice.error ? ' error' : '');
}
function status(value, error = false) {
 notice = value ? {value,error} : null;
 const el = $('message') || $('action-error');if (!el) return;
 if (!notice) { el.hidden = true;el.textContent = ''; } else paintStatus();
}
function makeButton(label, action, iconName) {
 const el = document.createElement('button');el.type = 'button';el.disabled = working || latest.busy;
 if (iconName) el.append(icon(iconName));
 if (label) { const span = document.createElement('span');span.textContent = label;el.append(span); }
 el.addEventListener('click', () => perform(action));return el;
}
function applyAppearance(appearance) {
 if (!appearance) return;
 document.documentElement.style.colorScheme = appearance.scheme === 'light' ? 'light' : 'dark';
 const properties = {text:'color',secondary:'color',accent:'color',onAccent:'color',error:'color',background:'background-color',overlay:'background-color',card:'background-color',input:'background-color',border:'color',overlayBorder:'color',cardBorder:'color',inputBorder:'color',radius:'border-radius',overlayRadius:'border-radius',cardRadius:'border-radius',inputRadius:'border-radius',overlayFilter:'backdrop-filter',cardFilter:'backdrop-filter',inputFilter:'backdrop-filter',overlayShadow:'box-shadow',cardShadow:'box-shadow',borderWidth:'border-top-width',font:'font-family',fontSize:'font-size'};
 for (const [key, property] of Object.entries(properties)) {
  const value = appearance.values[key];
  if (typeof value === 'string' && value.length <= 256 && !/url|var[(]|[{};<>]/i.test(value) && CSS.supports(property,value)) document.documentElement.style.setProperty('--device-'+key,value);
 }
}
function renderToolbar(data) {
 const current = data.state.devices.find(device => device.id === data.state.activeDeviceId);
 const name = data.failed ? labels.title : current ? current.name : data.state.activeServerUrl || labels.local;
 const phase = data.operation?.stage === 'restarting' ? labels.restarting : labels.busy;
 text('device-label', data.busy ? phase : name);$('device-label').dir = 'auto';
 $('toolbar-icon').replaceChildren(data.busy ? Object.assign(document.createElement('span'),{className:'spinner'}) : icon(data.state.activeServerUrl ? 'server' : 'monitor'));
 $('device-button').title = data.busy ? phase : name + (data.state.activeServerUrl ? '\\n' + data.state.activeServerUrl : '') + '\\n' + labels.manageTitle;
 $('device-button').setAttribute('aria-label', labels.title + ': ' + (data.busy ? phase : name));
 $('device-button').setAttribute('aria-busy', String(data.busy));$('device-button').disabled = data.busy;
 $('device-button').setAttribute('aria-expanded', String(data.menuOpen));
 const menu = $('device-menu');menu.hidden = !data.menuOpen;menu.replaceChildren();
 for (const device of [{id:null,name:labels.local}, ...data.state.devices]) {
  const active = device.id === null ? data.state.activeServerUrl === null : data.state.activeDeviceId === device.id;
  const item = makeButton('', () => active ? api.dismiss() : api.switchTo(device.id), device.id === null ? 'monitor' : 'server');
  item.className = 'menu-item';item.setAttribute('role','menuitemradio');item.setAttribute('aria-checked',String(active));item.dataset.deviceId = device.id || 'local';
  item.title = device.name + (device.serverUrl ? '\\n' + device.serverUrl : '');
  const name = document.createElement('span');name.className = 'menu-name';name.dir = 'auto';name.textContent = device.name;
  const check = document.createElement('span');check.className = 'menu-check';if (active) check.append(icon('check'));
  item.append(name,check);menu.append(item);
 }
 menu.append(document.createElement('hr'));
 const manage = makeButton(labels.manageTitle, () => api.manage(), 'plus');manage.className = 'menu-item menu-manage';manage.setAttribute('role','menuitem');menu.append(manage);
}
function renderManager(data) {
 text('title', labels.manageTitle);text('description', labels.description);text('list-title',labels.savedDevices + ' · ' + number(data.state.devices.length+1));
 text('toggle-add-label',labels.add);text('add-title',labels.add);text('name-label',labels.name);text('address-label',labels.address);text('add',labels.add);text('add-hint',labels.addHint);text('storage-note',labels.storedLocally);
 $('hide-add').title = labels.close;$('hide-add').setAttribute('aria-label', labels.close);
 const signature = JSON.stringify([data.state,data.busy,working,data.failed,labels]);
 if (signature !== listSignature) {
  listSignature = signature;const list = $('devices');list.replaceChildren();
  for (const device of data.failed ? [] : [{id:null,name:labels.local,serverUrl:''}, ...data.state.devices]) {
   const active = device.id === null ? data.state.activeServerUrl === null : data.state.activeDeviceId === device.id;
   const card = document.createElement('article');card.className = 'device surface-card';card.dataset.deviceId = device.id || 'local';card.dataset.current = String(active);
   const badge = document.createElement('span');badge.className = 'device-icon';badge.append(icon(device.id ? 'server' : 'monitor'));
   const info = document.createElement('div');info.className = 'info';
   const name = document.createElement('div');name.className = 'name';name.dir = 'auto';name.textContent = device.name;info.append(name);
   const address = document.createElement('div');address.className = 'address';address.dir = device.serverUrl ? 'ltr' : 'auto';address.textContent = device.serverUrl || labels.localHint;info.append(address);
   const actions = document.createElement('div');actions.className = 'actions';
   if (active) { const tag = document.createElement('span');tag.className = 'current';tag.append(icon('check'), document.createTextNode(labels.current));actions.append(tag); }
   else { const connect = makeButton(labels.switch, () => api.switchTo(device.id), 'arrow');connect.dataset.action = 'switch';actions.append(connect); }
   if (device.id) { const remove = makeButton('', () => api.remove(device.id), 'trash');remove.className = 'icon-button';remove.dataset.action = 'remove';remove.title = active ? labels.active : labels.remove;remove.setAttribute('aria-label', labels.remove + ' ' + device.name);remove.disabled ||= active;actions.append(remove); }
   card.append(badge,info,actions);list.append(card);
  }
 }
 for (const el of document.querySelectorAll('input,form button,#toggle-add')) el.disabled = working || data.busy || data.failed;
 $('toggle-add').setAttribute('aria-expanded',String(!$('add-form').hidden));
 if (data.failed) status('REMOTE_DEVICE_FAILED',true);
}
function renderAction(data) {
 const operation = data.operation;if (!operation) return;
 const switching = operation.kind === 'switch';const pending = operation.stage === 'confirm';const checking = operation.stage === 'checking';const restarting = operation.stage === 'restarting';const failed = operation.stage === 'error';
 $('action-shell').setAttribute('aria-busy',String(data.busy));
 $('action-icon').replaceChildren(icon(switching ? 'arrow' : 'trash'));
 text('action-title',switching ? labels.switchTitle : labels.deleteTitle);
 text('target-caption',labels.target);text('target-name',operation.target.name);$('target-name').title = operation.target.name;$('target-name').dir = 'auto';
 text('target-address',operation.target.serverUrl || labels.localHint);$('target-address').title = operation.target.serverUrl || labels.localHint;$('target-address').dir = operation.target.serverUrl ? 'ltr' : 'auto';
 $('target-icon').replaceChildren(icon(operation.target.serverUrl ? 'server' : 'monitor'));
 text('action-hint',pending ? (switching ? labels.hint : labels.deleteConfirm) : failed ? '' : restarting ? labels.restartHint : labels.checkingHint);
 $('action-hint').hidden = failed;
 $('progress').hidden = !data.busy;
 text('progress-title',restarting ? labels.restarting : operation.target.serverUrl ? labels.busy : labels.preparing);
 text('check-label',labels.checkConnection);text('restart-label',labels.restartStudio);
 $('step-check').className = restarting ? 'done' : 'active';$('step-restart').className = restarting ? 'active' : '';
 $('step-check').firstElementChild.replaceChildren(restarting ? icon('check') : document.createTextNode(number(1)));$('step-restart').firstElementChild.textContent = number(2);
 text('action-error',failed ? errorText(operation.error) : '');$('action-error').hidden = !failed;
 $('action-cancel').textContent = failed ? labels.close : labels.cancel;
 $('action-cancel').hidden = data.busy;$('action-confirm').hidden = data.busy;
 $('action-new').textContent = labels.openNew;
 $('action-new').hidden = !switching || data.busy;
 $('action-new').disabled = working || data.busy;
 $('action-confirm').textContent = failed ? labels.retry : switching ? labels.openCurrent : labels.remove;
 $('action-confirm').className = switching ? 'primary' : 'danger';
 $('action-confirm').disabled = working || data.busy;$('action-cancel').disabled = working || data.busy;
 updateElapsed();
}
function updateElapsed() {
 const op = latest?.operation;if (!$('elapsed') || !op?.startedAt) return;
 const seconds = Math.max(0,Math.floor((Date.now()-op.startedAt)/1000));
 text('elapsed', labels.elapsed.replace('{seconds}',number(seconds)));
}
function render(data) {
 latest = data;labels = data.labels;document.documentElement.lang = data.locale;document.documentElement.dir = data.locale === 'ar' ? 'rtl' : 'ltr';applyAppearance(data.appearance);
 if ($('device-button')) renderToolbar(data);else if ($('devices')) renderManager(data);else renderAction(data);
 paintStatus();
}
async function refresh() { try { render(await api.state()); } catch { if (labels) status('REMOTE_DEVICE_FAILED',true); } }
async function perform(action) {
 if (working || latest.busy) return;
 working = true;render(latest);status('');
 try { await action(); } catch (error) { status(error,true); }
 finally { working = false;await refresh(); }
}
if ($('device-button')) {
 $('device-button').addEventListener('click', () => api.menu().catch(() => { $('device-button').title = labels.failed; }));
 document.addEventListener('click', event => { if (!event.target.closest('button,nav')) void api.dismiss(); });
 document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { void api.dismiss();$('device-button').focus(); }
  if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && latest.menuOpen) {
   event.preventDefault();const items = [...document.querySelectorAll('#device-menu button:not(:disabled)')];const index = items.indexOf(document.activeElement);
   const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : index < 0 ? (event.key === 'ArrowUp' ? items.length-1 : 0) : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
   items[next]?.focus();
  }
 });
}
if ($('add-form')) {
 const setAddOpen = open => { $('add-form').hidden = !open;$('toggle-add').setAttribute('aria-expanded',String(open));if (open) $('name').focus(); };
 $('toggle-add').addEventListener('click', () => setAddOpen($('add-form').hidden));$('hide-add').addEventListener('click', () => setAddOpen(false));
 $('add-form').addEventListener('submit', event => { event.preventDefault();void perform(async () => { await api.add({name:$('name').value,serverUrl:$('address').value});$('add-form').reset();setAddOpen(false);status('saved'); }); });
}
if ($('action-confirm')) {
 $('action-confirm').addEventListener('click', () => perform(() => api.confirm(latest.operation.token, 'current')));
 $('action-new').addEventListener('click', () => perform(() => api.confirm(latest.operation.token, 'new')));
 $('action-cancel').addEventListener('click', () => api.cancel(latest.operation.token));
 document.addEventListener('keydown', event => { if (event.key === 'Escape' && !latest.busy) void api.cancel(latest.operation.token); });
 setInterval(updateElapsed,1000);
}
api.onChange(refresh);void refresh();
</script></body></html>`
}
