/*
 * AAA Schedule UI — dispatch calendar (next 7 days) with conflict warnings.
 *
 * Shows each upcoming day's jobs with crew + time, flags double-booked crew,
 * lists unscheduled jobs, and lets owner/manager assign crew + a start time —
 * routed through the Runtime Gateway (EDIT_JOB) so writes are RBAC-checked and
 * audited, and pre-checked for conflicts. Opened from the Command Center.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function sched() { return global.AAA_SCHEDULING; }
  function data() { return global.AAA_DATA; }
  function crew() { return global.AAA_CREW_STORE; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const state = { sheet: null };

  async function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Schedule & Dispatch', subtitle: 'Next 7 days' });
    state.sheet = sheet;
    document.body.appendChild(sheet.overlay);
    await render();
  }

  function hhmm(mins) {
    if (mins == null) return 'no time';
    const h = Math.floor(mins / 60), m = mins % 60;
    const ap = h < 12 ? 'AM' : 'PM'; const h12 = ((h + 11) % 12) + 1;
    return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap;
  }
  function dayLabel(k) {
    const d = new Date(k + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  async function render() {
    const ui = U();
    const body = state.sheet.body;
    body.innerHTML = '';

    const up = await sched().upcoming(7);
    const conflicts = await sched().allConflicts();
    const crewById = {};
    (await crew().list()).forEach((m) => { crewById[m.id] = m.name; });
    const names = (ids) => (Array.isArray(ids) && ids.length) ? ids.map((id) => crewById[id] || '—').join(', ') : 'Unassigned';

    const totalConflicts = Object.values(conflicts).reduce((s, c) => s + c.length, 0);
    if (totalConflicts) {
      body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:#EF4444">⚠️ ' + totalConflicts + ' scheduling conflict(s)</strong>' +
        '<div class="aaa-list-sub">A crew member is double-booked in overlapping time windows.</div>' }));
    }

    up.forEach((day) => {
      body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: dayLabel(day.date) + (day.jobs.length ? '' : ' — open') }));
      const dayConflicts = conflicts[day.date] || [];
      const conflicted = {};
      dayConflicts.forEach((c) => { conflicted[c.a.id] = true; conflicted[c.b.id] = true; });
      day.jobs.forEach((j) => {
        const bad = conflicted[j.id];
        const row = ui.el('div', { className: 'aaa-list-row', html:
          '<strong' + (bad ? ' style="color:#EF4444"' : '') + '>' + (bad ? '⚠️ ' : '') + esc(j.customerName || 'Job') + '</strong>' +
          '<div class="aaa-list-sub">' + esc(hhmm(sched()._startMins(j))) + ' · ' + sched()._duration(j) + ' min · ' + esc(names(j.assigneeIds)) + '</div>' +
          (j.serviceAddress ? '<div class="aaa-list-sub">' + esc(j.serviceAddress) + '</div>' : '') });
        row.appendChild(ui.button({ label: 'Assign', size: 'sm', variant: bad ? 'danger' : 'secondary', onClick: () => assignForm(j) }));
        body.appendChild(row);
      });
    });

    // Unscheduled
    const cal = await sched().calendar();
    if (cal.unscheduled.length) {
      body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Unscheduled (' + cal.unscheduled.length + ')' }));
      cal.unscheduled.slice(0, 30).forEach((j) => {
        const row = ui.el('div', { className: 'aaa-list-row', html:
          '<strong>' + esc(j.customerName || 'Job') + '</strong><div class="aaa-list-sub">' + esc(j.currentState || '') + '</div>' });
        row.appendChild(ui.button({ label: 'Schedule', size: 'sm', variant: 'primary', onClick: () => assignForm(j) }));
        body.appendChild(row);
      });
    }
  }

  async function assignForm(job) {
    const ui = U();
    const rbac = global.AAA_RBAC;
    const s = ui.sheet({ title: 'Schedule ' + (job.customerName || 'job'), size: 'sm' });
    document.body.appendChild(s.overlay);

    if (rbac && !rbac.can('EDIT_JOB')) {
      s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Your role cannot edit the schedule.' }));
      return;
    }

    const dateIn = ui.el('input', { className: 'aaa-input', attrs: { type: 'date' } });
    dateIn.value = sched()._dayKey(job.scheduledDate) || '';
    const timeIn = ui.el('input', { className: 'aaa-input', attrs: { type: 'time' } });
    const sm = sched()._startMins(job);
    if (sm != null) timeIn.value = String(Math.floor(sm / 60)).padStart(2, '0') + ':' + String(sm % 60).padStart(2, '0');
    const durIn = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', min: '30', step: '30', placeholder: 'Duration (min)' } });
    durIn.value = sched()._duration(job);

    const members = await crew().list();
    const checks = members.map((m) => {
      const cb = ui.el('input', { attrs: { type: 'checkbox', value: m.id } });
      if (Array.isArray(job.assigneeIds) && job.assigneeIds.indexOf(m.id) !== -1) cb.checked = true;
      return { m: m, cb: cb, row: ui.el('label', { className: 'closure-check', style: { display: 'flex', gap: '0.5rem', alignItems: 'center' } }, [cb, ui.el('span', { text: m.name })]) };
    });

    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [
      ui.el('label', { className: 'aaa-field-label', text: 'Date' }), dateIn,
      ui.el('label', { className: 'aaa-field-label', text: 'Start time' }), timeIn,
      ui.el('label', { className: 'aaa-field-label', text: 'Duration (min)' }), durIn
    ]));
    s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Crew' }));
    if (!members.length) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No crew yet — add crew in Crew & Tools.' }));
    checks.forEach((c) => s.body.appendChild(c.row));

    const msg = ui.el('p', { className: 'aaa-empty', text: '' });
    s.body.appendChild(msg);

    s.body.appendChild(ui.button({ label: 'Save schedule', variant: 'primary', full: true, onClick: async () => {
      if (!dateIn.value) { msg.textContent = 'Pick a date.'; return; }
      const crewIds = checks.filter((c) => c.cb.checked).map((c) => c.m.id);
      const scheduledDate = timeIn.value ? (dateIn.value + 'T' + timeIn.value + ':00') : dateIn.value;
      const startMins = timeIn.value ? (Number(timeIn.value.slice(0, 2)) * 60 + Number(timeIn.value.slice(3, 5))) : null;
      const dur = Math.max(30, Number(durIn.value) || 120);
      const probe = { id: job.id, scheduledDate: scheduledDate, scheduledStartMins: startMins, durationMins: dur, assigneeIds: crewIds };

      // Pre-check conflicts (warn but allow — dispatcher may intend overlap).
      const wc = await sched().wouldConflict(probe, crewIds);
      if (wc.conflict && !msg._warned) {
        msg.textContent = '⚠️ Conflict with ' + (wc.with.customerName || 'another job') + ' (' + wc.crew.length + ' shared crew). Tap Save again to keep it.';
        msg._warned = true; return;
      }

      const patch = { scheduledDate: scheduledDate, scheduledStartMins: startMins, durationMins: dur, assigneeIds: crewIds,
        currentState: (job.currentState === 'QUOTE_OPEN' ? 'SCHEDULED' : job.currentState) };
      const gw = global.AAA_RUNTIME_GATEWAY;
      const mutate = async () => {
        const fresh = await data().get('jobs', job.id);
        const updated = Object.assign({}, fresh || job, patch);
        await data().put('jobs', job.id, updated);
        if (global.AAA_EVENTS) global.AAA_EVENTS.emit('job.updated', { jobId: job.id, scheduled: true });
        return updated;
      };
      const res = gw ? await gw.run({ action: 'EDIT_JOB', origin: 'human', target: { type: 'job', id: job.id }, detail: { scheduled: scheduledDate, crew: crewIds.length }, mutate: mutate }) : await mutate();
      if (res && res.ok === false) { msg.textContent = res.error === 'FORBIDDEN' ? 'Your role cannot edit jobs.' : ('Save failed: ' + res.error); return; }
      s.close(); await render();
    } }));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  global.AAA_SCHEDULE_UI = { open: open };
})(typeof window !== 'undefined' ? window : this);
