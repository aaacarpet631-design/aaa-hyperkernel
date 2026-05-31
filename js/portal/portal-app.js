/*
 * AAA Customer Portal (public page logic) — runs on portal.html only.
 *
 * Standalone: it does NOT load the main app, has no auth, and talks ONLY to the
 * portalProxy Cloud Function using the token from the URL (?t=...). It renders
 * the redacted view the server returns and lets the customer sign. It never
 * sees internal financials (the server redacts) and holds no credentials.
 *
 * The proxy URL comes from window.PORTAL_PROXY_URL (set in portal.html) or a
 * ?api= override for testing.
 */
(function (global) {
  'use strict';

  function $(sel) { return global.document.querySelector(sel); }
  function el(tag, attrs, kids) {
    const e = global.document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach((c) => e.appendChild(c));
    return e;
  }
  function money(n) { return '$' + Number(n || 0).toFixed(2); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function params() { return new global.URLSearchParams(global.location.search || ''); }
  function token() { return params().get('t'); }
  function apiUrl() { return params().get('api') || global.PORTAL_PROXY_URL || ''; }

  async function call(action, extra) {
    const url = apiUrl();
    if (!url || /__PORTAL_PROXY_URL__/.test(url)) return { ok: false, error: 'PORTAL_NOT_CONFIGURED' };
    const resp = await global.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action, token: token() }, extra || {}))
    });
    return resp.json();
  }

  const root = function () { return $('#portal-root'); };
  function setRoot(node) { const r = root(); r.innerHTML = ''; r.appendChild(node); }
  function note(text) { return el('p', { class: 'muted', text: text }); }

  const ERROR_COPY = {
    PORTAL_NOT_CONFIGURED: 'This portal is not configured yet. Please contact the business.',
    INVALID_LINK: 'This link is not valid. Please ask for a new one.',
    LINK_INACTIVE: 'This link has expired or was revoked. Please ask for a new one.',
    CONTRACT_NOT_FOUND: 'We could not find this document.',
    ALREADY_SIGNED: 'This agreement is already signed.'
  };

  async function load() {
    if (!token()) return setRoot(el('div', {}, [el('h1', { text: 'Missing link' }), note('This page needs a valid link from the business.')]));
    setRoot(el('div', {}, [note('Loading…')]));
    let view;
    try { view = await call('view'); } catch (e) { view = { ok: false, error: 'NETWORK' }; }
    if (!view || !view.ok) return setRoot(el('div', {}, [el('h1', { text: 'Unavailable' }), note(ERROR_COPY[view && view.error] || 'Something went wrong. Please contact the business.')]));
    render(view);
  }

  function render(view) {
    const c = view.contract || {};
    const wrap = el('div', {});
    wrap.appendChild(el('div', { class: 'brand', text: view.businessName || 'AAA Carpet' }));
    wrap.appendChild(el('h1', { text: 'Work Agreement' }));
    wrap.appendChild(el('p', { class: 'muted', text: 'For ' + esc(c.customerName || 'you') }));

    // Scope
    wrap.appendChild(el('h2', { text: 'Scope of work' }));
    (c.lines || []).forEach((l) => wrap.appendChild(el('div', { class: 'row', html: '<span>' + esc(l.description) + '</span><strong>' + money(l.amount) + '</strong>' })));
    wrap.appendChild(el('div', { class: 'row total', html: '<span>Total</span><strong>' + money(c.total) + '</strong>' }));

    // Terms
    if ((c.terms || []).length) {
      wrap.appendChild(el('h2', { text: 'Terms' }));
      c.terms.forEach((t, i) => wrap.appendChild(el('p', { class: 'term', text: (i + 1) + '. ' + t })));
    }

    // Invoice / balance
    if (view.invoice) {
      wrap.appendChild(el('h2', { text: 'Invoice' }));
      wrap.appendChild(el('div', { class: 'row', html: '<span>Status</span><strong>' + esc(view.invoice.status) + '</strong>' }));
      wrap.appendChild(el('div', { class: 'row', html: '<span>Balance due</span><strong>' + money(view.invoice.balance) + '</strong>' }));
      if (view.invoice.balance > 0) wrap.appendChild(note('To pay your balance, please contact the business. Online payment is coming soon.'));
    }

    // Signature state / pad
    if (c.signed) {
      wrap.appendChild(el('div', { class: 'signed', html: '✅ Signed by ' + esc(c.signedBy || '') + (c.signedAt ? ' on ' + esc(c.signedAt.slice(0, 10)) : '') }));
    } else if (view.canSign) {
      wrap.appendChild(buildSign(view));
    } else if (c.status === 'void') {
      wrap.appendChild(note('This agreement is no longer active.'));
    }

    setRoot(wrap);
  }

  function buildSign(view) {
    const box = el('div', { class: 'signbox' });
    box.appendChild(el('h2', { text: 'Sign to approve' }));
    const name = el('input', { class: 'input', type: 'text', placeholder: 'Type your full name' });
    box.appendChild(name);

    const canvas = global.document.createElement('canvas');
    canvas.width = 600; canvas.height = 200; canvas.className = 'pad';
    box.appendChild(canvas);
    const pad = signaturePad(canvas);

    const msg = el('p', { class: 'muted', text: '' });
    const submit = el('button', { class: 'btn primary', text: 'Approve & Sign' });
    const clear = el('button', { class: 'btn ghost', text: 'Clear' });
    clear.addEventListener('click', function () { pad.clear(); });
    submit.addEventListener('click', async function () {
      if (!name.value.trim()) { msg.textContent = 'Please type your name.'; return; }
      if (pad.isEmpty()) { msg.textContent = 'Please sign in the box.'; return; }
      submit.disabled = true; msg.textContent = 'Submitting…';
      let res;
      try { res = await call('sign', { name: name.value.trim(), signatureDataUrl: pad.toDataUrl() }); }
      catch (e) { res = { ok: false, error: 'NETWORK' }; }
      if (res && res.ok) { render(res); }
      else { submit.disabled = false; msg.textContent = ERROR_COPY[res && res.error] || 'Could not sign. Please try again.'; }
    });
    box.appendChild(msg);
    box.appendChild(el('div', { class: 'actions' }, [submit, clear]));
    return box;
  }

  function signaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let drawing = false, dirty = false, last = null;
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const p = (e.touches && e.touches[0]) || e;
      return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
    }
    canvas.addEventListener('pointerdown', function (e) { drawing = true; last = pos(e); e.preventDefault(); });
    canvas.addEventListener('pointermove', function (e) { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; dirty = true; e.preventDefault(); });
    global.addEventListener('pointerup', function () { drawing = false; });
    return { isEmpty: function () { return !dirty; }, clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; }, toDataUrl: function () { return canvas.toDataURL('image/png'); } };
  }

  // Export internals for unit testing under Node; auto-run in a browser.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ERROR_COPY: ERROR_COPY };
  } else {
    global.addEventListener('DOMContentLoaded', load);
  }
})(typeof window !== 'undefined' ? window : this);
