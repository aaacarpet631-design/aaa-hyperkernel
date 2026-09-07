/* Owner quote workspace. Uses the app's existing sheets, pricing and lifecycle. */
;(function (global) {
  'use strict';
  const U = () => global.AAA_UI;
  const B = () => global.AAA_QUOTE_BUILDER;
  const Q = () => global.AAA_QUOTES;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const money = (v) => '$' + Number(v).toFixed(2);
  const owner = () => global.AAA_RBAC && global.AAA_RBAC.can('VIEW_FINANCIALS');
  const actor = () => global.AAA_RBAC.label();
  const para = (s, cls) => U().el('p', { text: s, className: cls || 'qb-help' });
  const heading = (s) => U().el('h3', { text: s, className: 'qb-heading' });
  function errorText(err) { return err && (err.message || err.error) || 'Could not complete this step. Please retry.'; }
  function button(label, fn, variant) { return U().button({ label: label, onClick: fn, variant: variant || 'secondary' }); }
  function field(label, value, onInput, opts) {
    const o = opts || {};
    const input = U().el(o.multiline ? 'textarea' : 'input', { className: 'aaa-input', attrs: Object.assign({ 'aria-label': label }, o.multiline ? {} : { type: o.type || 'text' }, o.type === 'number' ? { min: '0', step: 'any', inputmode: 'decimal' } : {}, o.attrs || {}) });
    input.value = value == null ? '' : value;
    input.addEventListener('input', () => onInput(input.value));
    return U().el('label', { className: 'qb-field' }, [U().el('span', { text: label }), input]);
  }
  function select(label, value, options, change) {
    const el = U().el('select', { className: 'aaa-input', attrs: { 'aria-label': label } });
    options.forEach((o) => el.appendChild(U().el('option', { text: o.label, attrs: { value: o.id } })));
    el.value = value;
    el.addEventListener('change', () => change(el.value));
    return U().el('label', { className: 'qb-field' }, [U().el('span', { text: label }), el]);
  }
  function receipt(container, preview) {
    const r = preview.estimate.receipt;
    const paper = U().el('section', { className: 'qb-receipt', attrs: { 'aria-label': 'Customer estimate' } });
    paper.appendChild(heading(r.businessName));
    paper.appendChild(para(r.customerName));
    r.items.forEach((it) => paper.appendChild(U().el('div', { className: 'qb-receipt-line' }, [U().el('span', { text: it.description }), U().el('strong', { text: money(it.amount) })])));
    paper.appendChild(U().el('div', { className: 'qb-receipt-line qb-total' }, [U().el('span', { text: 'Total' }), U().el('strong', { text: money(r.total) })]));
    paper.appendChild(para(r.note));
    container.appendChild(paper);
  }

  async function open(opts) {
    const o = opts || {};
    if (!owner()) return U().confirm({ title: 'Owner access required', message: 'The quote builder contains pricing details. Use the field estimator to submit measurements for owner review.', confirmLabel: 'OK' });
    const sheet = U().sheet({ title: 'Build a quote', subtitle: 'Customer → Work → Price & review' });
    document.body.appendChild(sheet.overlay);
    const state = { input: B().fresh(), id: null, revision: null, dirty: true, stage: 'edit', busy: false, changeVersion: 0 };
    const status = U().el('p', { className: 'qb-save-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    let workingWrite = Promise.resolve();
    function persist() {
      const value = { input: clone(state.input), id: state.id, revision: state.revision, dirty: state.dirty };
      workingWrite = workingWrite.catch(() => {}).then(() => B().saveWorking(value)).then(() => { status.textContent = state.dirty ? 'Work in progress saved on this device.' : 'Draft saved. Review before sharing.'; }, (e) => { status.textContent = errorText(e); });
      return workingWrite;
    }
    function changed() { state.dirty = true; state.changeVersion++; persist(); }
    function set(key, v) { state.input[key] = v; changed(); }
    async function guarded(fn) {
      if (state.busy) return;
      if (!owner()) { status.textContent = 'Owner access is required to continue.'; return; }
      state.busy = true;
      try { await fn(); } catch (e) { status.textContent = errorText(e); }
      finally { state.busy = false; }
    }
    try {
      if (o.id) {
        const q = await Q().get(o.id);
        if (!q || !q.builderInput || !['draft', 'reviewed'].includes(q.status)) throw new Error('This quote cannot be edited here.');
        state.input = clone(q.builderInput); state.id = q.id; state.revision = q.revision || 1; state.dirty = false;
      } else if (o.input) {
        state.input = clone(o.input);
      } else {
        const saved = await B().loadWorking();
        if (saved && saved.input && saved.input.version === B().VERSION) Object.assign(state, saved);
      }
    } catch (e) { sheet.body.appendChild(para(errorText(e))); return; }

    function render() {
      const root = sheet.body;
      root.innerHTML = '';
      root.classList.add('qb-workspace');
      root.appendChild(status);
      const top = U().el('div', { className: 'qb-actions' });
      top.appendChild(button('New quote', () => guarded(async () => {
        const ok = await U().confirm({ title: 'Start a new quote?', message: 'This clears the current work form. Quotes already saved in the pipeline are kept.', confirmLabel: 'New quote' });
        if (!ok) return;
        Object.assign(state, { input: B().fresh(), id: null, revision: null, dirty: true, stage: 'edit' });
        await persist(); render();
      })));
      top.appendChild(button('Saved quotes', () => { if (global.AAA_QUOTE_LIFECYCLE_UI) global.AAA_QUOTE_LIFECYCLE_UI.open(); }));
      root.appendChild(top);
      if (state.stage === 'pricing') renderPricing(root);
      else renderWork(root);
    }

    function renderWork(root) {
      root.appendChild(heading('Customer'));
      const customer = U().el('div', { className: 'qb-grid' });
      [['Name', 'name', 'text'], ['Phone', 'phone', 'tel'], ['Email', 'email', 'email'], ['Job address', 'address', 'text']].forEach(([label, key, type]) => customer.appendChild(field(label, state.input.customer[key], (v) => { state.input.customer[key] = v; changed(); }, { type: type })));
      root.appendChild(customer);
      if (state.input.jobId) root.appendChild(para('Linked to job: ' + state.input.jobId));
      root.appendChild(heading('Work to quote'));
      if (!state.input.lines.length) root.appendChild(para('Add a service or enter a custom description and price.'));
      state.input.lines.forEach((row, index) => renderLine(root, row, index));
      root.appendChild(button('Add service line', () => { state.input.lines.push({ serviceId: 'carpet_shampoo', description: '', rooms: 1 }); changed(); render(); }));
      root.appendChild(field('Customer note (optional)', state.input.note, (v) => set('note', v), { multiline: true }));
      root.appendChild(button('Continue to pricing', () => {
        const result = B().preview(state.input);
        if (!result.ok) { status.textContent = errorText(result); return; }
        state.stage = 'pricing'; render();
      }, 'primary'));
    }

    function renderLine(root, row, index) {
      const card = U().el('fieldset', { className: 'qb-line' });
      card.appendChild(U().el('legend', { text: 'Service ' + (index + 1) }));
      const options = global.AAA_MEASUREMENT_QUOTE.serviceOptions().concat([{ id: 'manual', label: 'Custom work / manual price' }]);
      card.appendChild(select('Service', row.serviceId, options, (v) => { state.input.lines[index] = { serviceId: v, description: row.description || '', rooms: 1, units: 1 }; changed(); render(); }));
      const update = (key) => (v) => { row[key] = v; changed(); };
      card.appendChild(field('Room or work description', row.description, update('description')));
      const grid = U().el('div', { className: 'qb-grid' });
      const numeric = (label, key, attrs) => grid.appendChild(field(label, row[key], update(key), { type: 'number', attrs: attrs }));
      const svc = global.AAA_MEASUREMENT_QUOTE.SERVICES[row.serviceId];
      if (row.serviceId === 'manual') {
        numeric('Quantity', 'quantity'); numeric('Price per unit ($)', 'unitPrice');
      } else if (svc && svc.kind === 'linear') numeric('Repair length (ft)', 'linearFeet');
      else if (svc && svc.kind === 'stairs') numeric('Number of stairs', 'stairsCount', { step: '1' });
      else if (svc && svc.kind === 'flat') numeric('Number of units', 'units', { step: '1' });
      else {
        if (row.serviceId === 'carpet_shampoo') numeric('Number of rooms', 'rooms', { step: '1' });
        numeric('Length (ft)', 'length'); numeric('Width (ft)', 'width');
        if (!Number(row.length) && !Number(row.width)) numeric('Measured area (ft², optional for cleaning)', 'squareFeet');
      }
      card.appendChild(grid);
      if (svc && svc.material) {
        const materials = U().el('div', { className: 'qb-grid' });
        materials.appendChild(field('Selected carpet', row.carpetName, update('carpetName')));
        if (svc.material.includes('pad_per_sqft')) materials.appendChild(field('Selected padding', row.padName, update('padName')));
        card.appendChild(materials);
        card.appendChild(para('Confirm the selected material prices on the next screen.'));
      }
      if (row.serviceId === 'carpet_shampoo') card.appendChild(para('Cleaning starts at $45 per room. Measured area and the trip minimum can increase the price.'));
      card.appendChild(button('Remove line', () => { state.input.lines.splice(index, 1); changed(); render(); }, 'ghost'));
      root.appendChild(card);
    }

    function renderPricing(root) {
      root.appendChild(button('Back to customer & work', () => { state.stage = 'edit'; render(); }));
      root.appendChild(heading('Check pricing'));
      root.appendChild(para('These are the rates used for this quote. Changes here apply only to this draft.'));
      const rates = state.input.rateSnapshot;
      const labels = { install_per_sqft: 'Installation / ft² ($)', stretch_per_sqft: 'Stretching / ft² ($)', repair_per_linear_ft: 'Repair / linear ft ($)', shampoo_per_sqft: 'Cleaning / ft² ($)', shampoo_min_per_room: 'Cleaning minimum / room ($)', stairs_each: 'Stair base ($), with 1.5× labor', hallway_per_sqft: 'Hallway / ft² ($)', apartment_turn_flat: 'Apartment turn / unit ($)', commercial_per_sqft: 'Commercial installation / ft² ($)', min_job: 'Trip minimum, once per quote ($)', waste_factor: 'Material allowance (%) — internal only' };
      const used = new Set(['min_job']);
      state.input.lines.forEach((l) => { const svc = global.AAA_MEASUREMENT_QUOTE.SERVICES[l.serviceId]; if (svc) { used.add(svc.labor); if (svc.waste) used.add('waste_factor'); if (l.serviceId === 'carpet_shampoo') used.add('shampoo_min_per_room'); } });
      const prices = U().el('div', { className: 'qb-grid' });
      const resultBox = U().el('div');
      let saveBtn, reviewBtn;
      function refresh() {
        resultBox.innerHTML = '';
        const p = B().preview(state.input);
        if (p.ok) { p.warnings.forEach((w) => resultBox.appendChild(para(w))); receipt(resultBox, p); }
        else resultBox.appendChild(para(errorText(p)));
        if (saveBtn) saveBtn.disabled = !p.ok;
        if (reviewBtn) reviewBtn.disabled = !p.ok || state.dirty || !state.id;
      }
      used.forEach((key) => prices.appendChild(field(labels[key] || key, key === 'waste_factor' ? Number(rates[key]) * 100 : rates[key] == null && key === 'shampoo_min_per_room' ? 45 : rates[key], (v) => { rates[key] = key === 'waste_factor' && v !== '' ? Number(v) / 100 : v; changed(); refresh(); }, { type: 'number' })));
      root.appendChild(prices);
      state.input.lines.forEach((l, index) => {
        const svc = global.AAA_MEASUREMENT_QUOTE.SERVICES[l.serviceId];
        if (!svc || !svc.material) return;
        root.appendChild(heading('Materials · service ' + (index + 1)));
        root.appendChild(field('Carpet price / ft² ($)', l.materialRate == null ? rates.material_per_sqft : l.materialRate, (v) => { l.materialRate = v; changed(); refresh(); }, { type: 'number' }));
        if (svc.material.includes('pad_per_sqft')) root.appendChild(field('Padding price / ft² ($)', l.padRate == null ? rates.pad_per_sqft : l.padRate, (v) => { l.padRate = v; changed(); refresh(); }, { type: 'number' }));
      });
      root.appendChild(resultBox);
      const actions = U().el('div', { className: 'qb-actions qb-bottom' });
      saveBtn = button('Save draft', () => guarded(async () => {
        const changeVersion = state.changeVersion;
        const result = await B().save(state.input, { id: state.id, expectedRevision: state.revision, actor: actor() });
        if (!result.ok) { status.textContent = errorText(result); return; }
        state.id = result.quote.id; state.revision = result.quote.revision;
        if (state.changeVersion === changeVersion) { state.input = clone(result.quote.builderInput); state.dirty = false; }
        await persist(); render();
      }), 'primary');
      reviewBtn = button('Review & approve', () => guarded(async () => {
        if (state.dirty || !state.id) { status.textContent = 'Save your changes first.'; return; }
        const existing = await Q().get(state.id);
        if (existing && existing.revision === state.revision && existing.status === 'reviewed') { sheet.close(); openShare(state.id, state.revision); return; }
        const p = B().preview(state.input);
        if (!p.ok) { status.textContent = errorText(p); return; }
        const ok = await U().confirm({ title: 'Approve this quote?', message: 'I checked the customer, measurements, service rates, selected materials and total of ' + money(p.estimate.quote.total) + '.', confirmLabel: 'Approve quote' });
        if (!ok) return;
        if (state.dirty) { status.textContent = 'The quote was edited. Save and review it again.'; return; }
        const res = await Q().markReviewed(state.id, { actor: actor(), expectedRevision: state.revision, confirmRates: true });
        if (!res.ok) { status.textContent = errorText(res); return; }
        state.revision = res.quote.revision; await persist();
        sheet.close(); openShare(state.id, state.revision);
      }), 'success');
      actions.appendChild(saveBtn); actions.appendChild(reviewBtn); root.appendChild(actions);
      root.appendChild(para('Save first, then approve the exact version you want to share.'));
      refresh();
    }
    render();
    if (o.input) await persist();
  }

  async function openShare(id, revision) {
    const sheet = U().sheet({ title: 'Share customer quote' });
    document.body.appendChild(sheet.overlay);
    const status = para('Loading quote…'); sheet.body.appendChild(status);
    async function checked(fn) {
      try {
        const payload = await B().prepareShare(id, { expectedRevision: revision });
        if (!payload.ok) { status.textContent = errorText(payload); return; }
        await fn(payload);
      } catch (e) { status.textContent = e.name === 'AbortError' ? 'Sharing canceled. The quote status was not changed.' : errorText(e); }
    }
    await checked(async (p) => {
      status.textContent = 'Open a message, share or print. Confirm below only after you have sent it.';
      const content = U().el('textarea', { className: 'aaa-input qb-share-text', attrs: { readonly: '', 'aria-label': 'Customer quote text' } });
      content.value = p.text; sheet.body.appendChild(content);
      const actions = U().el('div', { className: 'qb-actions' });
      if (p.smsUrl) actions.appendChild(button('Open text message', () => checked((fresh) => { if (fresh.smsUrl) global.location.href = fresh.smsUrl; })));
      if (p.emailUrl) actions.appendChild(button('Open email', () => checked((fresh) => { if (fresh.emailUrl) global.location.href = fresh.emailUrl; })));
      if (global.navigator && global.navigator.share) actions.appendChild(button('Share…', () => checked((fresh) => global.navigator.share({ title: fresh.subject, text: fresh.text }))));
      actions.appendChild(button('Copy quote', () => checked(async (fresh) => {
        content.value = fresh.text;
        if (global.navigator && global.navigator.clipboard) { await global.navigator.clipboard.writeText(fresh.text); status.textContent = 'Quote copied. Paste it into your message.'; }
        else { content.focus(); content.select(); status.textContent = 'Quote selected. Use your device’s Copy action.'; }
      })));
      actions.appendChild(button('Print / save PDF', () => {
        const popup = global.open('', '_blank');
        if (!popup) { status.textContent = 'Allow the print window and try again.'; return; }
        popup.opener = null;
        checked((fresh) => {
          popup.document.title = 'AAA Carpet estimate';
          const pre = popup.document.createElement('pre'); pre.textContent = fresh.text;
          pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:16px/1.6 system-ui;padding:24px;color:#111';
          popup.document.body.appendChild(pre); popup.focus(); popup.print();
        }).then(() => { if (!popup.document.body.textContent) popup.close(); });
      }));
      sheet.body.appendChild(actions);
      if (p.status === 'reviewed') sheet.body.appendChild(button('I sent this quote', async () => {
        const ok = await U().confirm({ title: 'Record as sent?', message: 'Confirm you sent this quote to the customer. Opening or canceling a message does not send it.', confirmLabel: 'Yes, I sent it' });
        if (!ok) return;
        await checked(async () => {
          const res = await Q().send(id, { actor: actor(), expectedRevision: revision, confirmedSent: true });
          if (!res.ok) { status.textContent = errorText(res); return; }
          sheet.close(); if (global.AAA_QUOTE_LIFECYCLE_UI) global.AAA_QUOTE_LIFECYCLE_UI.openDetail(id);
        });
      }, 'primary'));
    });
  }
  global.AAA_QUOTE_BUILDER_UI = { open: open, openShare: openShare };
})(typeof window !== 'undefined' ? window : this);
