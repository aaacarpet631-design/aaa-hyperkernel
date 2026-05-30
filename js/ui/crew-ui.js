/*
 * AAA Crew & Tools UI — manage employees/contractors and track equipment.
 *
 * One bottom-sheet HUD with three views: crew roster (+ productivity), tool
 * inventory (+ check-out/in/maintenance), and add forms. Gated by RBAC
 * MANAGE_CREW (owner/manager). Built on the shared AAA_UI kit + red theme.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function crew() { return global.AAA_CREW_STORE; }
  function tools() { return global.AAA_TOOL_STORE; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const state = { sheet: null, view: 'crew' };

  function open() {
    const rbac = global.AAA_RBAC;
    const ui = U();
    const sheet = ui.sheet({ title: 'Crew & Tools', subtitle: 'AAA Carpet — production resources' });
    state.sheet = sheet;
    document.body.appendChild(sheet.overlay);
    if (rbac && !rbac.can('MANAGE_CREW')) {
      sheet.body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>🔒 Restricted</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac.label()) + '. Crew & tool management is for owner/manager.</div>' }));
      return;
    }
    go('crew');
  }

  function go(v) { state.view = v; render(); }
  function tabs() {
    const ui = U();
    return ui.el('div', { className: 'aaa-detail-actions' }, [
      ui.button({ label: 'Crew', size: 'sm', variant: state.view === 'crew' ? 'primary' : 'ghost', onClick: () => go('crew') }),
      ui.button({ label: 'Tools', size: 'sm', variant: state.view === 'tools' ? 'primary' : 'ghost', onClick: () => go('tools') })
    ]);
  }

  async function render() {
    const body = state.sheet.body;
    body.innerHTML = '';
    body.appendChild(tabs());
    if (state.view === 'crew') return renderCrew(body);
    return renderTools(body);
  }

  // ---- Crew ----
  async function renderCrew(body) {
    const ui = U();
    body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Crew' }));
    const members = await crew().list();
    const prod = await crew().productivity();
    const prodById = {}; prod.forEach((p) => { prodById[p.id] = p; });
    if (!members.length) body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No crew yet. Add your first installer or helper.' }));
    members.forEach((m) => {
      const p = prodById[m.id] || { assigned: 0, completed: 0, completionRate: null };
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(m.name) + (m.active ? '' : ' (inactive)') + '</strong>' +
        '<div class="aaa-list-sub">' + esc(m.kind) + (m.role ? ' · ' + esc(m.role) : '') + (m.phone ? ' · ' + esc(m.phone) : '') + '</div>' +
        '<div class="aaa-list-sub">' + p.assigned + ' assigned · ' + p.completed + ' completed' + (p.completionRate != null ? ' · ' + p.completionRate + '%' : '') + '</div>' });
      row.appendChild(ui.button({ label: m.active ? 'Deactivate' : 'Activate', size: 'sm', variant: 'ghost', onClick: async () => { await crew().update(m.id, { active: !m.active }); render(); } }));
      body.appendChild(row);
    });
    body.appendChild(ui.button({ label: 'Add crew member', icon: '➕', variant: 'primary', full: true, onClick: () => addCrewForm(body) }));
  }

  function addCrewForm(body) {
    const ui = U();
    const name = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Name' } });
    const role = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Role (installer, helper, stretcher…)' } });
    const phone = ui.el('input', { className: 'aaa-input', attrs: { type: 'tel', placeholder: 'Phone (optional)' } });
    const kind = ui.el('select', { className: 'aaa-input' }, [
      ui.el('option', { text: 'Employee', attrs: { value: 'employee' } }),
      ui.el('option', { text: 'Contractor', attrs: { value: 'contractor' } })
    ]);
    const s = ui.sheet({ title: 'Add crew member', size: 'sm' });
    document.body.appendChild(s.overlay);
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [name, role, phone, kind]));
    s.body.appendChild(ui.button({ label: 'Save', variant: 'primary', full: true, onClick: async () => {
      if (!name.value.trim()) return;
      await crew().add({ name: name.value.trim(), role: role.value.trim(), phone: phone.value.trim(), kind: kind.value });
      s.close(); render();
    } }));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  // ---- Tools ----
  async function renderTools(body) {
    const ui = U();
    const sum = await tools().summary();
    body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + sum.total + ' tools</strong><div class="aaa-list-sub">' +
      sum.byStatus.available + ' available · ' + sum.byStatus.checked_out + ' out · ' +
      sum.byStatus.maintenance + ' maintenance · ' + sum.byStatus.damaged + ' damaged</div>' }));

    const list = await tools().list();
    const members = await crew().list();
    if (!list.length) body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No tools yet. Add your kickers, stretchers, seam irons…' }));
    const color = { available: '#10B981', checked_out: '#F59E0B', maintenance: '#A1A1AA', damaged: '#EF4444' };
    list.forEach((t) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + (color[t.status] || '#F8FAFC') + '">' + esc(t.name) + '</strong>' +
        '<div class="aaa-list-sub">' + esc(t.category) + ' · ' + esc(t.status.replace('_', ' ')) + (t.heldByName ? ' · ' + esc(t.heldByName) : '') + '</div>' });
      if (t.status === 'available') {
        row.appendChild(ui.button({ label: 'Check out', size: 'sm', variant: 'secondary', onClick: () => checkOutForm(t, members) }));
        row.appendChild(ui.button({ label: 'Maintenance', size: 'sm', variant: 'ghost', onClick: async () => { await tools().setMaintenance(t.id, true); render(); } }));
      } else if (t.status === 'checked_out') {
        row.appendChild(ui.button({ label: 'Check in', size: 'sm', variant: 'success', onClick: async () => { await tools().checkIn(t.id); render(); } }));
        row.appendChild(ui.button({ label: 'Return damaged', size: 'sm', variant: 'danger', onClick: async () => { await tools().checkIn(t.id, 'Returned damaged', { damaged: true }); render(); } }));
      } else if (t.status === 'maintenance') {
        row.appendChild(ui.button({ label: 'Back in service', size: 'sm', variant: 'success', onClick: async () => { await tools().setMaintenance(t.id, false); render(); } }));
      } else if (t.status === 'damaged') {
        row.appendChild(ui.button({ label: 'Repaired', size: 'sm', variant: 'success', onClick: async () => { await tools().setMaintenance(t.id, false); render(); } }));
      }
      body.appendChild(row);
    });
    body.appendChild(ui.button({ label: 'Add tool', icon: '🛠', variant: 'primary', full: true, onClick: () => addToolForm(body) }));
  }

  function checkOutForm(tool, members) {
    const ui = U();
    const s = ui.sheet({ title: 'Check out ' + tool.name, size: 'sm' });
    document.body.appendChild(s.overlay);
    if (!members.length) { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Add a crew member first to assign tools.' })); }
    const sel = ui.el('select', { className: 'aaa-input' }, [ui.el('option', { text: '— Unassigned —', attrs: { value: '' } })].concat(
      members.map((m) => ui.el('option', { text: m.name, attrs: { value: m.id } }))));
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [ui.el('label', { className: 'aaa-field-label', text: 'Assign to' }), sel]));
    s.body.appendChild(ui.button({ label: 'Check out', variant: 'primary', full: true, onClick: async () => {
      const m = members.find((x) => x.id === sel.value);
      const r = await tools().checkOut(tool.id, m ? m.id : null, m ? m.name : null);
      if (!r.ok) { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Could not check out (' + r.error + ').' })); return; }
      s.close(); render();
    } }));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  function addToolForm(body) {
    const ui = U();
    const name = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Tool name' } });
    const category = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Category (e.g. Stretching)' } });
    const s = ui.sheet({ title: 'Add tool', size: 'sm' });
    document.body.appendChild(s.overlay);
    // Quick-add presets for common gear.
    const presetWrap = ui.el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.4rem', margin: '0.4rem 0' } });
    tools().PRESETS.forEach((p) => presetWrap.appendChild(ui.button({ label: p, size: 'sm', variant: 'ghost', onClick: () => { name.value = p; } })));
    s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Quick add' }));
    s.body.appendChild(presetWrap);
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [name, category]));
    s.body.appendChild(ui.button({ label: 'Save', variant: 'primary', full: true, onClick: async () => {
      if (!name.value.trim()) return;
      await tools().add({ name: name.value.trim(), category: category.value.trim() || 'General' });
      s.close(); render();
    } }));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  global.AAA_CREW_UI = { open: open };
})(typeof window !== 'undefined' ? window : this);
