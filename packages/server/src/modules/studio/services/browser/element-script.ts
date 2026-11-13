/**
 * Fixed in-page scripts (spec-04 acceptance 8 / hard rule 1).
 *
 * These are *string constants* evaluated with `Runtime.callFunctionOn` on an
 * object id that Node resolved from a CDP backend node id. Callers can only
 * pass data (a mode flag, a text payload) — never a selector, never a function
 * body. `Runtime.evaluate` is never used with caller-provided expressions.
 */

export const CLICKABLE_ANCESTOR_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
] as const

/** Largest text payload a single read may pull out of the page. */
export const MAX_IN_PAGE_TEXT_LENGTH = 1_000_000

/**
 * Scrolls the node into view and returns the click point for
 * `Input.dispatchMouseEvent`. Returns `{ ok: false, reason }` instead of
 * throwing so the caller can report a precise error.
 */
export const ELEMENT_BOX_SCRIPT = `function () {
  const node = this;
  const element = node && node.nodeType === 3 ? node.parentElement : node;
  if (!element || typeof element.getBoundingClientRect !== 'function') {
    return { ok: false, reason: 'no-element' };
  }
  const selector = ${JSON.stringify(CLICKABLE_ANCESTOR_SELECTOR)};
  const target = typeof element.closest === 'function'
    ? element.closest(selector.join(',')) || element
    : element;
  target.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = target.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { ok: false, reason: 'not-visible' };
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
    return { ok: false, reason: 'outside-viewport' };
  }
  return { ok: true, x: x, y: y, width: rect.width, height: rect.height };
}`

/** Focus the node and clear its current value (the CDP way, not key-by-key). */
export const ELEMENT_FOCUS_AND_CLEAR_SCRIPT = `function () {
  const node = this;
  const element = node && node.nodeType === 3 ? node.parentElement : node;
  if (!element) return false;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof element.focus === 'function') element.focus();
  if ('value' in element) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor && descriptor.set) descriptor.set.call(element, '');
    else element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  if (element.isContentEditable) {
    element.textContent = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return true;
}`

/**
 * Read the node's text. `mode` is the only argument and is a plain string.
 */
export const ELEMENT_READ_TEXT_SCRIPT = `function (mode) {
  const node = this;
  const element = node && node.nodeType === 3 ? node.parentElement : node;
  if (!element) return { ok: false, text: '' };
  const limit = ${MAX_IN_PAGE_TEXT_LENGTH};
  let text = '';
  if (mode === 'textContent') text = String(element.textContent || '');
  else if (typeof element.innerText === 'string') text = element.innerText;
  else text = String(element.textContent || '');
  return { ok: true, text: text.slice(0, limit) };
}`
