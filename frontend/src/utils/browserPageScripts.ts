/**
 * Page scripts injected into the Bubbly Preview webview to READ and DRIVE the
 * page reliably. These run in the GUEST page context (via executeJavaScript), so
 * they are authored as plain-string JS with no imports and no TS types.
 *
 * They fix the real reasons agent clicks/typing fail today:
 *  - Text matching used to grab the first document-order wrapper <div>/<span>
 *    that merely CONTAINS the text, not the real <button> inside it, then report
 *    success while clicking nothing. Here we rank clickable candidates and climb
 *    to the nearest clickable ancestor.
 *  - `el.click()` fires only a click event, so components that listen on
 *    pointerdown/mousedown (menus, dropdowns, Radix/Headless UI) never opened.
 *    Here we dispatch a full, real pointer+mouse+click sequence with focus.
 *  - Setting `input.value = x` directly is ignored by React controlled inputs.
 *    Here we go through the native value setter so React's onChange fires.
 *  - Snapshots gave the model no stable target and no state (disabled/occluded).
 *    Here every element carries a box, role, disabled/occluded/offscreen flags,
 *    and on a failed click we return the closest candidates so the model
 *    self-corrects in one step instead of blind-retrying (which burns tokens).
 */

/** Shared helper preamble available to every builder below. */
const HELPERS = `
  const __norm = (s) => (s || '').toString().toLowerCase().replace(/[\\u200b\\u00a0]/g, ' ').replace(/\\s+/g, ' ').trim();
  const CLICKABLE = 'a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[onclick],[tabindex]';
  const __isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    let n = el;
    while (n && n.nodeType === 1) {
      const s = getComputedStyle(n);
      if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') < 0.05) return false;
      n = n.parentElement;
    }
    return true;
  };
  const __inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const __isEnabled = (el) => !(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]'));
  const __occludedBy = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const cx = Math.min(innerWidth - 1, Math.max(1, r.left + r.width / 2));
      const cy = Math.min(innerHeight - 1, Math.max(1, r.top + r.height / 2));
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
      return (hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/)[0] : ''));
    } catch (e) { return null; }
  };
  const __deepAll = (sel) => {
    const out = []; let budget = 6000;
    const walk = (root) => {
      if (budget <= 0) return;
      let list; try { list = root.querySelectorAll(sel); } catch (e) { return; }
      for (const el of list) { if (budget-- <= 0) break; out.push(el); }
      const hosts = root.querySelectorAll('*');
      for (const h of hosts) { if (budget-- <= 0) break; if (h.shadowRoot) walk(h.shadowRoot); }
    };
    walk(document);
    return out;
  };
  const __nearestClickable = (el) => {
    let n = el;
    for (let i = 0; i < 6 && n && n.nodeType === 1; i++) {
      if (n.matches && n.matches(CLICKABLE)) return n;
      n = n.parentElement;
    }
    return el;
  };
  const __stableSelector = (el) => {
    const tid = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test'));
    if (tid) return '[data-testid="' + tid + '"]';
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + el.id;
    const nm = el.getAttribute && el.getAttribute('name');
    if (nm && document.querySelectorAll(el.tagName.toLowerCase() + '[name="' + nm + '"]').length === 1) return el.tagName.toLowerCase() + '[name="' + nm + '"]';
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al && document.querySelectorAll('[aria-label="' + al + '"]').length === 1) return '[aria-label="' + al + '"]';
    return null;
  };
  const __label = (el) => __norm(el.getAttribute && el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute && el.getAttribute('placeholder') || el.getAttribute && el.getAttribute('name') || el.title || '').slice(0, 80);
  const __role = (el) => el.getAttribute && el.getAttribute('role') || el.tagName.toLowerCase();
  const __dispatchRealClick = (el) => {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 1 };
    try { el.focus && el.focus({ preventScroll: true }); } catch (e) {}
    const seq = ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click'];
    for (const type of seq) {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, type.startsWith('pointer') ? Object.assign({ pointerId: 1, isPrimary: true }, opts) : opts)); } catch (e) {}
    }
    return true;
  };
  const __setNativeValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const __candidates = (needle) => {
    const t = __norm(needle);
    const scored = __deepAll(CLICKABLE).filter(__isVisible).map((el) => {
      const lbl = __label(el);
      let score = 0;
      if (lbl === t) score = 100; else if (lbl.includes(t) || t.includes(lbl)) score = 60;
      else { const tw = new Set(t.split(' ')); const lw = lbl.split(' '); const hit = lw.filter((w) => tw.has(w)).length; score = hit ? 20 + hit : 0; }
      return { el, lbl, score };
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    return scored.map((c) => ({ tag: c.el.tagName.toLowerCase(), label: c.lbl, sel: __stableSelector(c.el) }));
  };
`;

