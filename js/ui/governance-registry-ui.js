/*
 * AAA Governance Registry — owner-only versioned-artifact control panel.
 *
 * One place to govern every versioned artifact (prompts, models, templates,
 * policies, calibrations): see each artifact's active version + full history,
 * diff any two versions, and drive the lifecycle — propose, approve, activate,
 * roll back — with each action human-gated + audited. A provenance link shows
 * how many recorded traces used a given version. Nothing here is applied without
 * an explicit approval, and approved versions are immutable.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function reg() { return global.AAA_GOVERNANCE; }
  function provenance() { return global.AAA_PROVENANCE; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const STATUS = {
    draft: '#A1A1AA', proposed: '#F59E0B', approved: '#3B82F6',
    active: '#10B981', deprecated: '#71717A', rolled_back: '#EF4444'
  };

  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: color || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color || 'var(--muted)', opacity: '0.85' } })
    ]);
  }
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  function contentStr(c) { return c == null ? '' : (typeof c === 'object' ? JSON.stringify(c, null, 2) : String(c)); }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !rbac().can('MANAGE_GOVERNANCE')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Governance is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label ? rbac().label() : '') + '. Versioning prompts, models, and policies is restricted to the owner.</div>' }));
      return;
    }
    if (!reg()) { container.appendChild(empty('Governance registry unavailable.')); return; }

    container.appendChild(ui.spinner('Loading governance registry…'));
    let artifacts, all, traces;
    try {
      artifacts = await reg().artifacts();
      all = await reg().list();
      traces = provenance() && provenance().list ? await provenance().list() : [];
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load governance</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' }));
      return;
    }
    container.innerHTML = '';

    const counts = { draft: 0, proposed: 0, approved: 0, active: 0 };
    all.forEach((v) => { if (counts[v.status] != null) counts[v.status]++; });
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(counts.draft, 'Draft', STATUS.draft),
      chip(counts.proposed, 'Proposed', STATUS.proposed),
      chip(counts.approved, 'Approved', STATUS.approved),
      chip(counts.active, 'Active', STATUS.active)
    ]));

    container.appendChild(title('Governed artifacts (' + artifacts.length + ')'));
    if (!artifacts.length) container.appendChild(empty('No governed artifacts yet. Create a draft to begin versioning a prompt, model, template, policy, or calibration.'));
    for (const a of artifacts) container.appendChild(await artifactRow(a, traces, container));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Governance only. No version goes active without your approval, approved versions are immutable, and every action is audited and reversible.' }));
  }

  async function artifactRow(a, traces, container) {
    const ui = U();
    const active = a.active;
    const usedBy = active ? tracesUsing(traces, active.id).length : 0;
    const row = ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(a.artifactType) + ' · ' + esc(a.name) + '</strong>' +
      '<div class="aaa-list-sub">' + a.versions + ' version(s) · active: ' + (active ? 'v' + active.version : '—') +
      (active ? ' · <span style="color:' + STATUS.active + '">' + esc(active.checksum) + '</span>' : '') +
      ' · used by ' + usedBy + ' trace(s)</div>' });
    row.appendChild(ui.button({ label: 'History & diff', size: 'sm', variant: 'secondary', onClick: () => historyDrawer(a.artifactType, a.name, traces) }));
    container && row.appendChild(ui.button({ label: 'Roll back', size: 'sm', variant: 'ghost', onClick: async () => {
      if (!active) { await ui.confirm({ title: 'Nothing active', message: 'There is no active version to roll back.', confirmLabel: 'OK' }); return; }
      const ok = await ui.confirm({ title: 'Roll back ' + a.name + '?', message: 'Revert to the previous version. Reversible + audited.', confirmLabel: 'Roll back' });
      if (!ok) return;
      const res = await reg().rollback(a.artifactType, a.name, { actor: actor() });
      if (!res.ok) await ui.confirm({ title: 'Not allowed', message: res.message || res.error, confirmLabel: 'OK' });
      await render(container);
    } }));
    return row;
  }

  async function historyDrawer(artifactType, name, traces) {
    const ui = U();
    const s = ui.sheet({ title: 'Version history', subtitle: artifactType + ' · ' + name });
    document.body.appendChild(s.overlay);
    await renderHistory(s.body, artifactType, name, traces, s);
  }

  async function renderHistory(body, artifactType, name, traces, sheet) {
    const ui = U();
    body.innerHTML = '';
    const versions = await reg().listHistory(artifactType, name); // newest first
    const chain = await reg().verifyChecksumChain(artifactType, name);
    body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Checksum chain: ' + (chain.ok ? '<span style="color:' + STATUS.active + '">✔ intact (' + chain.length + ')</span>' : '<span style="color:' + STATUS.rolled_back + '">⚠ ' + chain.breaks.length + ' break(s)</span>') + '</strong>' }));

    if (!versions.length) { body.appendChild(empty('No versions.')); return; }
    versions.forEach((v) => {
      const used = tracesUsing(traces, v.id).length;
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + (STATUS[v.status] || 'var(--muted)') + '">v' + v.version + ' · ' + esc(v.status) + '</strong>' +
        '<div class="aaa-list-sub">checksum ' + esc(v.checksum) + (v.approvedBy ? ' · approved by ' + esc(v.approvedBy) : '') + (v.rollbackFrom ? ' · rollback' : '') + ' · used by ' + used + ' trace(s)</div>' +
        (v.notes ? '<div class="aaa-list-sub">' + esc(v.notes) + '</div>' : '') });
      const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      if (v.status === 'draft') actions.appendChild(btn('Propose', 'primary', async () => doTransition('propose', v, body, artifactType, name, traces, sheet)));
      if (v.status === 'proposed') actions.appendChild(btn('Approve', 'primary', async () => doTransition('approve', v, body, artifactType, name, traces, sheet)));
      if (v.status === 'approved') actions.appendChild(btn('Activate', 'primary', async () => doTransition('activate', v, body, artifactType, name, traces, sheet)));
      // Diff against the active version (or the previous one).
      const baseline = versions.find((x) => x.status === 'active' && x.id !== v.id) || versions.find((x) => x.version === v.version - 1);
      if (baseline) actions.appendChild(btn('Diff → v' + baseline.version, 'secondary', () => diffDrawer(baseline, v)));
      actions.appendChild(btn('View', 'ghost', () => viewDrawer(v)));
      row.appendChild(actions);
      body.appendChild(row);
    });
  }

  async function doTransition(op, v, body, artifactType, name, traces, sheet) {
    const ui = U();
    const res = await reg()[op](v.id, { actor: actor() });
    if (!res.ok) await ui.confirm({ title: 'Not allowed', message: res.message || res.error, confirmLabel: 'OK' });
    await renderHistory(body, artifactType, name, traces, sheet);
  }

  /** Minimal line diff: shows removed (−) and added (+) lines between versions. */
  function diffLines(aStr, bStr) {
    const a = String(aStr).split('\n'), b = String(bStr).split('\n');
    const bSet = {}; b.forEach((l) => { bSet[l] = (bSet[l] || 0) + 1; });
    const aSet = {}; a.forEach((l) => { aSet[l] = (aSet[l] || 0) + 1; });
    const out = [];
    a.forEach((l) => { if (!bSet[l]) out.push({ type: 'del', text: l }); });
    b.forEach((l) => { if (!aSet[l]) out.push({ type: 'add', text: l }); });
    if (!out.length) out.push({ type: 'same', text: 'No content differences.' });
    return out;
  }

  function diffDrawer(older, newer) {
    const ui = U();
    const s = ui.sheet({ title: 'Diff', subtitle: 'v' + older.version + ' → v' + newer.version });
    document.body.appendChild(s.overlay);
    s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>v' + older.version + ' (' + esc(older.status) + ') → v' + newer.version + ' (' + esc(newer.status) + ')</strong>' }));
    const diff = diffLines(contentStr(older.content), contentStr(newer.content));
    diff.forEach((d) => {
      const color = d.type === 'add' ? STATUS.active : d.type === 'del' ? STATUS.rolled_back : 'var(--muted)';
      const mark = d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  ';
      s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<span style="color:' + color + ';font-family:monospace">' + esc(mark + d.text) + '</span>' }));
    });
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  function viewDrawer(v) {
    const ui = U();
    const s = ui.sheet({ title: v.artifactType + ' v' + v.version, subtitle: v.name + ' · ' + v.status });
    document.body.appendChild(s.overlay);
    s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub" style="font-family:monospace;white-space:pre-wrap">' + esc(contentStr(v.content)) + '</div>' }));
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  function tracesUsing(traces, versionId) {
    return (traces || []).filter((t) => t && (t.promptVersionId === versionId || t.modelVersionId === versionId || (t.calibrationVersion && t.calibrationVersion.id === versionId)));
  }
  function btn(label, variant, onClick) { return U().button({ label: label, size: 'sm', variant: variant, onClick: onClick }); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Governance Registry', subtitle: 'AAA Carpet — versioned prompts, models, policies' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_GOVERNANCE_UI = { render: render, renderHistory: renderHistory, diffLines: diffLines, open: open };
})(typeof window !== 'undefined' ? window : this);
