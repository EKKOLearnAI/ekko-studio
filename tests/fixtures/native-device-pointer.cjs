const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { join } = require('node:path')
const exec = promisify(execFile)
module.exports = async function clickNative(window, view, selector, root) {
  const point = await view.webContents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  if (process.env.STUDIO_TEST_NATIVE_MOUSE !== '1') {
    view.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    view.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    return
  }
  window.show();window.focus()
  await new Promise(resolve => setTimeout(resolve, 100))
  const bounds = view.getBounds()
  const origin = window.getContentBounds()
  if (process.platform === 'darwin') {
    const binary = join(root, 'pointer')
    if (!require('node:fs').existsSync(binary)) await exec('/usr/bin/swiftc', [join(__dirname, 'native-device-pointer.swift'), '-o', binary])
    await exec(binary, [String(origin.x + bounds.x + point.x), String(origin.y + bounds.y + point.y)])
  } else if (process.platform === 'win32') {
    const handle = window.getNativeWindowHandle().readBigUInt64LE().toString()
    // ClientToScreen handles the actual Windows frame offset and monitor DPI.
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeDevicePointer {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr handle, ref POINT point);
 [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr handle);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
 public static void Click(long value, double x, double y) {
  SetThreadDpiAwarenessContext(new IntPtr(-4));
  var handle = new IntPtr(value); var point = new POINT();ClientToScreen(handle, ref point);
  double scale = GetDpiForWindow(handle) / 96.0;
  point.X += (int)Math.Round(x * scale);point.Y += (int)Math.Round(y * scale);
  var hit = SendMessage(handle, 0x84, IntPtr.Zero, new IntPtr((point.Y << 16) | (point.X & 0xffff)));
  if (hit.ToInt64() == 2) throw new Exception("Device control is still a draggable caption");
  SetCursorPos(point.X, point.Y);mouse_event(2,0,0,0,UIntPtr.Zero);
  System.Threading.Thread.Sleep(50);mouse_event(4,0,0,0,UIntPtr.Zero);
 }
}
'@
[NativeDevicePointer]::Click(${handle}, ${bounds.x + point.x}, ${bounds.y + point.y})
`
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 })
  } else throw new Error('OS pointer test supports macOS and Windows')
}
