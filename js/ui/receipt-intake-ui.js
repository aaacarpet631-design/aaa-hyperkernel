/*
 * AAA Receipts — the Expense Capture & Review screen.
 *
 * The human side of the Receipt Intelligence pipeline: capture a receipt
 * (camera / photo / PDF), watch it get OCR'd + classified, then review and
 * approve it into the books. Approval is the ONLY path to a posted expense and
 * it runs through the Runtime Gateway (REVIEW_RECEIPTS, human-only) — AI can
 * suggest the vendor/category/job, but a person posts.
 *
 * Owner-only (VIEW_FINANCIALS); crew see an honest lock message. No fabricated
 * numbers — empty states say so.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function intake() { return global.AAA_RECEIPT_INTAKE; }
  function engine() { return global.AAA_RECEIPT_INTELLIGENCE; }
  function classifier() { return global.AAA_EXPENSE_CLASSIFIER; }
  function data() { return global.AAA_DATA; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(v) { const n = Number(v); return isFinite(n) ? '$' + n.toFixed(2) : '—'; }

  const STATUS_LABEL = { needs_review: '⚠️ Needs review', ready: '✅ Ready to post', duplicate: '🔁 Possible duplicate', posted: '📗 Posted', rejected: '🗑 Rejected' };

  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: (value && value !== '0' && value !== '$0.00') ? color : 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color, opacity: '0.85' } })
    ]);
  }
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';

    const rbac = global.AAA_RBAC;
    if (rbac && !rbac.can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>🔒 Receipts are owner-only</strong>' +
        '<div class="aaa-list-sub">Signed in as ' + esc(rbac.label()) + '. Expense capture and the books are restricted to the owner.</div>' }));
      return;
    }
    if (!intake()) { container.appendChild(empty('Receipt intake is unavailable.')); return; }

    container.appendChild(ui.spinner('Loading receipts…'));
    const stats = await intake().stats();
    const acc = classifier() ? await classifier().accuracy() : null;
    const queue = await intake().queue();
    container.innerHTML = '';

    // Capture entry — camera / photo / PDF.
    container.appendChild(captureRow(container));

    // Stats.
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(stats.queueDepth, 'In Queue', '#F59E0B'),
      chip(stats.posted, 'Posted', '#10B981'),
      chip(money(stats.postedTotal), 'Posted $', '#3B82F6')
    ]));
    if (acc) {
      container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
        chip(stats.needsReview, 'Needs Review', '#EF4444'),
        chip(stats.duplicates, 'Duplicates', '#A1A1AA'),
        chip(acc.accuracyPct != null ? acc.accuracyPct + '%' : '—', 'AI Accuracy', '#8B5CF6')
      ]));
    }

    // Review queue.
    container.appendChild(title('Review Queue'));
    if (!queue.length) {
      container.appendChild(empty('Nothing waiting. Capture a receipt to get started.'));
      return;
    }
    queue.forEach((r) => container.appendChild(receiptCard(r, container)));
  }

  function captureRow(container) {
    const ui = U();
    const wrap = ui.el('div', { className: 'aaa-list-row' });
    wrap.appendChild(ui.el('strong', { text: '🧾 Capture a receipt' }));
    wrap.appendChild(ui.el('div', { className: 'aaa-list-sub', text: 'Photo, screenshot or PDF. It is OCR’d and classified automatically — you approve before anything posts.' }));
    const input = ui.el('input', { attrs: { type: 'file', accept: 'image/*,application/pdf', capture: 'environment', style: 'display:none' } });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const note = ui.el('p', { className: 'aaa-empty', text: 'Reading receipt…' });
      wrap.appendChild(note);
      const res = engine() ? await engine().captureReceipt(file) : { ok: false, error: 'NO_ENGINE' };
      input.value = '';
      if (res && res.status === 'QUEUED_FOR_NETWORK') note.textContent = 'Saved. Will read it when you’re back online.';
      else if (res && res.ok) await render(container);
      else note.textContent = 'Could not read that file: ' + esc((res && (res.message || res.error)) || 'unknown error');
    });
    wrap.appendChild(input);
    wrap.appendChild(ui.button({ label: 'Capture receipt', icon: '📸', variant: 'primary', full: true, onClick: () => input.click() }));
    return wrap;
  }

  function receiptCard(r, container) {
    const ui = U();
    const o = r.ocr || {};
    const cls = r.classification || {};
    const conf = cls.confidence != null ? ' · ' + cls.confidence + '%' : '';
    const sub = [
      money(o.total),
      r.category + conf,
      o.date ? esc(o.date) : null,
      STATUS_LABEL[r.status] || r.status
    ].filter(Boolean).join(' · ');

    const card = ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(o.vendor || 'Unknown vendor') + '</strong>' +
      '<div class="aaa-list-sub">' + sub + '</div>' +
      (cls.reasoning ? '<div class="aaa-list-sub" style="opacity:.8">🤖 ' + esc(cls.reasoning) + '</div>' : '') +
      (r.jobMatch ? '<div class="aaa-list-sub">📌 Suggested job: ' + esc(r.jobMatch.jobName) + ' (' + r.jobMatch.confidence + '%, ' + esc(r.jobMatch.reason) + ')</div>' : '') +
      (r.duplicateOf ? '<div class="aaa-list-sub" style="color:#EF4444">Looks like a receipt already on file.</div>' : '')
    });

    const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    actions.appendChild(ui.button({ label: 'Approve & post', size: 'sm', variant: 'primary', onClick: () => approve(r, container) }));
    actions.appendChild(ui.button({ label: 'Category', size: 'sm', variant: 'secondary', onClick: () => recategorize(r, container) }));
    actions.appendChild(ui.button({ label: 'Assign job', size: 'sm', variant: 'secondary', onClick: () => assignJob(r, container) }));
    actions.appendChild(ui.button({ label: 'Reject', size: 'sm', variant: 'ghost', onClick: () => reject(r, container) }));
    card.appendChild(actions);
    return card;
  }

  async function approve(r, container) {
    const ui = U();
    let override = false;
    if (r.status === 'duplicate') {
      override = await ui.confirm({ title: 'Post a possible duplicate?', message: 'This looks like a receipt already on file. Post it anyway?', confirmLabel: 'Post anyway' });
      if (!override) return;
    } else {
      const ok = await ui.confirm({ title: 'Post this expense?', message: (r.ocr && r.ocr.vendor || 'Receipt') + ' · ' + money(r.ocr && r.ocr.total) + ' → ' + r.category + (r.jobId ? ' (tagged to the assigned job)' : ' (no job assigned)') + '. This writes a real expense to the books.', confirmLabel: 'Post expense' });
      if (!ok) return;
    }
    const actor = (global.AAA_RBAC && global.AAA_RBAC.label && global.AAA_RBAC.label()) || 'owner';
    const res = await intake().approveAndPost(r.id, { actor: actor, overrideDuplicate: override });
    if (!res.ok) await ui.confirm({ title: 'Could not post', message: res.message || res.error, confirmLabel: 'OK' });
    await render(container);
  }

  function recategorize(r, container) {
    const ui = U();
    const s = ui.sheet({ title: 'Set category', subtitle: r.ocr && r.ocr.vendor || '' , size: 'sm' });
    document.body.appendChild(s.overlay);
    const cats = (classifier() && classifier().CATEGORIES) || ['Materials', 'Fuel', 'Tools', 'Office'];
    cats.forEach((c) => {
      const b = ui.button({ label: c + (c === r.category ? '  ✓' : ''), variant: c === r.category ? 'primary' : 'secondary', full: true, onClick: async () => {
        const actor = (global.AAA_RBAC && global.AAA_RBAC.label && global.AAA_RBAC.label()) || 'owner';
        await intake().reclassify(r.id, c, { actor: actor });
        s.close(); await render(container);
      } });
      s.body.appendChild(b);
    });
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  async function assignJob(r, container) {
    const ui = U();
    const s = ui.sheet({ title: 'Assign to job', size: 'sm' });
    document.body.appendChild(s.overlay);
    let jobs = [];
    try { jobs = (await data().listJobs()).filter((j) => j.currentState !== 'CLOSED'); } catch (_) {}
    if (!jobs.length) s.body.appendChild(empty('No active jobs.'));
    if (r.jobId) s.body.appendChild(ui.button({ label: 'Clear job assignment', variant: 'ghost', full: true, onClick: async () => { await intake().assignJob(r.id, null); s.close(); await render(container); } }));
    jobs.forEach((j) => {
      const sel = r.jobId === j.id;
      s.body.appendChild(ui.button({ label: (j.customerName || j.id) + (sel ? '  ✓' : ''), variant: sel ? 'primary' : 'secondary', full: true, onClick: async () => {
        await intake().assignJob(r.id, j.id); s.close(); await render(container);
      } }));
    });
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  async function reject(r, container) {
    const ui = U();
    const ok = await ui.confirm({ title: 'Reject this receipt?', message: 'It stays on file for the audit trail but will not post to the books.', confirmLabel: 'Reject' });
    if (!ok) return;
    const actor = (global.AAA_RBAC && global.AAA_RBAC.label && global.AAA_RBAC.label()) || 'owner';
    await intake().reject(r.id, 'rejected in review', { actor: actor });
    await render(container);
  }

  // Full-screen bottom sheet (matches Crew & Tools / Contracts entry points).
  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Receipts', subtitle: 'AAA Carpet — expense capture & review' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_RECEIPT_INTAKE_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
