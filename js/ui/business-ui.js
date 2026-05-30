/*
 * AAA Business — owner overview tab.
 *
 * Real KPIs from shared memory: pipeline by state, close rate, customers,
 * upcoming schedule, marketing channel ROI, and review activity. No fabricated
 * numbers — empty states say so. Rendered inline into a container.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function data() { return global.AAA_DATA; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmt(v) { const d = new Date(v); return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }

  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: (value && value !== '0' && value !== '—') ? color : 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color, opacity: '0.85' } })
    ]);
  }
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  function row(html) { return U().el('div', { className: 'aaa-list-row', html: html }); }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    container.appendChild(ui.spinner('Loading business overview…'));

    const jobs = await data().listJobs();
    const customers = await data().listCustomers();
    const outcomes = await data().list('outcomes');
    container.innerHTML = '';

    const byState = (s) => jobs.filter((j) => (j.currentState || 'QUOTE_OPEN') === s).length;
    const won = outcomes.filter((o) => o.result === 'won').length;
    const lost = outcomes.filter((o) => o.result === 'lost').length;
    const closeRate = (won + lost) ? Math.round((won / (won + lost)) * 100) + '%' : '—';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(byState('IN_PROGRESS'), 'In Progress', '#F59E0B'),
      chip(byState('SCHEDULED'), 'Scheduled', '#3B82F6'),
      chip(byState('QUOTE_OPEN'), 'Open Quotes', '#94A3B8')
    ]));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(byState('CLOSED'), 'Closed', '#10B981'),
      chip(closeRate, 'Close Rate', '#DC2626'),
      chip(customers.length, 'Customers', '#A1A1AA')
    ]));

    // Upcoming schedule (real)
    container.appendChild(title('Upcoming Schedule'));
    const upcoming = jobs
      .filter((j) => j.scheduledDate && j.currentState !== 'CLOSED')
      .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate))
      .slice(0, 6);
    if (!upcoming.length) container.appendChild(empty('No scheduled jobs.'));
    upcoming.forEach((j) => container.appendChild(row(
      '<strong>' + esc(j.customerName || 'Job') + '</strong><div class="aaa-list-sub">🗓 ' + esc(fmt(j.scheduledDate)) +
      (j.serviceAddress ? ' · ' + esc(j.serviceAddress) : '') + '</div>')));

    // Marketing channels (real)
    if (global.AAA_MARKETING) {
      container.appendChild(title('Marketing — Channel ROI'));
      const ch = await global.AAA_MARKETING.channelStats();
      if (!ch.length) container.appendChild(empty('Add a lead source when creating customers to see channel ROI.'));
      ch.forEach((c) => container.appendChild(row(
        '<strong>' + esc(c.source) + '</strong><div class="aaa-list-sub">' + c.jobs + ' jobs · ' + c.customers +
        ' customers · close ' + (c.closeRate != null ? Math.round(c.closeRate * 100) + '%' : 'n/a') + '</div>')));
    }

    // Reviews (real)
    if (global.AAA_REVIEW_REQUEST_ENGINE) {
      container.appendChild(title('Reviews'));
      const reqs = await global.AAA_REVIEW_REQUEST_ENGINE.list();
      const sent = reqs.filter((r) => r.status === 'sent').length;
      container.appendChild(row('<strong>' + reqs.length + ' prepared</strong><div class="aaa-list-sub">' + sent + ' sent</div>'));
    }
  }

  global.AAA_BUSINESS = { render: render };
})(typeof window !== 'undefined' ? window : this);
