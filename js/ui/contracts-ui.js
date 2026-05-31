/*
 * AAA Contracts UI — create work agreements and capture an on-device signature.
 *
 * Opened from the Command Center. Lists jobs, builds a draft contract from a
 * job's estimates, shows scope + total + terms, and captures the customer's
 * signature on a canvas. Signing finalizes a customer price, so it goes through
 * the Runtime Gateway (FINALIZE_PRICE) — RBAC-checked and audited. Gated by
 * APPROVE_QUOTE (owner/manager); crew can view but not finalize.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function store() { return global.AAA_CONTRACTS; }
  function data() { return global.AAA_DATA; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const state = { sheet: null };

  async function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Contracts', subtitle: 'Work agreements & e-signature' });
    state.sheet = sheet;
    document.body.appendChild(sheet.overlay);
    await renderList();
  }

  async function renderList() {
    const ui = U();
    const body = state.sheet.body;
    body.innerHTML = '';
    const contracts = await store().list();
    const color = { draft: '#F59E0B', signed: '#10B981', void: '#A1A1AA' };

    body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Existing contracts' }));
    if (!contracts.length) body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No contracts yet. Create one from a job below.' }));
    contracts.forEach((c) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + (color[c.status] || '#F8FAFC') + '">' + esc(c.customerName) + ' — $' + Number(c.total).toFixed(2) + '</strong>' +
        '<div class="aaa-list-sub">' + esc(c.status) + (c.signature ? ' · signed by ' + esc(c.signature.name) : '') + '</div>' });
      row.appendChild(ui.button({ label: c.status === 'signed' ? 'View' : 'Open', size: 'sm', variant: 'secondary', onClick: () => openContract(c.id) }));
      if (global.AAA_PORTAL_LINKS && c.status !== 'void') {
        row.appendChild(ui.button({ label: 'Share', size: 'sm', variant: 'ghost', onClick: () => shareContract(c) }));
      }
      body.appendChild(row);
    });

    body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Create from a job' }));
    const jobs = (await data().listJobs()).filter((j) => j.currentState !== 'CLOSED');
    if (!jobs.length) body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No open jobs.' }));
    jobs.slice(0, 25).forEach((j) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(j.customerName || 'Job') + '</strong><div class="aaa-list-sub">' + esc(j.currentState || '') + ' · ' + (Array.isArray(j.estimates) ? j.estimates.length : 0) + ' estimate(s)</div>' });
      row.appendChild(ui.button({ label: 'New contract', size: 'sm', variant: 'primary', onClick: async () => {
        const c = await store().createFromJob(j);
        if (c) openContract(c.id);
      } }));
      body.appendChild(row);
    });
  }

  async function openContract(id) {
    const ui = U();
    const c = await store().get(id);
    if (!c) return;
    const rbac = global.AAA_RBAC;
    const canFinalize = !rbac || rbac.can('APPROVE_QUOTE');

    const s = ui.sheet({ title: 'Work Agreement', subtitle: c.customerName });
    document.body.appendChild(s.overlay);

    s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Scope' }));
    c.lines.forEach((l) => s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(l.description) + '</strong><div class="aaa-list-sub">$' + Number(l.amount).toFixed(2) + '</div>' })));
    s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Total: $' + Number(c.total).toFixed(2) + '</strong>' }));

    s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Terms' }));
    c.terms.forEach((t, n) => s.body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: (n + 1) + '. ' + t })));

    if (c.status === 'signed') {
      s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>✅ Signed</strong><div class="aaa-list-sub">' + esc(c.signature.name) + ' · ' + esc(c.signature.signedAt) + '</div>' }));
      if (c.signature.dataUrl) {
        const img = ui.el('img', { attrs: { src: c.signature.dataUrl, alt: 'signature' }, style: { maxWidth: '100%', background: '#fff', borderRadius: '8px', marginTop: '0.5rem' } });
        s.body.appendChild(img);
      }
      return;
    }
    if (c.status === 'void') { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'This contract was voided.' })); return; }

    if (!canFinalize) {
      s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Your role can view this contract but not finalize/sign it.' }));
      return;
    }

    // Signature pad
    s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Customer signature' }));
    const nameInput = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Customer full name' } });
    nameInput.value = c.customerName && c.customerName !== 'Customer' ? c.customerName : '';
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [nameInput]));

    const pad = makeSignaturePad(ui);
    s.body.appendChild(pad.wrap);

    const msg = ui.el('p', { className: 'aaa-empty', text: '' });
    s.body.appendChild(msg);

    s.body.appendChild(ui.button({ label: 'Sign & finalize', icon: '✍️', variant: 'primary', full: true, onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) { msg.textContent = 'Enter the customer name to sign.'; return; }
      if (pad.isEmpty()) { msg.textContent = 'Please capture a signature.'; return; }
      const sig = { name: name, dataUrl: pad.toDataUrl() };
      const gw = global.AAA_RUNTIME_GATEWAY;
      const mutate = () => store().sign(c.id, sig);
      const res = gw ? await gw.run({ action: 'FINALIZE_PRICE', origin: 'human', target: { type: 'contract', id: c.id }, detail: { total: c.total, jobId: c.jobId }, mutate: mutate }) : await mutate();
      const inner = res && res.result ? res.result : res; // gateway wraps result
      if (res && res.ok === false) { msg.textContent = res.error === 'FORBIDDEN' ? 'Your role cannot finalize a price.' : ('Could not sign: ' + res.error); return; }
      if (inner && inner.ok === false) { msg.textContent = 'Could not sign: ' + inner.error; return; }
      s.close();
      await renderList();
    } }));
    s.body.appendChild(ui.button({ label: 'Clear signature', variant: 'ghost', full: true, onClick: () => pad.clear() }));
    s.body.appendChild(ui.button({ label: 'Close', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  // A minimal pointer-driven signature canvas.
  function makeSignaturePad(ui) {
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 200;
    canvas.style.width = '100%'; canvas.style.height = '160px';
    canvas.style.background = '#fff'; canvas.style.borderRadius = '8px'; canvas.style.touchAction = 'none';
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let drawing = false, dirty = false, last = null;
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const p = (e.touches && e.touches[0]) || e;
      return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
    }
    function down(e) { drawing = true; last = pos(e); e.preventDefault(); }
    function move(e) {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; dirty = true; e.preventDefault();
    }
    function up() { drawing = false; }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    const wrap = ui.el('div', { style: { margin: '0.4rem 0' } }, [canvas]);
    return {
      wrap: wrap,
      isEmpty: () => !dirty,
      clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
      toDataUrl: () => canvas.toDataURL('image/png')
    };
  }

  // Generate (or reuse) a customer share link and present it to copy/send.
  async function shareContract(contract) {
    const ui = U();
    const links = global.AAA_PORTAL_LINKS;
    const s = ui.sheet({ title: 'Share with customer', subtitle: contract.customerName, size: 'sm' });
    document.body.appendChild(s.overlay);

    const cloudReady = !!(data() && data().cloudReady && data().cloudReady());
    if (!cloudReady) {
      s.body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Cloud is not connected yet. You can still create the link, but the customer page only works once Firestore + the portal function are set up (see functions/portal-proxy).' }));
    }

    const existing = (await links.forContract(contract.id)).filter((l) => links.isLive(l));
    const res = existing.length ? { ok: true, link: existing[0], url: links.urlFor(existing[0].id) } : await links.create(contract, { expiresInDays: 30, allowSign: true });
    if (!res.ok) { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Could not create link: ' + res.error })); return; }

    const urlField = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', readonly: 'readonly', value: res.url } });
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [ui.el('label', { className: 'aaa-field-label', text: 'Customer link (expires in 30 days)' }), urlField]));

    s.body.appendChild(ui.button({ label: 'Copy link', icon: '📋', variant: 'primary', full: true, onClick: async () => {
      try { await navigator.clipboard.writeText(res.url); } catch (_) { urlField.select(); }
      urlField.select();
    } }));
    if (navigator.share) {
      s.body.appendChild(ui.button({ label: 'Send…', icon: '📤', variant: 'secondary', full: true, onClick: () => navigator.share({ title: 'Your work agreement', url: res.url }).catch(function () {}) }));
    }
    s.body.appendChild(ui.button({ label: 'Revoke link', variant: 'ghost', full: true, onClick: async () => { await links.revoke(res.link.id); s.close(); } }));
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  global.AAA_CONTRACTS_UI = { open: open };
})(typeof window !== 'undefined' ? window : this);
