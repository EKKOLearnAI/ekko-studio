import { installScreenshotEditor } from './screenshot-editor'

export interface ScreenshotOverlayLabels {
  hint: string
  confirm: string
  cancel: string
  reset: string
  tools?: Record<string, string>
}

export interface ScreenshotSelection {
  x: number
  y: number
  width: number
  height: number
}

export function screenshotPixelRegion(value: unknown, display: { width: number; height: number }, image: { width: number; height: number }): ScreenshotSelection {
  const rect = value as ScreenshotSelection | null
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(item => typeof item === 'number' && Number.isFinite(item))
    || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0
    || rect.x >= display.width || rect.y >= display.height) {
    throw new Error('SCREENSHOT_INVALID_REGION')
  }
  const x = Math.floor(rect.x * image.width / display.width)
  const y = Math.floor(rect.y * image.height / display.height)
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * image.width / display.width))
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * image.height / display.height))
  return { x, y, width: right - x, height: bottom - y }
}

const toolIcons: Record<string, string> = {
  select: '<path d="m5 3 14 9-7 2-3 7Z"/>',
  rectangle: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="7"/>',
  arrow: '<path d="M4 20 20 4M9 4h11v11"/>',
  pen: '<path d="m4 17 12-12 3 3-12 12-4 1Z"/><path d="m14 7 3 3"/>',
  text: '<path d="M5 5h14M12 5v15M8 20h8"/>',
  mosaic: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  undo: '<path d="M8 5 3 10l5 5M3 10h10a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 5 5 5-5 5M21 10H11a6 6 0 0 0 0 12"/>',
  reset: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>',
  cancel: '<path d="m6 6 12 12M6 18 18 6"/>',
  confirm: '<path d="m4 12 5 5L20 6"/>',
}