/** v2 snapshot: rich, targetable page description. */
export const SNAPSHOT_JS = `(() => {
${HELPERS}
  const seen = new Set();
  const items = [];
  const els = __deepAll(CLICKABLE);
  for (const el of els) {
    if (!__isVisible(el)) continue;
    const nc = __nearestClickable(el);
    if (nc !== el && els.includes(nc)) continue; // dedupe wrapper/child pairs
    if (seen.has(el)) continue; seen.add(el);
    const r = el.getBoundingClientRect();
    const lbl = __label(el);
    const tag = el.tagName.toLowerCase();
    if (!lbl && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;
    const sel = __stableSelector(el);
    const occ = __occludedBy(el);
    const flags = [];
    if (!__isEnabled(el)) flags.push('DISABLED');
    if (occ) flags.push('COVERED BY ' + occ);
    if (!__inViewport(el)) flags.push('OFFSCREEN');
    items.push({ tag, role: __role(el), label: lbl, sel, box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, flags });
    if (items.length >= 60) break;
  }
  const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 2500);
  const de = document.documentElement;
  const overflowX = Math.max(0, (de.scrollWidth || 0) - innerWidth);
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(__isVisible).slice(0, 12).map((h) => h.tagName.toLowerCase() + ': ' + __norm(h.innerText).slice(0, 60));
  return {
    title: document.title, url: location.href,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
    page: { scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, scrollX: scrollX, scrollY: scrollY, overflowX },
    counts: { links: document.querySelectorAll('a').length, buttons: document.querySelectorAll('button,[role=button]').length, inputs: document.querySelectorAll('input,textarea,select').length, images: document.querySelectorAll('img').length },
    headings, items, text,
  };
})()`;

/**
 * "Did this page actually paint?" — the check behind the preview's self-heal.
 *
 * A dev server answers `GET /` the instant it binds a port, so a liveness probe
 * says "up" long before the app can render. On a cold Vite start the first
 * document arrives fine and then its module requests 504 while dependencies are
 * still being optimised; the browser is left on a technically-loaded, visually
 * BLANK page with nothing in the console the user would ever see. That is the
 * whole reason Start used to need a manual Refresh: the second load happened
 * after the optimiser had finished, so it worked.
 *
 * Rather than sleep and hope, we ask the guest what it actually has. `blank`
 * means the body rendered no text, no images and no canvas — the mount point is
 * empty. `overlay` means a framework error screen (Vite/Next/CRA) is up, which
 * is a real failure to report, never something to silently reload away.
 */
export const PAINT_CHECK_JS = `(() => {
  try {
    const b = document.body;
    if (!b) return { blank: true, reason: 'no body' };
    // Framework error overlays are a rendered result, not a blank page — and
    // reloading past one would hide a genuine compile error from the user.
    const overlaySel = 'vite-error-overlay,#vite-error-overlay,nextjs-portal,[data-nextjs-dialog],#webpack-dev-server-client-overlay,iframe#react-error-overlay';
    const overlay = document.querySelector(overlaySel);
    if (overlay) return { blank: false, overlay: true, reason: 'error overlay' };
    const text = (b.innerText || '').trim();
    const painted =
      text.length > 0 ||
      b.querySelector('img,svg,canvas,video,input,button') != null ||
      // A styled but text-free shell (a loading splash) still counts as painted.
      b.getElementsByTagName('*').length > 8;
    return {
      blank: !painted,
      overlay: false,
      readyState: document.readyState,
      nodes: b.getElementsByTagName('*').length,
      chars: text.length,
    };
  } catch (e) {
    // A page we cannot script (about:blank, a cross-origin error page) is not
    // evidence of a blank app — don't let it trigger a reload loop.
    return { blank: false, overlay: false, reason: String(e && e.message || e) };
  }
})()`;

