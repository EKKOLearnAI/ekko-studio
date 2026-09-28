/** Runs inside the native DSH browser runtime, using its own React and slots. */
export function dshUiSlotClient(registry = false) { return String.raw`
window.__ModuleLoader__.load({id:'studio-dsh-ui',factory(require){
  const React=require('react');
  return {inject:['slots','layout','locale','theme'],apply(ctx){
    ctx.effect(()=>{
      const t=ctx.locale.bind('settings.plugins');
      const sync=()=>{document.documentElement.lang=ctx.locale.getSnapshot().active;document.documentElement.style.setProperty('--studio-dsh-expand',JSON.stringify(t('expand')));document.documentElement.style.setProperty('--studio-dsh-collapse',JSON.stringify(t('collapse')))};
      sync();return ctx.locale.subscribe(sync);
    });
    ctx.effect(()=>{
      // Registered themes are frame-local; setTheme on a built-in id persists to DSH settings.
      const disposeThemes=['light','dark'].map(scheme=>ctx.theme.register({...ctx.theme.getTheme().themes.find(theme=>theme.id===scheme),id:'studio-'+scheme}));
      let selected=new URL(location.href).searchParams.get('studioTheme');
      let disposed=false;
      const sync=()=>{if(!disposed&&(selected==='light'||selected==='dark'))ctx.theme.setTheme('studio-'+selected)};
      const receive=event=>{
        if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='studio-dsh-theme'||!['light','dark'].includes(event.data.theme))return;
        selected=event.data.theme;sync();
      };
      // Native settings refreshes may adopt their own preference; the embedded view follows Studio.
      const stop=ctx.on('theme/change',()=>{if(ctx.theme.getTheme().preference!=='studio-'+selected)queueMicrotask(sync)});
      window.addEventListener('message',receive);sync();
      return ()=>{disposed=true;window.removeEventListener('message',receive);stop();disposeThemes.reverse().forEach(dispose=>dispose())};
    });
    ${registry ? `ctx.effect(()=>{
      document.documentElement.classList.add('studio-dsh-native-panel');
      let disposed=false;
      const select=()=>{if(disposed||!ctx.slots.entries('main').some(entry=>entry.options.key==='plugins'))return;
        if(ctx.layout.panelInfo.getSnapshot().activePanelId!=='plugins')ctx.layout.selectPanel('plugins');
        parent.postMessage({type:'studio-dsh-ui-ready'},location.origin);
      };
      const stops=[ctx.layout.panelInfo.subscribe(()=>queueMicrotask(select)),ctx.slots.subscribe('main',()=>queueMicrotask(select))];select();
      return ()=>{disposed=true;stops.forEach(stop=>stop());document.documentElement.classList.remove('studio-dsh-native-panel')};
    });` : `ctx.slots.register({name:'root',priority:-100,children:{'settings.plugins.tab':{kind:'list',scope:'root'}}},function StudioDshSlot(props){
      React.useEffect(()=>{parent.postMessage({type:'studio-dsh-ui-ready'},location.origin)},[]);
      return React.createElement('main',{className:'studio-dsh-slot'},props.renderSlot('settings.plugins.tab',{}, {only:'configurable'}));
    });`}
  }};
}});
` }
export const DSH_UI_SLOT_CLIENT = dshUiSlotClient()

/** Native backend publishes its own authenticated URL only to the owning pipe. */
export const DSH_UI_SLOT_HOST = String.raw`
export const inject=['connection','webServer'];
export function apply(ctx){
  Promise.resolve(ctx.get('loader').await()).then(()=>console.log('STUDIO_DSH_UI_READY:'+ctx.connection.authenticatedUrl('http://127.0.0.1:'+ctx.webServer.port)));
}
`

/** Keep absolute native URLs inside this frame's DSH mount, including dynamically
 * loaded plugin bundles. No plugin names, fields, or business routes are mapped. */
export function dshUiDocument(html: string, mount: string) {
  const bootstrap = `(${frameTransport.toString()})(${JSON.stringify(mount)});`
  return html.replace(/\b(src|href)=(['"])\/(?!\/)([^'"]*)\2/g, (_, attr, quote, path) => `${attr}=${quote}${mount}${path}${quote}`).replace(/<head([^>]*)>/i, `<head$1><base href="${mount}"><script>${bootstrap}</script>`)
    .replace('</head>', `<style>
html,body,#root{height:auto!important;min-height:100%;background:transparent!important;overflow:auto!important}
/* The native panel retains slot ownership; collapse only its unused shell tracks. */
.studio-dsh-native-panel :has(>[data-rightbar-col]){grid-template-columns:0 minmax(0,1fr) 0!important}
.studio-dsh-native-panel [data-side=sidebar],.studio-dsh-native-panel [data-side=rightbar]{display:none!important}
.studio-dsh-slot{padding:0 0 16px;color:var(--dsw-alias-label-primary)}
.studio-dsh-slot button[aria-expanded]:not([aria-haspopup])::after{content:var(--studio-dsh-expand);font-size:12px;white-space:nowrap;margin-inline-start:8px}
.studio-dsh-slot button[aria-expanded=true]:not([aria-haspopup])::after{content:var(--studio-dsh-collapse)}
</style></head>`)
}

function frameTransport(mount: string) {
  const nativeFetch = window.fetch.bind(window)
  const heartbeat = setInterval(() => {
    void nativeFetch(mount + '__studio_ping').then(response => {
      if (response.status === 401 || response.status === 410) parent.postMessage({ type: 'studio-dsh-ui-expired' }, location.origin)
    }).catch(() => {})
  }, 60_000)
  window.addEventListener('pagehide', () => clearInterval(heartbeat), { once: true })
  const map = (value: string | URL) => {
    const url = new URL(String(value), location.origin + '/')
    if (url.host === location.host && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !url.pathname.startsWith(mount)) url.pathname = mount + url.pathname.slice(1)
    return url.href
  }
  window.fetch = (input, init) => nativeFetch(input instanceof Request ? new Request(map(input.url), input) : map(input), init)
  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    return (originalOpen as any).call(this, method, map(url), ...rest)
  } as typeof originalOpen
  const NativeWebSocket = window.WebSocket
  window.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(map(url), protocols) }
  }
  const NativeEventSource = window.EventSource
  window.EventSource = class extends NativeEventSource {
    constructor(url: string | URL, config?: EventSourceInit) { super(map(url), config) }
  }
  ;(window as any).__DSH_TRANSPORT__ = {
    loadBundle(url: string) {
      return new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = map(url); script.onload = () => resolve(); script.onerror = () => reject(new Error('DSH plugin resource unavailable'))
        document.head.appendChild(script)
      })
    },
  }
}