export function screenshotOverlayHtml(dataUrl?: string, labels?: ScreenshotOverlayLabels, presentation: 'desktop-overlay' | 'image-editor' = 'desktop-overlay'): string {
  const initial = dataUrl && labels ? JSON.stringify({ requestId: 'preview', frameId: 'preview', dataUrl, labels, presentation }).replace(/</g, '\\u003c') : 'null'
  const icon = (key: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${toolIcons[key]}</svg>`
  const button = (key: string, tool = false) => `<button id="${key}" type="button" data-label="${key}" ${tool ? `data-tool="${key}" aria-pressed="${key === 'select'}"` : ''}>${icon(key)}</button>`
  return `<!doctype html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;user-select:none;font-family:system-ui,sans-serif;cursor:crosshair}
#viewport{position:absolute;inset:0;overflow:hidden}#stage{position:relative;width:100%;height:100%}
body[data-presentation=image-editor]{background:#181b22}
body[data-presentation=image-editor] #viewport{top:48px;overflow:auto}
body[data-presentation=image-editor] #stage{margin:24px auto}
body[data-presentation=image-editor] #hint{top:72px}
#view-controls{position:absolute;inset:0 0 auto;height:48px;display:flex;align-items:center;justify-content:center;gap:8px;background:#20232a;color:#fff;cursor:default}
#view-controls button{width:auto;min-width:32px;padding:0 10px}#source{background:#30343d;color:#fff;border:0;padding:4px;border-radius:4px}
#screen,#annotations{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#shade{position:absolute;inset:0;background:#0006;pointer-events:none}
#hint{position:absolute;top:24px;left:50%;transform:translateX(-50%);background:#181b22ee;color:#fff;padding:12px 20px;border-radius:8px;pointer-events:none;font-size:14px}
#selection{position:absolute;border:1px solid #59b7ff;box-shadow:0 0 0 99999px #0006;cursor:move}
body:not([data-tool=select]) #selection{cursor:crosshair}
#size{position:absolute;left:0;bottom:calc(100% + 8px);padding:4px 7px;border-radius:4px;color:#fff;background:#181b22ee;font-size:12px;white-space:nowrap;pointer-events:none}
.handle{position:absolute;width:8px;height:8px;background:#fff;border:1px solid #59b7ff}
body:not([data-tool=select]) .handle{display:none}
[data-edge=nw]{left:-4px;top:-4px;cursor:nwse-resize}[data-edge=n]{left:calc(50% - 4px);top:-4px;cursor:ns-resize}
[data-edge=ne]{right:-4px;top:-4px;cursor:nesw-resize}[data-edge=e]{right:-4px;top:calc(50% - 4px);cursor:ew-resize}
[data-edge=se]{right:-4px;bottom:-4px;cursor:nwse-resize}[data-edge=s]{left:calc(50% - 4px);bottom:-4px;cursor:ns-resize}
[data-edge=sw]{left:-4px;bottom:-4px;cursor:nesw-resize}[data-edge=w]{left:-4px;top:calc(50% - 4px);cursor:ew-resize}
#toolbar{position:absolute;max-width:calc(100vw - 12px);border:1px solid #ffffff24;border-radius:9px;background:#20232a;box-shadow:0 5px 22px #0006;cursor:default;color:#fff}
.toolbar-row{display:flex;align-items:center;gap:3px;padding:6px;flex-wrap:wrap}
.toolbar-options{border-top:1px solid #ffffff14;padding:7px 10px;gap:8px}
.divider{height:20px;width:1px;background:#ffffff24;margin:0 4px}
button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:5px;background:transparent;color:#e5e7eb;width:32px;height:30px;cursor:pointer;font:13px system-ui,sans-serif}
button:hover,button:focus-visible{background:#ffffff1c;outline:1px solid #59b7ff}button[aria-pressed=true]{background:#ffffff23;color:#65beff}button:disabled{opacity:.3;cursor:default}
#confirm{color:#30d158}#confirm:hover{background:#30d15822}
.swatch{width:18px;height:18px;border:2px solid transparent;border-radius:50%;background:var(--swatch)}.swatch[aria-pressed=true]{border-color:#fff;outline:1px solid #fff;background:var(--swatch)}
#line-width{margin-left:6px;background:#30343d;color:#fff;border:1px solid #ffffff25;border-radius:4px;padding:2px 6px;font-size:12px;cursor:pointer}
#text-editor{position:absolute;min-height:38px;resize:none;max-height:180px;background:#0005;border:1px dashed #59b7ff;outline:0;color:#ff453a;padding:2px;font:24px system-ui,sans-serif;user-select:text}
[hidden]{display:none!important}
</style></head><body>
<div id="viewport"><div id="stage"><canvas id="screen"></canvas><canvas id="annotations"></canvas><div id="shade"></div>
<div id="selection" hidden><span id="size"></span>${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(edge => `<span class="handle" data-edge="${edge}"></span>`).join('')}</div>
<textarea id="text-editor" maxlength="2000" hidden></textarea></div></div><div id="hint"></div>
<div id="view-controls" hidden><select id="source" data-label="source" hidden></select><button id="zoom-out" data-label="zoomOut">−</button><span id="zoom-value"></span><button id="zoom-in" data-label="zoomIn">+</button><button id="fit" data-label="fit">↔</button></div>
<div id="toolbar" hidden><div class="toolbar-row">
${['select', 'rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic'].map(key => button(key, true)).join('')}
<span class="divider"></span>${button('undo')}${button('redo')}<span class="divider"></span>${button('reset')}${button('cancel')}
${button('confirm')}</div>
<div class="toolbar-row toolbar-options" data-label="color">
${['#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#bf5af2', '#ffffff', '#000000'].map((color, index) => `<button type="button" class="swatch" data-color="${color}" style="--swatch:${color}" aria-label="${color}" aria-pressed="${index === 0}"></button>`).join('')}
<select id="line-width" data-label="lineWidth"><option value="2">2 px</option><option value="4" selected>4 px</option><option value="8">8 px</option><option value="12">12 px</option></select></div></div>
<script>window.__screenshotInitial=${initial};(${installScreenshotEditor.toString()})();</script>
</body></html>`
}