/** Multi-strategy click. Returns {status:'clicked', strategy} or {status, candidates}. */
export function buildClickJs(target: { selector?: string; text?: string; x?: number; y?: number }): string {
  const t = JSON.stringify(target || {});
  return `(() => {
${HELPERS}
  const T = ${t};
  let el = null, strategy = '';
  const clickables = () => __deepAll(CLICKABLE).filter(__isVisible);
  // 1. explicit selector
  if (T.selector) { try { el = document.querySelector(T.selector); if (el) { el = __nearestClickable(el); strategy = 'selector'; } } catch (e) {} }
  // 2. coordinates
  if (!el && typeof T.x === 'number' && typeof T.y === 'number') { el = document.elementFromPoint(T.x, T.y); if (el) { el = __nearestClickable(el); strategy = 'coords'; } }
  // 3. text — exact label on a clickable, then ranked substring (shortest/in-viewport first)
  if (!el && T.text) {
    const needle = __norm(T.text);
    const cs = clickables();
    el = cs.find((e) => __label(e) === needle) || null;
    if (el) strategy = 'exact-text';
    if (!el) {
      const ranked = cs.filter((e) => { const l = __label(e); return l.includes(needle) || needle.includes(l); })
        .sort((a, b) => (__label(a).length - __label(b).length) || ((__inViewport(b) ? 1 : 0) - (__inViewport(a) ? 1 : 0)));
      el = ranked[0] || null;
      if (el) { el = __nearestClickable(el); strategy = 'text'; }
    }
  }
  if (!el) return { status: 'not_found', candidates: __candidates(T.text || T.selector || '') };
  if (!__isEnabled(el)) return { status: 'disabled', candidates: __candidates(__label(el)) };
  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  const occ = __occludedBy(el);
  if (occ) return { status: 'occluded', occludedBy: occ, candidates: __candidates(__label(el)) };
  __dispatchRealClick(el);
  // For a plain anchor whose click wasn't intercepted, follow the href.
  try { if (el.tagName === 'A' && el.href && !el.target) { /* real click above already navigates in most apps */ } } catch (e) {}
  return { status: 'clicked', strategy };
})()`;
}

/** Type into an input/textarea/contenteditable via React-safe value setting. */
export function buildTypeJs(target: { selector?: string; text: string }): string {
  const t = JSON.stringify(target || {});
  return `(() => {
${HELPERS}
  const T = ${t};
  let el = null;
  if (T.selector) { try { el = document.querySelector(T.selector); } catch (e) {} }
  if (!el) el = document.activeElement;
  if (!el || el === document.body) {
    // Fall back to the first visible text input.
    el = __deepAll('input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable=true]').filter(__isVisible)[0] || null;
  }
  if (!el) return { status: 'no_field' };
  try { el.focus && el.focus(); } catch (e) {}
  if (el.isContentEditable) { document.execCommand && document.execCommand('insertText', false, T.text); return { status: 'typed' }; }
  if ('value' in el) { __setNativeValue(el, T.text); return { status: 'typed' }; }
  return { status: 'no_field' };
})()`;
}

/** Wait for an element to be VISIBLE + ENABLED (not merely present). */
export function buildIsReadyJs(target: { selector?: string; text?: string }): string {
  const t = JSON.stringify(target || {});
  return `(() => {
${HELPERS}
  const T = ${t};
  let el = null;
  if (T.selector) { try { el = document.querySelector(T.selector); } catch (e) {} }
  if (!el && T.text) { const n = __norm(T.text); el = __deepAll(CLICKABLE).filter(__isVisible).find((e) => __label(e).includes(n)) || null; }
  return !!(el && __isVisible(el) && __isEnabled(el));
})()`;
}

/** Format a v2 snapshot object into the text block returned to the model. */
export function formatSnapshot(snap: any): string {
  const vp = snap.viewport ? `\nViewport: ${snap.viewport.width}x${snap.viewport.height} (dpr ${snap.viewport.dpr})` : '';
  const pg = snap.page ? `\nPage: ${snap.page.scrollWidth}x${snap.page.scrollHeight}${snap.page.overflowX > 0 ? ` — ⚠ horizontal overflow of ${snap.page.overflowX}px` : ''}` : '';
  const counts = snap.counts ? `\nElements: ${snap.counts.links} links, ${snap.counts.buttons} buttons, ${snap.counts.inputs} inputs, ${snap.counts.images} images` : '';
  const headings = snap.headings?.length ? `\nHeadings:\n${snap.headings.join('\n')}` : '';
  const els = Array.isArray(snap.items) && snap.items.length
    ? '\nInteractive elements — click by "label" or sel:\n' + snap.items.map((it: any) => {
        const b = it.box ? ` @${it.box.x},${it.box.y} ${it.box.w}x${it.box.h}` : '';
        const sel = it.sel ? ` sel=${it.sel}` : '';
        const flags = it.flags?.length ? ` [${it.flags.join(', ')}]` : '';
        return `${it.tag} "${it.label}"${sel}${b}${flags}`;
      }).join('\n')
    : '';
  return `Page: ${snap.title}\nURL: ${snap.url}${vp}${pg}${counts}${headings}${els}\n\nVisible text:\n${snap.text}`;
}
