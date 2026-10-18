// Shares choreography with the App renderjs implementation. Only this view-layer
// module touches the DOM; sending and session state remain with their owners.
const activeDeployments = new WeakMap();
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - (1 - t) ** 3;
const easeInOut = t => t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;

function snapshotCard(source) {
  const clone = source.cloneNode(true);
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  originals.forEach((element, index) => {
    const computed = source.ownerDocument.defaultView.getComputedStyle(element);
    const target = copies[index];
    for (let i = 0; i < computed.length; i++) {
      const name = computed[i];
      target.style.setProperty(name, computed.getPropertyValue(name));
    }
    target.removeAttribute('id');
    target.removeAttribute('tabindex');
    target.removeAttribute('aria-pressed');
    target.style.animation = 'none';
    target.style.transition = 'none';
    target.style.pointerEvents = 'none';
  });
  clone.className = 'agent-deployment-card-face';
  clone.removeAttribute('role');
  Object.assign(clone.style, { position: 'relative', inset: 'auto', margin: '0',
    width: '100%', height: '100%', transform: 'none', opacity: '1' });
  return clone;
}

/** Capture before the new-chat page unmounts, then start with the new session. */
export function prepareAgentDeployment(source) {
  try { return captureDeployment(source); }
  catch { return null; } // A visual effect must never prevent the first message.
}

