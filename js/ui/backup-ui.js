/* Owner recovery tools. Restores add missing records only; existing device
 * records always survive. Credentials and configuration are never exported.
 */
;(function (global) {
  'use strict';
  const engine = () => global.AAA_SYNC_ENGINE;
  function download(value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'aaa-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function open() {
    if (!global.AAA_RBAC || !global.AAA_RBAC.can('MANAGE_SETTINGS')) return;
    const U = global.AAA_UI, E = engine();
    let unsubscribe;
    const sheet = U.sheet({ title: 'Backups & recovery', subtitle: 'Keep a recoverable copy of saved work.', onClose: () => { if (unsubscribe) unsubscribe(); } });
    const status = U.el('p', { attrs: { role: 'status', 'aria-live': 'polite' } });
    const result = U.el('p', { attrs: { role: 'alert' } });
    const list = U.el('div');
    function show(state) {
      status.textContent = state.message + (state.lastSyncAt ? ' Last confirmed: ' + new Date(state.lastSyncAt).toLocaleString() + '.' : '') +
        (state.unscoped ? ' ' + state.unscoped + ' older records have no workspace and were excluded. Contact support to assign them.' : '');
    }
    show(E.status); unsubscribe = E.subscribe(show);
    const actions = U.el('div', { className: 'closure-actions' });
    let busy = false;
    async function run(fn) {
      if (busy) return;
      busy = true; actions.inert = true; list.inert = true; result.textContent = '';
      try { await fn(); } catch (err) { result.textContent = err.message || 'Could not finish. Your existing records are preserved.'; }
      finally { busy = false; actions.inert = false; list.inert = false; }
    }
    async function restore(snapshot) {
      const preview = await E.previewRestore(snapshot);
      const confirmed = await U.confirm({ title: 'Restore missing records?', message: preview.added + ' missing records will be added. ' + preview.kept + ' existing records will be kept, including ' + preview.conflicts + ' that differ from this backup. The incoming copy is also saved in recovery history. Only restore files you trust.', confirmLabel: 'Restore missing records' });
      if (!confirmed) return;
      const restored = await E.restore(snapshot);
      if (!restored.ok) throw new Error(restored.message || restored.error);
      result.textContent = 'Restored ' + restored.result.added + ' missing records. Kept ' + restored.result.kept + ' existing records.';
    }
    actions.appendChild(U.button({ label: 'Back up now', onClick: () => run(async () => { const r = await E.syncNow(); if (!r.ok) show(E.status); }) }));
    actions.appendChild(U.button({ label: 'Export device copy', variant: 'secondary', onClick: () => run(async () => { download(await E.exportSnapshot()); result.textContent = 'Device copy prepared for download.'; }) }));
    actions.appendChild(U.button({ label: 'Find my cloud backups', variant: 'secondary', onClick: () => run(async () => {
      const r = await E.pull();
      if (!r.ok) throw new Error(r.error === 'SIGN_IN_REQUIRED' ? 'Sign in through Cloud Settings to find your private backups.' : r.error);
      list.innerHTML = '';
      if (!r.backups.length) result.textContent = 'No confirmed backups for this account and workspace yet.';
      for (const backup of r.backups) {
        const row = U.el('section', { className: 'aaa-card' });
        row.appendChild(U.el('h3', { text: new Date(backup.savedAt).toLocaleString() }));
        row.appendChild(U.el('p', { text: 'Device ' + backup.deviceId.slice(-8) + ' · ' + Object.entries(backup.counts || {}).map(([k, n]) => n + ' ' + k.replace(/_/g, ' ')).join(', ') }));
        row.appendChild(U.button({ label: 'Review & restore', variant: 'secondary', onClick: () => run(async () => {
          const found = await E.pull(backup.deviceId, backup.generation); if (!found.ok) throw new Error(found.error); await restore(found.state);
        }) }));
        list.appendChild(row);
      }
      if (r.truncated) result.textContent = 'Showing 100 saved copies. Contact support for additional backup history.';
    }) }));
    const file = U.el('input', { attrs: { type: 'file', accept: '.json,application/json', 'aria-label': 'Choose an AAA backup to restore' } });
    file.addEventListener('change', () => run(async () => {
      const selected = file.files && file.files[0]; if (!selected) return;
      if (selected.size > 5 * 1024 * 1024) throw new Error('Choose an AAA backup smaller than 5 MB.');
      let snapshot; try { snapshot = JSON.parse(await selected.text()); } catch (_) { throw new Error('This file is not valid JSON. Choose an AAA backup.'); }
      await restore(snapshot); file.value = '';
    }));
    actions.appendChild(U.button({ label: 'Recovery history on this device', variant: 'secondary', onClick: () => run(async () => {
      const copies = await global.AAA_LOCAL_FIRST_STORAGE.getAll('restore_archives');
      const ws = global.AAA_CONFIG.workspaceId || 'default';
      list.innerHTML = '';
      const mine = copies.filter(copy => copy.workspaceId === ws);
      if (!mine.length) result.textContent = 'No previous imports on this device.';
      for (const copy of mine) {
        const row = U.el('section', { className: 'aaa-card' });
        row.appendChild(U.el('p', { text: 'Imported copy · ' + new Date(copy.exportedAt || copy.savedAt).toLocaleString() }));
        row.appendChild(U.button({ label: 'Export preserved copy', variant: 'secondary', onClick: () => download(copy) }));
        list.appendChild(row);
      }
    }) }));
    sheet.body.appendChild(status);
    sheet.body.appendChild(U.el('p', { text: 'Includes quotes, unfinished quote forms, jobs, customers, quote outcomes and action history in this workspace. Photos, other app records and cloud credentials are excluded. Each device has its own backup; the app does not automatically combine changes from different devices.' }));
    sheet.body.appendChild(actions);
    sheet.body.appendChild(U.el('label', { text: 'Restore from a device copy' }, [file]));
    sheet.body.appendChild(result); sheet.body.appendChild(list);
    document.body.appendChild(sheet.overlay);
  }
  global.AAA_BACKUP_UI = { open };
})(typeof window !== 'undefined' ? window : this);
