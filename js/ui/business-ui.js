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

    // RBAC: the Business tab exposes revenue, close rate, channel ROI and the
    // knowledge graph — owner-only financials. Crew/managers are stopped here
    // with an honest message rather than being shown the numbers.
    const rbac = global.AAA_RBAC;
    if (rbac && !rbac.can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>🔒 Financials are owner-only</strong>' +
        '<div class="aaa-list-sub">Signed in as ' + esc(rbac.label()) + '. Revenue, margins, and business analytics are restricted to the owner.</div>' }));
      return;
    }

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

    // Accounting / P&L (owner-only — this whole tab is already VIEW_FINANCIALS).
    if (global.AAA_ACCOUNTING) {
      const acct = await global.AAA_ACCOUNTING.summary();
      container.appendChild(title('Accounting — Profit & Loss'));
      container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
        chip('$' + acct.collected, 'Collected', '#10B981'),
        chip('$' + acct.expensed, 'Expenses', '#F59E0B'),
        chip('$' + acct.profit, 'Profit', acct.profit >= 0 ? '#10B981' : '#EF4444')
      ]));
      container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
        chip('$' + acct.billed, 'Billed', '#94A3B8'),
        chip('$' + acct.outstanding, 'Outstanding', '#DC2626'),
        chip(acct.marginPct != null ? acct.marginPct + '%' : '—', 'Margin', '#A1A1AA')
      ]));
      container.appendChild(ui.button({ label: 'Record expense', icon: '🧾', variant: 'secondary', full: true, onClick: () => expenseForm(container) }));
      container.appendChild(ui.button({ label: 'Record payment', icon: '💵', variant: 'secondary', full: true, onClick: () => paymentForm(container) }));
    }

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

    // Knowledge Graph (real — everything connected)
    if (global.AAA_GRAPH) {
      container.appendChild(title('Knowledge Graph'));
      const st = await global.AAA_GRAPH.stats();
      const ins = await global.AAA_GRAPH.insights();
      container.appendChild(row('<strong>' + st.nodeCount + ' nodes · ' + st.edgeCount + ' connections</strong>' +
        '<div class="aaa-list-sub">' + Object.keys(st.byType).map((t) => st.byType[t] + ' ' + t).join(' · ') + '</div>'));
      if (ins.bestSource) container.appendChild(row('🏆 Best lead source: <strong>' + esc(ins.bestSource.source) + '</strong><div class="aaa-list-sub">' + Math.round(ins.bestSource.rate * 100) + '% close (' + ins.bestSource.won + '/' + ins.bestSource.total + ')</div>'));
      if (ins.repeatCustomers) container.appendChild(row('🔁 Repeat customers<div class="aaa-list-sub">' + ins.repeatCustomers + ' with more than one job</div>'));
      if (ins.topAgent) container.appendChild(row('🤖 Top agent: <strong>' + esc(ins.topAgent.agent) + '</strong><div class="aaa-list-sub">avg accuracy ' + Math.round(ins.topAgent.avg * 100) + '% over ' + ins.topAgent.n + ' scored</div>'));
      if (ins.noEstimate || ins.noOutcome) container.appendChild(row('⚠️ Coverage gaps<div class="aaa-list-sub">' + ins.noEstimate + ' jobs without an estimate · ' + ins.noOutcome + ' without a recorded outcome</div>'));
      container.appendChild(ui.button({ label: 'Explore connections', icon: '🕸', variant: 'secondary', full: true, onClick: () => exploreGraph() }));
    }

    // Reviews (real)
    if (global.AAA_REVIEW_REQUEST_ENGINE) {
      container.appendChild(title('Reviews'));
      const reqs = await global.AAA_REVIEW_REQUEST_ENGINE.list();
      const sent = reqs.filter((r) => r.status === 'sent').length;
      container.appendChild(row('<strong>' + reqs.length + ' prepared</strong><div class="aaa-list-sub">' + sent + ' sent</div>'));
    }
  }

  // Expense entry — routed through the Runtime Gateway (MODIFY_ACCOUNTING),
  // so it's RBAC-checked (owner) and audited.
  function expenseForm(container) {
    const ui = U();
    const s = ui.sheet({ title: 'Record expense', size: 'sm' });
    document.body.appendChild(s.overlay);
    const cat = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Category (materials, fuel, labor…)' } });
    const desc = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Description' } });
    const amt = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '0.01', inputmode: 'decimal', placeholder: 'Amount ($)' } });
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [cat, desc, amt]));
    s.body.appendChild(ui.button({ label: 'Save expense', variant: 'primary', full: true, onClick: async () => {
      const amount = parseFloat(amt.value); if (!isFinite(amount) || amount <= 0) return;
      await gatedWrite('MODIFY_ACCOUNTING', () => global.AAA_ACCOUNTING.addExpense({ category: cat.value.trim(), description: desc.value.trim(), amount: amount }));
      s.close(); await render(container);
    } }));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  // Payment entry — routed through the gateway (APPROVE_PAYMENT).
  function paymentForm(container) {
    const ui = U();
    const s = ui.sheet({ title: 'Record payment', size: 'sm' });
    document.body.appendChild(s.overlay);
    const amt = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '0.01', inputmode: 'decimal', placeholder: 'Amount ($)' } });
    const method = ui.el('select', { className: 'aaa-input' }, ['cash', 'card', 'check', 'transfer'].map((m) => ui.el('option', { text: m, attrs: { value: m } })));
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [amt, method]));
    s.body.appendChild(ui.button({ label: 'Save payment', variant: 'primary', full: true, onClick: async () => {
      const amount = parseFloat(amt.value); if (!isFinite(amount) || amount <= 0) return;
      await gatedWrite('APPROVE_PAYMENT', () => global.AAA_ACCOUNTING.recordPayment({ amount: amount, method: method.value }));
      s.close(); await render(container);
    } }));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  async function gatedWrite(action, mutate) {
    const gw = global.AAA_RUNTIME_GATEWAY;
    if (!gw) return mutate();
    return gw.run({ action: action, origin: 'human', mutate: mutate });
  }

  // Customer-centric graph explorer: pick a customer → see everything linked.
  async function exploreGraph() {
    const ui = U();
    const s = ui.sheet({ title: 'Knowledge Graph', subtitle: 'Tap a customer to see everything connected' });
    document.body.appendChild(s.overlay);
    const customers = await data().listCustomers();
    if (!customers.length) { s.body.appendChild(empty('No customers yet.')); return; }
    customers.forEach((c) => {
      const r = ui.el('button', { className: 'aaa-card', attrs: { type: 'button' } }, [
        ui.el('span', { className: 'aaa-card-name', text: c.name || 'Customer' }),
        c.source ? ui.el('span', { className: 'aaa-card-sub', text: 'source: ' + c.source }) : null
      ]);
      r.addEventListener('click', () => showNode('cust:' + c.id, s.body));
      s.body.appendChild(r);
    });
  }

  async function showNode(id, container) {
    const ui = U();
    container.innerHTML = '';
    container.appendChild(ui.spinner('Tracing connections…'));
    const res = await global.AAA_GRAPH.node(id);
    container.innerHTML = '';
    if (!res) { container.appendChild(empty('Node not found.')); return; }
    container.appendChild(ui.el('h2', { className: 'aaa-section-title', text: res.node.label + ' · ' + res.node.type }));
    const relLabel = { has_job: 'Jobs', has_estimate: 'Estimates', has_outcome: 'Outcomes', has_review: 'Reviews', from_source: 'Lead source', about_job: 'Jobs', by_agent: 'Agent' };
    const keys = Object.keys(res.groups);
    if (!keys.length) container.appendChild(empty('No connections yet.'));
    keys.forEach((rel) => {
      container.appendChild(ui.el('h2', { className: 'aaa-section-title', text: relLabel[rel] || rel }));
      res.groups[rel].forEach((nb) => {
        const r = ui.el('button', { className: 'aaa-list-row', attrs: { type: 'button', style: 'width:100%;text-align:left;cursor:pointer' }, html: '<strong>' + esc(nb.label) + '</strong><div class="aaa-list-sub">' + nb.type + '</div>' });
        r.addEventListener('click', () => showNode(nb.id, container));
        container.appendChild(r);
      });
    });
  }

  global.AAA_BUSINESS = { render: render };

})(typeof window !== 'undefined' ? window : this);