function captureDeployment(source) {
  if (!source?.isConnected) return null;
  const doc = source.ownerDocument;
  const win = doc.defaultView;
  // Match NewChatAgentCards: system motion preferences do not hide or slow deployment.
  if (doc.hidden || typeof win.requestAnimationFrame !== 'function') return null;
  const rect = source.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  activeDeployments.get(doc)?.cancel();

  const sourceSurface = source.closest('[data-agent-deployment-surface]');
  const sourceCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const overlay = doc.createElement('div');
  overlay.className = 'agent-deployment-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2100',
    pointerEvents: 'none', overflow: 'hidden', isolation: 'isolate', perspective: '1100px' });
  function layer(name, styles) {
    const el = doc.createElement('div');
    el.className = name;
    Object.assign(el.style, { position: 'absolute', pointerEvents: 'none', ...styles });
    overlay.appendChild(el);
    return el;
  }
  const shade = layer('agent-deployment-shade', { background: 'var(--bg-main-surface)', opacity: '1' });
  const glow = layer('agent-deployment-glow', { width: '380px', height: '380px', borderRadius: '50%',
    background: 'radial-gradient(ellipse,#ecd18655,#8eac9b1a 45%,transparent 70%)', opacity: '0' });
  const floor = layer('agent-deployment-summon', { width: `${rect.width * 1.76}px`, height: `${rect.width * .56}px`,
    border: '1px solid #bd984b99', borderRadius: '50%', boxShadow: '0 0 20px #eac87433', opacity: '0' });
  const innerRing = doc.createElement('div');
  Object.assign(innerRing.style, { position: 'absolute', inset: '15% 14%', border: '1px dashed #88a28299', borderRadius: '50%' });
  floor.appendChild(innerRing);
  const seal = doc.createElement('div');
  Object.assign(seal.style, { position: 'absolute', inset: '0', background: 'repeating-conic-gradient(#d7b66799 0deg 1deg,transparent 1deg 30deg)',
    borderRadius: '50%', maskImage: 'radial-gradient(ellipse,transparent 58%,#000 60% 62%,transparent 64%)' });
  floor.appendChild(seal);
  const wave = layer('agent-deployment-wave', { width: `${rect.width * 1.42}px`, height: `${rect.width * 1.42}px`,
    border: '1px solid #c8a75b', borderRadius: '50%', opacity: '0' });
  const hero = layer('agent-deployment-hero', { left: '0', top: '0', width: `${rect.width}px`, height: `${rect.height}px`,
    transformOrigin: '50% 50%', transformStyle: 'preserve-3d', willChange: 'transform,opacity' });
  const face = snapshotCard(source);
  hero.appendChild(face);
  const sweep = doc.createElement('div');
  Object.assign(sweep.style, { position: 'absolute', inset: '0', overflow: 'hidden', borderRadius: face.style.borderRadius,
    background: 'linear-gradient(115deg,transparent 35%,#fffceb77 48%,#fffdf3bb 50%,transparent 65%)', opacity: '0', mixBlendMode: 'screen' });
  hero.appendChild(sweep);
  const sparks = Array.from({ length: 20 }, (_, i) => layer('agent-deployment-spark', {
    left: '0', top: '0', width: i % 3 ? '3px' : '5px', height: i % 3 ? '3px' : '5px',
    borderRadius: i % 3 ? '50%' : '1px', background: i % 4 ? '#ddbc65' : '#8eac9b', opacity: '0',
  }));
  const landingRing = layer('agent-deployment-landing', { width: '48px', height: '48px',
    border: '1px solid #c8a75b', borderRadius: '50%', opacity: '0' });
  let frame = 0;
  let timer = 0;
  let started = 0;
  let session = '';
  let finished = false;
  let seenSession = false;
  let flightStarted = 0;
  let flightFrom;
  let maskedTarget;
  let targetOpacity = '';
  let fadeStarted = 0;
  let landingBounds;
  const image = face.querySelector('.agent-card-stone img');
  const art = face.querySelector('.agent-card-art');
  const cardName = face.querySelector('.agent-card-name');
  const mark = face.querySelector('.agent-card-mark');

  function restoreTarget() {
    if (maskedTarget) maskedTarget.style.opacity = targetOpacity;
    maskedTarget = null;
  }
  function cancel() {
    if (finished) return;
    finished = true;
    win.cancelAnimationFrame(frame);
    win.clearTimeout(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
    restoreTarget();
    overlay.remove();
    if (activeDeployments.get(doc) === controller) activeDeployments.delete(doc);
  }
  function onVisibility() { if (doc.hidden) cancel(); }
  function surfaceForSession() {
    return Array.from(doc.querySelectorAll('[data-agent-deployment-surface]')).find(el =>
      el.getAttribute('data-agent-deployment-session') === session
      && el.getAttribute('data-agent-deployment-active') === 'true'
      && el.getBoundingClientRect().width > 0);
  }
  function targetIn(surface) {
    return Array.from(surface?.querySelectorAll('[data-agent-deployment-target]') || []).find(el => {
      const r = el.getBoundingClientRect();
      return el.getAttribute('data-agent-deployment-target') === session && r.width > 0 && r.height > 0
        && win.getComputedStyle(el).visibility !== 'hidden';
    }) || null;
  }
  // The session owner exposes preparation separately from the AI run. A DOM
  // avatar alone can appear before history, bridge or image loading finishes.
  function statusIn(surface) {
    const owners = [surface, ...Array.from(surface?.querySelectorAll('[data-agent-deployment-status-session]') || [])];
    return owners.find(el => el?.getAttribute('data-agent-deployment-status-session') === session)
      ?.getAttribute('data-agent-deployment-status') || 'pending';
  }
  function imageState(target) {
    if (!target) return 'pending';
    const state = target.getAttribute('data-agent-deployment-image');
    if (state === 'ready' || state === 'error') return state;
    // Native <img> also handles an already cached image. uni-app images use
    // their load/error events across the service-to-view bridge instead.
    return target.tagName === 'IMG' && target.complete && target.naturalWidth > 0 ? 'ready' : 'pending';
  }
  function paintHero(pose) {
    hero.style.transform = `translate3d(${pose.x - rect.width / 2}px,${pose.y - rect.height / 2}px,0) scale(${pose.scale}) rotate(${pose.r || 0}deg) rotateX(${pose.rx || 0}deg) rotateY(${pose.ry || 0}deg)`;
  }
  function interpolate(a, b, p) {
    return Object.fromEntries(['x', 'y', 'scale', 'r', 'rx', 'ry'].map(key => [key, lerp(a[key] || 0, b[key] || 0, p)]));
  }
  function advance(now) {
    if (finished) return;
    const elapsed = now - started;
    const surface = surfaceForSession();
    if (surface) seenSession = true;
    if ((!surface && seenSession) || (!seenSession && elapsed > 10000)) { cancel(); return; }
    const board = (surface || sourceSurface)?.getBoundingClientRect() || { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
    Object.assign(shade.style, { left: `${board.left}px`, top: `${board.top}px`, width: `${board.width}px`, height: `${board.height}px` });
    // The source can be anywhere after carousel scrolling. It is only the
    // launch point; summoning settles at the visible chat area's centre.
    // Re-measure each frame so keyboard/container resizing moves the stage.
    const viewport = win.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const visibleLeft = Math.max(board.left, viewportLeft);
    const visibleTop = Math.max(board.top, viewportTop);
    const visibleRight = Math.min(board.left + board.width, viewportLeft + (viewport?.width || win.innerWidth));
    const visibleBottom = Math.min(board.top + board.height, viewportTop + (viewport?.height || win.innerHeight));
    const cx = (visibleLeft + Math.max(visibleLeft, visibleRight)) / 2;
    const cy = (visibleTop + Math.max(visibleTop, visibleBottom)) / 2;
    Object.assign(glow.style, { left: `${cx - 190}px`, top: `${cy - 190}px` });
    Object.assign(floor.style, { left: `${cx - rect.width * .88}px`, top: `${cy + rect.height * .58}px` });
    Object.assign(wave.style, { left: `${cx - rect.width * .71}px`, top: `${cy - rect.width * .71}px` });
    const target = targetIn(surface);
    const status = statusIn(surface);
    const asset = imageState(target);
    if (!fadeStarted) {
      if (flightStarted && target !== maskedTarget) { cancel(); return; }
      if (target !== maskedTarget) {
        restoreTarget();
        if (target) {
          maskedTarget = target;
          targetOpacity = target.style.opacity;
          target.style.opacity = '0';
        }
      }
    }
    const poses = [
      [0, { ...sourceCenter, scale: 1 }],
      [120, { x: sourceCenter.x, y: sourceCenter.y + 3, scale: .96, rx: 3 }],
      [480, { x: lerp(sourceCenter.x, cx, .55), y: lerp(sourceCenter.y, cy, .55) - 25, scale: 1.06, r: -7, rx: -8, ry: -13 }],
      [950, { x: cx, y: cy - 18, scale: 1.07, r: 4, rx: -4, ry: 11 }],
      [1150, { x: cx, y: cy, scale: 1 }],
      [1400, { x: cx, y: cy, scale: 1 }],
    ];
    let pose = poses[poses.length - 1][1];
    for (let i = 1; i < poses.length; i++) {
      if (elapsed <= poses[i][0]) {
        const progress = clamp((elapsed - poses[i - 1][0]) / (poses[i][0] - poses[i - 1][0]), 0, 1);
        pose = interpolate(poses[i - 1][1], poses[i][1], i === 1 ? progress : i === 3 ? easeInOut(progress) : easeOut(progress));
        break;
      }
    }
    shade.style.opacity = '1';
    if (elapsed >= 1400 && !flightStarted && !fadeStarted) {
      overlay.dataset.phase = 'waiting';
      const hover = (elapsed - 1400) / 1000;
      pose = { ...pose, y: cy - Math.sin(hover * 2.4) * 3, ry: Math.sin(hover * 1.6) * 1.5 };
    }
    glow.style.opacity = String(.8 * clamp((elapsed - 120) / 360, 0, 1));
    floor.style.opacity = String(.8 * clamp((elapsed - 120) / 360, 0, 1) * (1 - clamp((elapsed - 950) / 240, 0, 1)));
    floor.style.transform = `scale(${.72 + .28 * clamp(elapsed / 480, 0, 1)}) rotate(${clamp((elapsed - 480) / 470, 0, 1) * 24}deg)`;
    const sweepProgress = clamp((elapsed - 520) / 430, 0, 1);
    sweep.style.transform = `translateX(${lerp(-145, 145, sweepProgress)}%)`;
    sweep.style.opacity = String(Math.sin(sweepProgress * Math.PI) * .44);
    const burst = clamp((elapsed - 950) / 350, 0, 1);
    wave.style.opacity = String(elapsed >= 950 ? .65 * (1 - burst) : 0);
    wave.style.transform = `scale(${lerp(.28, 1.28, easeOut(burst))})`;
    sparks.forEach((spark, i) => {
      const charge = i >= 12;
      const p = charge ? clamp((elapsed - 120) / 830, 0, 1) : burst;
      const a = (charge ? (i - 12) / 8 : i / 12) * Math.PI * 2;
      const distance = charge ? lerp(rect.width * .85, rect.width * .45, p) : lerp(rect.width * .45, rect.width * .85, easeOut(p));
      spark.style.transform = `translate(${cx + Math.cos(a) * distance}px,${cy + Math.sin(a) * distance * 1.15}px) rotate(${i * 23 + p * 60}deg)`;
      spark.style.opacity = String(charge ? Math.sin(p * Math.PI) * .65 : elapsed >= 950 ? .8 * (1 - p) : 0);
    });
    if (elapsed >= 1400 && !flightStarted && !fadeStarted && status === 'working' && asset === 'ready' && target) {
      flightStarted = now;
      flightFrom = pose;
      overlay.dataset.phase = 'landing';
    }
    if (flightStarted) {
      if (!fadeStarted && target !== maskedTarget) { cancel(); return; }
      const progress = clamp((now - flightStarted) / 400, 0, 1);
      const end = target?.getBoundingClientRect() || landingBounds;
      landingBounds = end;
      const finish = { x: end.left + end.width / 2, y: end.top + end.height / 2, scale: end.height / rect.height };
      pose = interpolate(flightFrom, finish, easeInOut(progress));
      pose.y -= Math.sin(progress * Math.PI) * rect.height * .1;
      pose.r = -Math.sin(progress * Math.PI) * 10;
      if (cardName) cardName.style.opacity = String(1 - clamp(progress / .62, 0, 1));
      if (mark) mark.style.opacity = String(1 - clamp(progress / .62, 0, 1));
      if (image) image.style.transform = `scale(${lerp(1, 2.7, progress)})`;
      if (art) art.style.transform = `translateY(${progress * rect.height * .095}px)`;
      shade.style.opacity = String(1 - progress);
      glow.style.opacity = String(.8 * (1 - progress));
      if (progress >= 1 && !fadeStarted) { restoreTarget(); fadeStarted = now; }
      if (fadeStarted) {
        hero.style.opacity = String(1 - clamp((now - fadeStarted) / 70, 0, 1));
        Object.assign(landingRing.style, { left: `${finish.x - 24}px`, top: `${finish.y - 24}px`, opacity: String(.65 * (1 - clamp((now - fadeStarted) / 190, 0, 1))),
          transform: `scale(${lerp(.65, 1.1, clamp((now - fadeStarted) / 190, 0, 1))})` });
        // The restored target is intentionally no longer masked after landing.
        if (now - fadeStarted >= 190) { cancel(); return; }
      }
    } else if (fadeStarted || (elapsed >= 1400 && (status === 'settled' || status === 'error' || (status === 'working' && asset === 'error')))) {
      if (!fadeStarted) { fadeStarted = now; overlay.dataset.phase = 'finishing'; }
      const p = clamp((now - fadeStarted) / 180, 0, 1);
      overlay.style.opacity = String(1 - p);
      if (p >= 1) { cancel(); return; }
    }
    paintHero(pose);
    frame = win.requestAnimationFrame(advance);
  }
  const controller = {
    start(sessionId) {
      if (finished || started || !sessionId) return;
      session = String(sessionId);
      overlay.dataset.sessionId = session;
      overlay.dataset.phase = 'summoning';
      const board = sourceSurface?.getBoundingClientRect() || { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
      Object.assign(shade.style, { left: `${board.left}px`, top: `${board.top}px`, width: `${board.width}px`, height: `${board.height}px` });
      doc.body.appendChild(overlay);
      started = win.performance.now();
      activeDeployments.set(doc, controller);
      doc.addEventListener('visibilitychange', onVisibility);
      // Normal completion follows real readiness; this is only orphan cleanup.
      timer = win.setTimeout(cancel, 60000);
      paintHero({ ...sourceCenter, scale: 1 });
      frame = win.requestAnimationFrame(advance);
    },
    cancel,
  };
  return controller;
}
