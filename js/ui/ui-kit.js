/*
 * AAA UI Kit — small reusable, dependency-free UI primitives shared across the
 * app (Button, StatusBadge, ProgressBar, bottom-sheet Modal, confirm dialog).
 * Pure DOM factories so the existing vanilla modules can adopt them without a
 * framework. Exposed as window.AAA_UI.
 */
;(function (global) {
  'use strict';
  const sheets = [];
  let sequence = 0, bodyOverflow = '';
  const background = new Map();
  function syncBackground() {
    const top = sheets[sheets.length - 1];
    for (const [node, inert] of background) { node.inert = inert; }
    background.clear();
    if (!top) { document.body.style.overflow = bodyOverflow; return; }
    for (const node of Array.from(document.body.children)) {
      if (node === top.overlay) continue;
      background.set(node, !!node.inert); node.inert = true;
    }
    document.body.style.overflow = 'hidden';
  }

  /** Tiny hyperscript helper. */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    props = props || {};
    if (props.className) node.className = props.className;
    if (props.id) node.id = props.id;
    if (props.text != null) node.textContent = props.text;
    if (props.html != null) node.innerHTML = props.html;
    if (props.attrs) for (const k in props.attrs) node.setAttribute(k, props.attrs[k]);
    if (props.style) for (const k in props.style) node.style[k] = props.style[k];
    if (props.on) for (const ev in props.on) node.addEventListener(ev, props.on[ev]);
    (children || []).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /** Semantic button with variants. variant: primary|secondary|ghost|danger|success */
  function button(opts) {
    opts = opts || {};
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'aaa-btn aaa-btn--' + (opts.variant || 'primary') + (opts.full ? ' aaa-btn--full' : '') + (opts.size === 'sm' ? ' aaa-btn--sm' : '');
    if (opts.icon) b.appendChild(el('span', { className: 'aaa-btn__icon', text: opts.icon, attrs: { 'aria-hidden': 'true' } }));
    b.appendChild(el('span', { text: opts.label || '' }));
    if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
    if (opts.disabled) b.disabled = true;
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
  }

  /** Coloured status pill. */
  function statusBadge(label, color) {
    return el('span', {
      className: 'aaa-status-badge',
      text: label,
      style: { color: color, borderColor: color, background: hexToRgba(color, 0.12) }
    });
  }

  /** Progress bar with a live setter. */
  function progressBar(value, max) {
    const fill = el('div', { className: 'aaa-progress__fill' });
    const root = el('div', { className: 'aaa-progress', attrs: { role: 'progressbar' } }, [fill]);
    function set(v, m) {
      const pct = m > 0 ? Math.round((v / m) * 100) : 0;
      fill.style.width = pct + '%';
      root.setAttribute('aria-valuenow', String(v));
      root.setAttribute('aria-valuemax', String(m));
      // colour shifts from red → amber → green as it fills
      fill.style.background = pct >= 100 ? 'var(--success)' : pct >= 60 ? 'var(--warning)' : 'var(--red)';
    }
    set(value || 0, max || 0);
    return { root: root, set: set };
  }

  /**
   * Mobile-first bottom-sheet modal. Returns { overlay, body, header, close }.
   * Caller appends content to `body`, then `document.body.appendChild(overlay)`.
   */
  function sheet(opts) {
    opts = opts || {};
    if (!sheets.length) bodyOverflow = document.body.style.overflow || '';
    const entry = { previousFocus: document.activeElement };
    sheets.push(entry);
    let closed = false;
    const overlay = el('div', { className: 'aaa-sheet-overlay' });
    entry.overlay = overlay;
    const closeBtn = el('button', {
      className: 'aaa-sheet__close', attrs: { 'aria-label': 'Close', type: 'button' }, text: '×'
    });
    const titleId = 'aaa-dialog-title-' + (++sequence);
    const titleEl = opts.title ? el('h2', { id: titleId, className: 'aaa-sheet__title', text: opts.title }) : null;
    const subEl = opts.subtitle ? el('p', { id: titleId + '-description', className: 'aaa-sheet__subtitle', text: opts.subtitle }) : null;
    const header = el('div', { className: 'aaa-sheet__header' }, [
      el('div', { className: 'aaa-sheet__heading' }, [titleEl, subEl]),
      closeBtn
    ]);
    const body = el('div', { className: 'aaa-sheet__body' });
    const card = el('div', { className: 'aaa-sheet' + (opts.size === 'sm' ? ' aaa-sheet--sm' : ''), attrs: Object.assign({ role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }, titleEl ? { 'aria-labelledby': titleId } : { 'aria-label': opts.ariaLabel || 'Dialog' }) }, [header, body]);
    entry.card = card;
    if (subEl) card.setAttribute('aria-describedby', subEl.id);
    overlay.appendChild(card);

    function close() {
      if (closed) return;
      closed = true;
      const wasTop = sheets[sheets.length - 1] === entry;
      sheets.splice(sheets.indexOf(entry), 1);
      overlay.classList.remove('aaa-sheet-overlay--in');
      document.removeEventListener('keydown', onKey);
      syncBackground();
      overlay.inert = true;
      if (wasTop) {
        const previous = entry.previousFocus;
        const target = previous && previous.isConnected && !previous.closest('[inert]') ? previous : sheets.length ? sheets[sheets.length - 1].card : null;
        if (target && target.focus) target.focus({ preventScroll: true });
      }
      setTimeout(() => overlay.remove(), 180);
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) {
      if (sheets[sheets.length - 1] !== entry) return;
      if (e.key === 'Escape') { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); requestClose(); }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(card.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'))
        .filter((n) => !n.disabled && n.tabIndex >= 0 && !n.closest('[inert]') && n.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1], active = document.activeElement;
      if (!first || !card.contains(active) || e.shiftKey && (active === first || active === card) || !e.shiftKey && active === last) {
        e.preventDefault(); (e.shiftKey ? last || card : first || card).focus();
      }
    }
    let checkingClose = false;
    async function requestClose() {
      if (closed || checkingClose) return;
      if (!opts.beforeClose) { close(); return; }
      checkingClose = true;
      try { if (await opts.beforeClose()) close(); }
      finally { checkingClose = false; }
    }
    closeBtn.addEventListener('click', requestClose);
    overlay.addEventListener('click', (e) => { if (e.target === overlay && sheets[sheets.length - 1] === entry) requestClose(); });
    document.addEventListener('keydown', onKey);
    // animate in (guard rAF for non-browser/test contexts)
    var raf = global.requestAnimationFrame || function (f) { return setTimeout(f, 0); };
    raf(function () {
      if (closed) return;
      overlay.classList.add('aaa-sheet-overlay--in'); syncBackground();
      if (sheets[sheets.length - 1] === entry) card.focus({ preventScroll: true });
    });
    return { overlay: overlay, body: body, header: header, close: close };
  }

  /**
   * Confirmation dialog, optionally requiring a typed reason.
   * Resolves with { reason } on confirm, or null on cancel.
   */
  function confirm(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        resolve(result);
      }
      const s = sheet({ title: opts.title || 'Are you sure?', size: 'sm', onClose: () => finish(null) });
      if (opts.message) s.body.appendChild(el('p', { className: 'aaa-dialog__message', text: opts.message }));

      let reasonInput = null;
      if (opts.requireReason) {
        const reasonId = 'aaa-dialog-reason-' + (++sequence);
        s.body.appendChild(el('label', { className: 'aaa-field-label', text: opts.reasonLabel || 'Reason (required)', attrs: { for: reasonId } }));
        reasonInput = el('textarea', { id: reasonId, className: 'aaa-input aaa-textarea', attrs: { required: '', placeholder: opts.reasonPlaceholder || 'Explain why…' } });
        s.body.appendChild(reasonInput);
      }

      const confirmBtn = button({
        label: opts.confirmLabel || 'Confirm',
        variant: opts.danger ? 'danger' : 'primary',
        full: true,
        onClick: () => {
          if (opts.requireReason) {
            const r = reasonInput.value.trim();
            if (!r) { reasonInput.classList.add('aaa-input--error'); reasonInput.setAttribute('aria-invalid', 'true'); reasonInput.focus(); return; }
            finish({ reason: r }); s.close();
          } else {
            finish({ reason: '' }); s.close();
          }
        }
      });
      const cancelBtn = button({ label: opts.cancelLabel || 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() });
      if (reasonInput) reasonInput.addEventListener('input', () => { reasonInput.classList.remove('aaa-input--error'); reasonInput.setAttribute('aria-invalid', 'false'); });
      s.body.appendChild(el('div', { className: 'aaa-dialog__actions' }, [cancelBtn, confirmBtn]));
      document.body.appendChild(s.overlay);
    });
  }

  /** Small inline spinner element. */
  function spinner(label) {
    return el('div', { className: 'aaa-loading' }, [
      el('div', { className: 'aaa-spinner', attrs: { 'aria-hidden': 'true' } }),
      label ? el('p', { className: 'aaa-loading__label', text: label }) : null
    ]);
  }

  function hexToRgba(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return 'rgba(255,255,255,' + a + ')';
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  global.AAA_UI = { el: el, button: button, statusBadge: statusBadge, progressBar: progressBar, sheet: sheet, confirm: confirm, spinner: spinner, hexToRgba: hexToRgba };
})(typeof window !== 'undefined' ? window : this);
