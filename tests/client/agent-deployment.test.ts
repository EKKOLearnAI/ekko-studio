// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAgentDeployment } from '@/components/hermes/chat/agentDeployment.mjs'

describe('Agent deployment lifecycle', () => {
  let surface: HTMLElement
  let source: HTMLElement
  let avatar: HTMLElement
  let frame: FrameRequestCallback
  const bounds = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} })
  const tick = (elapsed: number) => frame(100 + elapsed)
  const overlay = () => document.querySelector<HTMLElement>('.agent-deployment-overlay')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('innerWidth', 800)
    vi.stubGlobal('innerHeight', 844)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(performance, 'now').mockReturnValue(100)
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
    document.body.innerHTML = `<div data-agent-deployment-surface data-agent-deployment-session="new" data-agent-deployment-active="true" data-agent-deployment-status-session="new" data-agent-deployment-status="working">
      <button class="agent-card active"><span class="agent-card-name">Ekko</span></button>
      <img data-agent-deployment-image="ready" data-agent-deployment-target="new" style="opacity:.85" />
    </div>`
    surface = document.body.firstElementChild as HTMLElement
    source = surface.querySelector('button')!
    avatar = surface.querySelector('img')!
    surface.getBoundingClientRect = () => bounds(0, 0, 390, 844)
    source.getBoundingClientRect = () => bounds(110, 240, 170, 260)
    avatar.getBoundingClientRect = () => bounds(28, 108, 32, 32)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  const heroCenter = () => {
    const transform = overlay()!.querySelector<HTMLElement>('.agent-deployment-hero')!.style.transform
    const position = transform.match(/translate3d\(([-.\d]+)px,([-.\d]+)px,0\)/)!
    return { x: Number(position[1]) + 85, y: Number(position[2]) + 130 }
  }

  it.each([[20, 90], [450, 600], [260, 350]])('moves a card at %s,%s to the chat centre', (left, top) => {
    surface.getBoundingClientRect = () => bounds(80, 60, 640, 700)
    source.getBoundingClientRect = () => bounds(left, top, 170, 260)
    surface.dataset.agentDeploymentStatus = 'pending'
    prepareAgentDeployment(source)!.start('new')
    expect(heroCenter()).toEqual({ x: left + 85, y: top + 130 })
    source.remove()
    tick(1150)
    expect(heroCenter()).toEqual({ x: 400, y: 410 })
  })

  it('recentres while waiting when the native container or visible viewport changes', () => {
    surface.dataset.agentDeploymentStatus = 'pending'
    prepareAgentDeployment(source)!.start('new')
    tick(1400)
    expect(heroCenter()).toEqual({ x: 195, y: 422 })
    surface.getBoundingClientRect = () => bounds(0, 60, 390, 420)
    tick(1400)
    expect(heroCenter()).toEqual({ x: 195, y: 270 })
    vi.stubGlobal('visualViewport', { width: 390, height: 360, offsetLeft: 0, offsetTop: 20 })
    tick(1400)
    expect(heroCenter()).toEqual({ x: 195, y: 220 })
  })

  it.each([false, true])('survives source unmount, lands and restores its style with reduced motion %s', reducedMotion => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} })))
    prepareAgentDeployment(source)!.start('new')
    source.remove()
    tick(50)
    expect(overlay()?.dataset.phase).toBe('summoning')
    tick(1400)
    expect(avatar.style.opacity).toBe('0')
    tick(1800)
    expect(avatar.style.opacity).toBe('0.85')
    expect(overlay()?.querySelector<HTMLElement>('.agent-deployment-hero')?.style.transform)
      .toContain('translate3d(-41px,-6px,0) scale(0.12307692307692308)')
    tick(1990)
    expect(overlay()).toBeNull()
  })

  it.each(['session', 'mode', 'avatar'])('cleans up during flight when the %s changes', change => {
    prepareAgentDeployment(source)!.start('new')
    tick(50)
    tick(1400)
    if (change === 'session') surface.dataset.agentDeploymentSession = 'other'
    if (change === 'mode') surface.dataset.agentDeploymentActive = 'false'
    if (change === 'avatar') avatar.remove()
    tick(1500)
    expect(overlay()).toBeNull()
    expect(avatar.style.opacity).toBe('0.85')
  })

  it('fades out a fast reply without landing on another session’s avatar', () => {
    prepareAgentDeployment(source)!.start('new')
    tick(50)
    avatar.dataset.agentDeploymentTarget = 'old'
    surface.dataset.agentDeploymentStatus = 'settled'
    tick(1400)
    expect(overlay()?.dataset.phase).toBe('finishing')
    expect(avatar.style.opacity).toBe('0.85')
    tick(1580)
    expect(overlay()).toBeNull()
  })

  it('reveals the page when preparation fails without a thinking avatar', () => {
    avatar.remove()
    prepareAgentDeployment(source)!.start('new')
    tick(50)
    surface.dataset.agentDeploymentStatus = 'error'
    tick(1400)
    // Once exit starts, a late state update must not strand the overlay.
    surface.dataset.agentDeploymentStatus = 'working'
    tick(1580)
    expect(overlay()).toBeNull()
  })

  it.each(['session', 'image'])('waits beyond the old deadline for %s readiness, with an opaque stage', waiting => {
    if (waiting === 'session') surface.dataset.agentDeploymentStatus = 'pending'
    if (waiting === 'image') avatar.dataset.agentDeploymentImage = 'pending'
    prepareAgentDeployment(source)!.start('new')
    expect(overlay()?.querySelector<HTMLElement>('.agent-deployment-shade')?.style.opacity).toBe('1')
    source.remove()
    tick(50)
    expect(avatar.style.opacity).toBe('0')
    tick(3000)
    vi.advanceTimersByTime(3000)
    expect(overlay()?.dataset.phase).toBe('waiting')
    const hovering = overlay()?.querySelector<HTMLElement>('.agent-deployment-hero')?.style.transform
    tick(3200)
    expect(overlay()?.querySelector<HTMLElement>('.agent-deployment-hero')?.style.transform).not.toBe(hovering)
    surface.dataset.agentDeploymentStatus = 'working'
    avatar.dataset.agentDeploymentImage = 'ready'
    tick(3400)
    expect(overlay()?.dataset.phase).toBe('landing')
    tick(3800)
    tick(3990)
    expect(overlay()).toBeNull()
    expect(avatar.style.opacity).toBe('0.85')
  })

  it('reveals the session if the avatar image fails instead of waiting indefinitely', () => {
    avatar.dataset.agentDeploymentImage = 'error'
    prepareAgentDeployment(source)!.start('new')
    tick(1400)
    expect(overlay()?.dataset.phase).toBe('finishing')
    tick(1580)
    expect(overlay()).toBeNull()
    expect(avatar.style.opacity).toBe('0.85')
  })

  it('restores a replaced target while waiting and cancels navigation', () => {
    surface.dataset.agentDeploymentStatus = 'pending'
    prepareAgentDeployment(source)!.start('new')
    tick(50)
    avatar.remove()
    tick(3000)
    expect(avatar.style.opacity).toBe('0.85')
    surface.dataset.agentDeploymentActive = 'false'
    tick(3100)
    expect(overlay()).toBeNull()
  })

  it('cancels a hidden page and restores the masked avatar', () => {
    prepareAgentDeployment(source)!.start('new')
    tick(1400)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(overlay()).toBeNull()
    expect(avatar.style.opacity).toBe('0.85')
  })

  it('completes an active deployment when the system motion preference changes', () => {
    const motion = Object.assign(new EventTarget(), { matches: false })
    vi.stubGlobal('matchMedia', vi.fn(() => motion))
    prepareAgentDeployment(source)!.start('new')
    tick(50)
    motion.matches = true
    motion.dispatchEvent(new Event('change'))
    tick(1400)
    expect(overlay()?.dataset.phase).toBe('landing')
    tick(1800)
    expect(avatar.style.opacity).toBe('0.85')
    tick(1990)
    expect(overlay()).toBeNull()
  })

  it('handles capture failures without blocking submission', () => {
    vi.spyOn(source, 'cloneNode').mockImplementation(() => { throw new Error('Unavailable view layer') })
    expect(prepareAgentDeployment(source)).toBeNull()
  })

  it('replaces a previous deployment and has a cleanup deadline even without frames', () => {
    prepareAgentDeployment(source)!.start('new')
    tick(1400)
    prepareAgentDeployment(source)!.start('new')
    expect(document.querySelectorAll('.agent-deployment-overlay')).toHaveLength(1)
    expect(avatar.style.opacity).toBe('0.85')
    vi.advanceTimersByTime(60000)
    expect(overlay()).toBeNull()
  })
})
