import { describe, expect, it, vi } from 'vitest'
import { activateDeviceWindow } from '../../packages/desktop/src/main/device-window-activation'
function window(pinned = false) {
  return {isDestroyed:vi.fn(()=>false),isMinimized:vi.fn(()=>true),restore:vi.fn(),show:vi.fn(),focus:vi.fn(),isAlwaysOnTop:vi.fn(()=>pinned),setAlwaysOnTop:vi.fn(),moveTop:vi.fn()}
}
describe('user-requested device window activation',()=>{
  it('restores, raises and focuses without permanently pinning Windows windows',()=>{const w=window();activateDeviceWindow(w as any,'win32');expect(w.restore).toHaveBeenCalled();expect(w.setAlwaysOnTop.mock.calls).toEqual([[true],[false]]);expect(w.moveTop).toHaveBeenCalled();expect(w.focus).toHaveBeenCalled()})
  it('preserves existing always-on-top preference',()=>{const w=window(true);activateDeviceWindow(w as any,'win32');expect(w.setAlwaysOnTop).not.toHaveBeenCalled()})
  it('restores normal z-order even if focus fails',()=>{const w=window();w.focus.mockImplementation(()=>{throw Error('failed')});expect(()=>activateDeviceWindow(w as any,'win32')).toThrow('failed');expect(w.setAlwaysOnTop).toHaveBeenLastCalledWith(false)})
  it('does not alter z-order on other platforms or revive destroyed windows',()=>{const w=window();activateDeviceWindow(w as any,'darwin');expect(w.setAlwaysOnTop).not.toHaveBeenCalled();w.isDestroyed.mockReturnValue(true);w.show.mockClear();activateDeviceWindow(w as any,'win32');expect(w.show).not.toHaveBeenCalled()})
})
